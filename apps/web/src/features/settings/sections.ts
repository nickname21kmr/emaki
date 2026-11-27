import { useAllowed, type Need } from '@/lib/capabilities';

/**
 * 设置页的分组：顺序即目录顺序，编号按这台设备看得到的那些排（useSettingsSections）。
 * 每节声明需要的能力（lib/capabilities.ts），没有的整节不显示：手机访问要 devices、AI 助手要 assistant、姿势检索（实验，读本机文件夹）要 desktop（这三项手机上永远没有），
 * 后台任务要 jobs，图库文件夹、识别、Danbooru、查重读改的都是图库设置（settings）；外观里的主题存在图库设置里（整页本来就要 settings），
 * 其余是本机偏好，关于只读，都不要额外的能力。
 */
export const SECTIONS = [
  { id: 'library', title: '图库文件夹', need: 'settings' },
  { id: 'tagger', title: '识别', need: 'settings' },
  { id: 'danbooru', title: 'Danbooru', need: 'settings' },
  { id: 'dedupe', title: '查重', need: 'settings' },
  { id: 'appearance', title: '外观', need: null },
  { id: 'jobs', title: '后台任务', need: 'jobs' },
  { id: 'phone', title: '手机访问', need: 'devices' },
  { id: 'assistant', title: 'AI 助手 · 实验', need: 'assistant' },
  { id: 'pose', title: '姿势检索 · 实验', need: 'desktop' },
  // 插件（docs/plugins.md 9.7）：只放「插件」页在不在侧栏、去插件页；谁都能看，开关要 plugins
  { id: 'plugins', title: '插件', need: null },
  { id: 'about', title: '关于', need: null },
] as const satisfies readonly { id: string; title: string; need: Need }[];

export type SectionId = (typeof SECTIONS)[number]['id'];
export type SectionDef = (typeof SECTIONS)[number];

/** 这台设备看得到的分组（按顺序）；目录、编号、滚动定位都用它 */
export const useSettingsSections = (): readonly SectionDef[] => useAllowed(SECTIONS);

// DOM id 加前缀，避免和别处的 id 撞车；URL 里的 hash 仍用短名（/settings#library）
export const sectionDomId = (id: SectionId) => `settings-${id}`;

export const isSectionId = (v: string): v is SectionId => SECTIONS.some((s) => s.id === v);

export const sectionNumber = (index: number) => String(index + 1).padStart(2, '0');
