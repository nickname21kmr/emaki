import { modKeyLabel } from '@/lib/hotkeys';

/**
 * 快捷键清单：帮助面板和命令面板共用，改快捷键时这里同步改。
 * 全局那几个必须和 components/layout/useGlobalHotkeys.ts 保持一致；
 * 页面级的来自 docs/FRONTEND.md 各页面的规格。
 */

/** 一个组合里需要同时按下的键帽，例如 ['Ctrl', 'K'] */
export type KeyCombo = string[];

export interface ShortcutItem {
  label: string;
  /** 多个备选组合，任选其一：[['Ctrl', 'K'], ['/']] */
  keys: KeyCombo[];
}

export type ShortcutGroupId = 'global' | 'gallery' | 'lightbox' | 'unrecognized' | 'duplicates' | 'reader';

export interface ShortcutGroup {
  id: ShortcutGroupId;
  title: string;
  /** 标题旁的一句话：在哪里生效 */
  hint: string;
  items: ShortcutItem[];
}

const MOD = modKeyLabel;

/** 数字键跳页（useGlobalHotkeys 里的 1–6） */
export const PAGE_JUMPS = [
  { key: '1', label: '首页', to: '/' },
  { key: '2', label: '图库', to: '/gallery' },
  { key: '3', label: '角色', to: '/characters' },
  { key: '4', label: '未识别', to: '/unrecognized' },
  { key: '5', label: '重复', to: '/duplicates' },
  { key: '6', label: '别册', to: '/annex' },
] as const;

/** 命令面板里给命令标注快捷键时用，避免两处各写一份 */
export const GLOBAL_KEYS = {
  palette: [MOD, 'K'],
  help: ['?'],
  undo: [MOD, 'Z'],
  blur: ['B'],
} satisfies Record<string, KeyCombo>;

export const SHORTCUT_GROUPS: Record<ShortcutGroupId, ShortcutGroup> = {
  global: {
    id: 'global',
    title: '全局',
    hint: '任何页面',
    items: [
      { label: '打开命令面板', keys: [GLOBAL_KEYS.palette, ['/']] },
      { label: '快捷键与帮助', keys: [GLOBAL_KEYS.help] },
      { label: '撤销上一步', keys: [GLOBAL_KEYS.undo] },
      { label: '模糊 / 显示敏感图片', keys: [GLOBAL_KEYS.blur] },
    ],
  },
  gallery: {
    id: 'gallery',
    title: '图库',
    hint: '多选图片时',
    items: [
      { label: '全选已加载的图片', keys: [[MOD, 'A']] },
      { label: '收藏选中', keys: [['F']] },
      { label: '排除选中', keys: [['E']] },
      { label: '归入…（改类型，再按 1–7）', keys: [['C']] },
      { label: '取消选择', keys: [['Esc']] },
    ],
  },
  lightbox: {
    id: 'lightbox',
    title: '看图器',
    hint: '点开任意一张图',
    items: [
      { label: '上一张 / 下一张', keys: [['←'], ['→']] },
      { label: '信息面板', keys: [['I']] },
      { label: '收藏', keys: [['F']] },
      { label: '排除', keys: [['E']] },
      { label: '归入…（改类型，再按 1–7）', keys: [['C']] },
      { label: '放大', keys: [['双击'], ['滚轮']] },
      { label: '放映时暂停 / 继续', keys: [['Space']] },
      { label: '关闭', keys: [['Esc']] },
    ],
  },
  unrecognized: {
    id: 'unrecognized',
    title: '未识别',
    hint: '逐张确认角色',
    items: [
      { label: '采纳第 1–3 条建议', keys: [['1'], ['2'], ['3']] },
      { label: '搜索其他角色', keys: [['/']] },
      { label: '跳过', keys: [['→'], ['J']] },
      { label: '上一张', keys: [['←'], ['K']] },
      { label: '排除这张', keys: [['E']] },
      { label: '不是插画（标为截图、漫画等）', keys: [['N']] },
      { label: '选中同建议的图', keys: [['A']] },
      { label: '全选这一组已加载的图', keys: [[MOD, 'A']] },
      { label: '放下选中（不再出现在未识别）', keys: [['H']] },
      { label: '改类型', keys: [['C']] },
      { label: '设分级', keys: [['R']] },
      { label: '上一组 / 下一组', keys: [['['], [']']] },
    ],
  },
  duplicates: {
    id: 'duplicates',
    title: '重复',
    hint: '逐组处理',
    items: [
      { label: '下一组 / 上一组', keys: [['J'], ['K']] },
      { label: '按推荐处理当前组', keys: [['Enter']] },
      { label: '放大对比（相似组，组内同步）', keys: [['Z']] },
    ],
  },
  reader: {
    id: 'reader',
    title: '阅读器',
    hint: '合集',
    items: [
      { label: '翻页（右开时方向相反）', keys: [['←'], ['→']] },
      { label: '下一页 / 上一页', keys: [['空格'], ['Shift', '空格']] },
      { label: '第一页 / 最后一页', keys: [['Home'], ['End']] },
      { label: '单页 / 双页', keys: [['D']] },
      { label: '右开 / 左开', keys: [['R']] },
      { label: '在看图器里打开当前页', keys: [['I']] },
      { label: '回到扉页', keys: [['Esc']] },
    ],
  },
};
