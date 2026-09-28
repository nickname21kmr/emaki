import type { CharacterSuggestion, ID, Rating } from '@emaki/shared';

/** 「归到哪个角色」的目标：来自搜索结果或本次会话里用过的角色 */
export interface AssignTarget {
  id: ID;
  name: string;
  workName: string | null;
  coverImageId: ID | null;
  /** 封面分级：开着模糊时头像跟着糊 */
  coverRating?: Rating;
  imageCount?: number;
}

/** 多选时把各张图的建议合并起来：同一个 tag 出现在几张图里 */
export interface AggregatedSuggestion extends CharacterSuggestion {
  /** 选中的图里有几张给出了这条建议 */
  hits: number;
}

/** 采纳 / 排除后在预览上盖一下的「印」 */
export interface StampEvent {
  key: number;
  glyph: string;
  label: string;
  tone: 'shu' | 'muted';
}

/** 切换图片的方向，决定预览滑入的方向 */
export type Direction = 1 | -1;
