import { JOB_LABEL, matchesQuery, NAV_SECTIONS, type MutationResult, type NavEntry, type NavSection, type Settings, type ThemePreference } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  CircleHelp,
  Eye,
  EyeOff,
  FolderSync,
  Keyboard,
  Monitor,
  Moon,
  ScanFace,
  ScanSearch,
  Sun,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { allowed, useCapabilities, type Need } from '@/lib/capabilities';
import { formatCount } from '@/lib/format';
import { qk, requestUndo, undoTitle, useMutate, useSettings, useStartJob, useSummary } from '@/lib/queries';
import { placeText } from '@/lib/undoPlace';
import { useOverlays, usePrefs, useUndoStore } from '@/lib/stores';
import { navIcon } from '@/components/layout/Sidebar';
import { useNav } from '@/lib/plugins';
import { pageNeed, useCanVisit } from '@/pages';
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
  /** 需要的能力（lib/capabilities.ts）：没有的不列出来。前往某页的取那一页声明的（src/pages.ts） */
  need: Need;
  run: () => void;
}

const THEME_MESSAGE: Record<ThemePreference, string> = {
  light: '已切换到浅色主题',
  dark: '已切换到深色主题',
  system: '主题已改为跟随系统',
};

// startJob / updateSettings 不返回 MutationResult，包一层好走 useMutate 的 toast + 刷新
const done = (message: string): MutationResult => ({ ok: true, message, undoToken: null });

/**
 * 命令面板里的命令：前往各页面 + 常用操作。这台设备用不了的不列出来（每条声明 need，在最后统一过滤）。
 * close 在每条命令执行前调用——面板关掉后 mutation 仍会跑完（回调挂在 mutation 上）。
 */
export function usePaletteCommands(close: () => void): PaletteCommand[] {
  const { caps } = useCapabilities();
  const navigate = useNavigate();
  const client = useQueryClient();
  const blur = usePrefs((s) => s.blurSensitive);
  const lastUndo = useUndoStore((s) => s.entries[0]);
  const setHelpOpen = useOverlays((s) => s.setHelpOpen);
  const { data: settings } = useSettings();
  // 计数读汇总接口（附录 #28）
  const { data: summary } = useSummary();
  const nav = useNav();
  const canVisit = useCanVisit();

  const startJob = useStartJob((job) => {
    const label = JOB_LABEL[job.kind];
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
  }, { undo: false }); // 换主题只是外观，不占撤销栈

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

  // 前往：侧栏的导航项（插件的 nav.item，docs/plugins.md 9.6）——停用的页面不列，改的名字跟着变，不在侧栏里的页面（「插件」）也能从这里去
  const goItems: PaletteCommand[] = paletteGoItems(nav, canVisit).map((n) => ({
    value: `go:${n.to}`,
    section: 'go' as const,
    label: n.label,
    keywords: NAV_KEYWORDS[n.to] ?? [],
    icon: navIcon(n.icon),
    ...(n.key && { keys: [n.key] }),
    need: pageNeed(n.to),
    run: go(n.to),
  }));

  const actions: PaletteCommand[] = [
    {
      value: 'act:blur',
      section: 'act',
      label: blur ? '显示敏感图片' : '模糊敏感图片',
      keywords: ['blur', 'nsfw', 'sensitive', '模糊', '敏感', 'mohu', 'mh'],
      icon: blur ? Eye : EyeOff,
      keys: GLOBAL_KEYS.blur,
      // 本机偏好
      need: null,
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
      // 主题存在图库设置里（settings.update）
      need: 'settings',
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
            need: 'settings' as const,
            run: act(() => applyTheme('system')),
          },
        ]
      : []),
    {
      value: 'act:tag',
      section: 'act',
      label: '运行识别',
      // 识别处理的是待识别的图（以前写的是含待识别的未识别总数「待确认」，和侧栏对不上）
      meta: summary?.triage.waiting ? `${formatCount(summary.triage.waiting)} 张待识别` : undefined,
      keywords: ['tag', 'tagger', 'recognize', '识别', '打标', 'shibie', 'sb'],
      icon: ScanFace,
      need: 'jobs',
      run: act(() => startJob.mutate('tag')),
    },
    {
      value: 'act:dedupe',
      section: 'act',
      label: '查找重复',
      meta: summary?.duplicates ? `已有 ${formatCount(summary.duplicates)} 组` : undefined,
      keywords: ['dedupe', 'duplicate', '重复', '查重', 'chongfu', 'cf'],
      icon: ScanSearch,
      need: 'jobs',
      run: act(() => startJob.mutate('dedupe')),
    },
    {
      value: 'act:scan',
      section: 'act',
      label: '扫描图库文件夹',
      keywords: ['scan', 'rescan', 'refresh', '扫描', '刷新', 'saomiao', 'sm'],
      icon: FolderSync,
      need: 'jobs',
      run: act(() => startJob.mutate('scan')),
    },
    ...(lastUndo
      ? [
          {
            value: 'act:undo',
            section: 'act' as const,
            label: undoTitle(lastUndo) + placeText(lastUndo),
            keywords: ['undo', '撤销', 'chexiao', 'cx'],
            icon: Undo2,
            keys: GLOBAL_KEYS.undo,
            need: 'history' as const,
            // 别的页面的、太久以前的先问一声（和 Ctrl+Z 一样）
            run: act(() => void requestUndo(client)),
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
      need: null,
      run: act(() => setHelpOpen(true)),
    },
  ];

  return allowed([...goItems, ...actions], caps);
}

/** 命令面板里原来的顺序（数字键跳页的在前）；插件加的、原来没有的排在后面，按侧栏的顺序 */
const PALETTE_ORDER = ['home', 'gallery', 'characters', 'unrecognized', 'duplicates', 'annex', 'collections', 'excluded', 'settings'];

/**
 * 命令面板的「前往」（纯函数，测试直接调）：全部导航项（在不在侧栏都算），去不了的（没权限、插件停用了）不要，
 * 「原创」这种要按图库情况填地址的捷径不要；数字键跳页的标上键。
 */
export function paletteGoItems(
  nav: Record<NavSection, NavEntry[]>,
  canVisit: (to: string) => boolean,
): (NavEntry & { key?: string })[] {
  const all = NAV_SECTIONS.flatMap((s) => nav[s]).filter((n) => !n.to.includes(':') && canVisit(n.to));
  const rank = (n: NavEntry) => {
    const i = PALETTE_ORDER.indexOf(n.id);
    return i < 0 ? PALETTE_ORDER.length : i;
  };
  return all
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
    .map(({ n }) => ({ ...n, ...(PAGE_JUMPS.find((p) => p.to === n.to) && { key: PAGE_JUMPS.find((p) => p.to === n.to)!.key }) }));
}

/** 本地过滤命令：标签或任一关键词包含输入即可（共用的 matchesQuery） */
export function matchCommand(cmd: PaletteCommand, query: string): boolean {
  return matchesQuery(query, [cmd.label, ...cmd.keywords]);
}

const NAV_KEYWORDS: Record<string, string[]> = {
  '/': ['home', '首页', '主页', 'shouye', 'sy'],
  '/gallery': ['gallery', 'images', '图库', '插画', 'tuku', 'tk'],
  '/characters': ['characters', '角色', 'juese', 'js'],
  '/unrecognized': ['unrecognized', 'inbox', '未识别', '待确认', 'weishibie', 'wsb'],
  '/duplicates': ['duplicates', '重复', 'chongfu', 'cf'],
  '/collections': ['collections', 'heji', '本子', '画集', 'doujin', 'artbook'],
  '/excluded': ['excluded', '排除', '已排除', 'paichu', 'pc'],
  '/settings': ['settings', 'preferences', '设置', 'shezhi', 'sz'],
};
