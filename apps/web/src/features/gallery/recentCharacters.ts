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
}

const MAX = 5;

export const useRecentCharacters = create<RecentCharactersState>()(
  persist(
    (set) => ({
      items: [],
      push: (c) => set((s) => ({ items: [c, ...s.items.filter((x) => x.id !== c.id)].slice(0, MAX) })),
      remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
    }),
    { name: 'emaki.recent-characters' },
  ),
);
