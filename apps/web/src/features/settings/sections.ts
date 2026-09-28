/** 设置页的分组：顺序即目录顺序，编号由此推出。 */
export const SECTIONS = [
  { id: 'library', title: '图库文件夹' },
  { id: 'tagger', title: '识别' },
  { id: 'danbooru', title: 'Danbooru' },
  { id: 'dedupe', title: '查重' },
  { id: 'appearance', title: '外观' },
  { id: 'jobs', title: '后台任务' },
  { id: 'about', title: '关于' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

// DOM id 加前缀，避免和别处的 id 撞车；URL 里的 hash 仍用短名（/settings#library）
export const sectionDomId = (id: SectionId) => `settings-${id}`;

export const isSectionId = (v: string): v is SectionId => SECTIONS.some((s) => s.id === v);

export const sectionNumber = (index: number) => String(index + 1).padStart(2, '0');
