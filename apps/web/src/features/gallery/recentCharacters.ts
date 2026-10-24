import type { Character } from '@emaki/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 角色选择器里「最近使用」的角色。整理图片时往往连着归同一两个角色，
 * 所以把最近选过的放在最上面，存快照（名字 / 封面）即可，不必再请求。
 */
interface RecentCharactersState {
  items: Character[];
  push: (c: Character) => void;
  remove: (id: string) => void;
  /** 改名等之后更新快照，位置不变；不在列表里就不管 */
  patch: (c: Partial<Character> & { id: string }) => void;
}

const MAX = 5;

/** 最近使用的快照换成手上更新的数据（改过名、换过作品），没有就用快照 */
export function freshRecents(items: Character[], fresh: (id: string) => Character | undefined): Character[] {
  return items.map((c) => fresh(c.id) ?? c);
}

/**
 * 读回来的条目要是完整的 Character：0.1.4 以前这里和命令面板的「最近访问」共用一个 key，
 * 那边存的是精简快照（没有 workIds），混进来会让选择器读 workIds[0] 时报错
 */
export function keepFullCharacters(raw: unknown): Character[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Character => {
      const o = v as Record<string, unknown> | null;
      return !!o && typeof o.id === 'string' && typeof o.name === 'string' && Array.isArray(o.workIds) && Array.isArray(o.aliases);
    })
    .slice(0, MAX);
}

export const useRecentCharacters = create<RecentCharactersState>()(
  persist(
    (set) => ({
      items: [],
      push: (c) => set((s) => ({ items: [c, ...s.items.filter((x) => x.id !== c.id)].slice(0, MAX) })),
      remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
      patch: (c) => set((s) => (s.items.some((x) => x.id === c.id) ? { items: s.items.map((x) => (x.id === c.id ? { ...x, ...c } : x)) } : s)),
    }),
    {
      // emaki.recent-characters 是命令面板的（palette/recent.ts），不能共用
      name: 'emaki.picker-recent-characters',
      partialize: (s) => ({ items: s.items }),
      merge: (persisted, current) => ({ ...current, items: keepFullCharacters((persisted as { items?: unknown } | undefined)?.items) }),
    },
  ),
);
