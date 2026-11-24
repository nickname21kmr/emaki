import type { CollectionPage } from '@emaki/shared';
import { readerSpreadFits, type Viewport } from '@/lib/viewport';
import { buildSpreads } from './spreads';

type Page = Pick<CollectionPage, 'pageNo' | 'width' | 'height'>;

/**
 * 阅读器的阅读方式（docs/plugins.md 9.2 的 reader.mode，E3）：每种方式把页排成一「开」一「开」，并说明这个窗口能不能用。
 * 现在是单页、双页两种（D 键在两者之间切，按合集类型记住，lib/stores.ts 的 readerSpread）；
 * 以后插件加的方式（比如条漫的竖向滚动）也登记在这里，阅读器按 id 找，不在 BookReader 里加分支。
 */
export interface ReaderMode {
  readonly id: string;
  readonly label: string;
  /** 页 → 每一开的页码 */
  layout(pages: Page[]): number[][];
  /** 这个窗口能不能用（双页要横屏、够宽） */
  fits(viewport: Viewport): boolean;
}

export const READER_MODES = [
  { id: 'single', label: '单页', layout: (pages: Page[]) => buildSpreads(pages, false), fits: () => true },
  { id: 'spread', label: '双页', layout: (pages: Page[]) => buildSpreads(pages, true), fits: readerSpreadFits },
] as const satisfies readonly ReaderMode[];

export type ReaderModeId = (typeof READER_MODES)[number]['id'];

/** 想用的方式在这个窗口用不了时退回单页 */
export function readerMode(want: ReaderModeId, viewport: Viewport): ReaderMode {
  const m = READER_MODES.find((x) => x.id === want) ?? READER_MODES[0];
  return m.fits(viewport) ? m : READER_MODES[0];
}
