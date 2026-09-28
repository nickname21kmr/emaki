import type { JobKind, MutationResult, Settings, ThemePreference } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CircleHelp,
  Copy,
  Eye,
  EyeOff,
  FolderSync,
  House,
  Images,
  Keyboard,
  Monitor,
  Moon,
  ScanFace,
  ScanSearch,
  Settings as SettingsIcon,
  Sun,
  Undo2,
  UsersRound,
  LibraryBig,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { qk, undo, useMutate, useSettings, useStartJob, useStats } from '@/lib/queries';
import { useOverlays, usePrefs, useUndoStore } from '@/lib/stores';
import { GLOBAL_KEYS, PAGE_JUMPS, type KeyCombo } from '../shortcuts';

export interface PaletteCommand {
  /** cmdk 的 value，必须唯一：go:/gallery、act:blur… */
  value: string;
  section: 'go' | 'act';
  label: string;
  /** 右侧的灰字补充（例如「702 张待确认」） */
  meta?: string;
  /** 本地过滤用：英文、拼音、同义词 */
  keywords: string[];
  icon: LucideIcon;
  keys?: KeyCombo;
  run: () => void;
}

const JOB_LABEL: Partial<Record<JobKind, string>> = {
  tag: '识别',
  dedupe: '查找重复',
  scan: '扫描图库',
};

const THEME_MESSAGE: Record<ThemePreference, string> = {
  light: '已切换到浅色主题',
  dark: '已切换到深色主题',
  system: '主题已改为跟随系统',
};

// startJob / updateSettings 不返回 MutationResult，包一层好走 useMutate 的 toast + 刷新
const done = (message: string): MutationResult => ({ ok: true, message, undoToken: null });

/**
 * 命令面板里的命令：前往各页面 + 常用操作。
 * close 在每条命令执行前调用——面板关掉后 mutation 仍会跑完（回调挂在 mutation 上）。
 */
export function usePaletteCommands(close: () => void): PaletteCommand[] {
  const navigate = useNavigate();
  const client = useQueryClient();
  const blur = usePrefs((s) => s.blurSensitive);
  const lastUndo = useUndoStore((s) => s.entries[0]);
  const setHelpOpen = useOverlays((s) => s.setHelpOpen);
  const { data: settings } = useSettings();
  const { data: stats } = useStats();

  const startJob = useStartJob((job) => {
    const label = JOB_LABEL[job.kind] ?? '任务';
    return job.status === 'queued' ? `${label}已加入任务队列` : `已开始${label}`;
  });

  const setTheme = useMutate(async (theme: ThemePreference) => {
    try {
      await api.updateSettings({ ui: { theme } });
    } catch (err) {
      // 乐观写入失败：重新拉设置，把主题换回去（面板此时已卸载，只能在 mutationFn 里做）
      void client.invalidateQueries({ queryKey: qk.settings });
      throw err;
    }
    return done(THEME_MESSAGE[theme]);
  });

  const applyTheme = (theme: ThemePreference) => {
    // 先乐观写入缓存，ThemeSync 立刻换肤，不用等请求回来
    client.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, ui: { ...s.ui, theme } } : s));
    setTheme.mutate(theme);
  };

  // 面板每次打开都会重新挂载，这里直接读当前生效的主题即可
  const isDark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  const themePref = settings?.ui.theme ?? 'system';

  const go = (to: string) => () => {
    close();
    navigate(to);
  };
  const act = (fn: () => void) => () => {
    close();
    fn();
  };

  const nav: PaletteCommand[] = [
    ...PAGE_JUMPS.map((p) => ({
      value: `go:${p.to}`,
      section: 'go' as const,
      label: p.label,
      keywords: NAV_KEYWORDS[p.to] ?? [],
      icon: NAV_ICON[p.to] ?? House,
      keys: [p.key],
      run: go(p.to),
    })),
    { value: 'go:/collections', section: 'go', label: '合集', keywords: ['collections', 'heji', '本子', '画集', 'doujin', 'artbook'], icon: LibraryBig, run: go('/collections') },
    { value: 'go:/excluded', section: 'go', label: '已排除', keywords: NAV_KEYWORDS['/excluded'] ?? [], icon: Ban, run: go('/excluded') },
    { value: 'go:/settings', section: 'go', label: '设置', keywords: NAV_KEYWORDS['/settings'] ?? [], icon: SettingsIcon, run: go('/settings') },
  ];

  const actions: PaletteCommand[] = [
    {
      value: 'act:blur',
      section: 'act',
      label: blur ? '显示敏感图片' : '模糊敏感图片',
      keywords: ['blur', 'nsfw', 'sensitive', '模糊', '敏感', 'mohu', 'mh'],
      icon: blur ? Eye : EyeOff,
      keys: GLOBAL_KEYS.blur,
      run: act(() => {
        usePrefs.getState().toggleBlurSensitive();
        toast(blur ? '已显示敏感图片' : '已模糊敏感图片');
      }),
    },
    {
      value: 'act:theme',
      section: 'act',
      label: isDark ? '切换到浅色主题' : '切换到深色主题',
      keywords: ['theme', 'dark', 'light', '主题', '深色', '浅色', '暗色', 'zhuti', 'zt'],
      icon: isDark ? Sun : Moon,
      run: act(() => applyTheme(isDark ? 'light' : 'dark')),
    },
    ...(themePref !== 'system'
      ? [
          {
            value: 'act:theme-system',
            section: 'act' as const,
            label: '主题跟随系统',
            keywords: ['theme', 'system', 'auto', '主题', '系统', '自动', 'zhuti'],
            icon: Monitor,
            run: act(() => applyTheme('system')),
          },
        ]
      : []),
    {
      value: 'act:tag',
      section: 'act',
      label: '运行识别',
      meta: stats?.unrecognizedCount ? `${formatCount(stats.unrecognizedCount)} 张待确认` : undefined,
      keywords: ['tag', 'tagger', 'recognize', '识别', '打标', 'shibie', 'sb'],
      icon: ScanFace,
      run: act(() => startJob.mutate('tag')),
    },
    {
      value: 'act:dedupe',
      section: 'act',
      label: '查找重复',
      meta: stats?.duplicateGroupCount ? `已有 ${formatCount(stats.duplicateGroupCount)} 组` : undefined,
      keywords: ['dedupe', 'duplicate', '重复', '查重', 'chongfu', 'cf'],
      icon: ScanSearch,
      run: act(() => startJob.mutate('dedupe')),
    },
    {
      value: 'act:scan',
      section: 'act',
      label: '扫描图库文件夹',
      keywords: ['scan', 'rescan', 'refresh', '扫描', '刷新', 'saomiao', 'sm'],
      icon: FolderSync,
      run: act(() => startJob.mutate('scan')),
    },
    ...(lastUndo
      ? [
          {
            value: 'act:undo',
            section: 'act' as const,
            label: `撤销：${lastUndo.label}`,
            keywords: ['undo', '撤销', 'chexiao', 'cx'],
            icon: Undo2,
            keys: GLOBAL_KEYS.undo,
            run: act(() => void undo(lastUndo.token, client)),
          },
        ]
      : []),
    {
      value: 'act:help',
      section: 'act',
      label: '快捷键与帮助',
      keywords: ['help', 'shortcut', 'keyboard', '帮助', '快捷键', 'bangzhu', 'kjj'],
      icon: Keyboard,
      keys: GLOBAL_KEYS.help,
      run: act(() => setHelpOpen(true)),
    },
  ];

  return [...nav, ...actions];
}

/** 本地过滤命令：标签或任一关键词包含输入即可 */
export function matchCommand(cmd: PaletteCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [cmd.label, ...cmd.keywords].some((s) => s.toLowerCase().includes(q));
}

// 和侧边栏同一套图标，用户一眼能对上
const NAV_ICON: Record<string, LucideIcon> = {
  '/': House,
  '/gallery': Images,
  '/characters': UsersRound,
  '/unrecognized': CircleHelp,
  '/duplicates': Copy,
};

const NAV_KEYWORDS: Record<string, string[]> = {
  '/': ['home', '首页', '主页', 'shouye', 'sy'],
  '/gallery': ['gallery', 'images', '图库', '插画', 'tuku', 'tk'],
  '/characters': ['characters', '角色', 'juese', 'js'],
  '/unrecognized': ['unrecognized', 'inbox', '未识别', '待确认', 'weishibie', 'wsb'],
  '/duplicates': ['duplicates', '重复', 'chongfu', 'cf'],
  '/excluded': ['excluded', '排除', '已排除', 'paichu', 'pc'],
  '/settings': ['settings', 'preferences', '设置', 'shezhi', 'sz'],
};
