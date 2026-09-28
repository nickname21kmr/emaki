import type { Character, FocusPoint, ID, Rating } from '@emaki/shared';
import { useEffect } from 'react';
import { useMatch } from 'react-router';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCharacter } from '@/lib/queries';

/**
 * 「最近访问的角色」：命令面板输入为空时显示。
 * 存一份快照（名字、封面、作品名），打开面板时不用再逐个请求。
 */
export interface RecentCharacter {
  id: ID;
  name: string;
  workName: string | null;
  coverImageId: ID | null;
  coverFocus: FocusPoint | null;
  /** 旧快照里没有这个字段 */
  coverRating?: Rating;
  imageCount: number;
}

const MAX_RECENT = 8;

interface RecentState {
  items: RecentCharacter[];
  push: (c: RecentCharacter) => void;
}

export const useRecentCharacters = create<RecentState>()(
  persist(
    (set) => ({
      items: [],
      push: (c) => set((s) => ({ items: [c, ...s.items.filter((x) => x.id !== c.id)].slice(0, MAX_RECENT) })),
    }),
    {
      name: 'emaki.recent-characters',
      partialize: (s) => ({ items: s.items }),
      // localStorage 可能被手动改坏，读回来时过滤掉不完整的条目
      merge: (persisted, current) => {
        const raw = (persisted as { items?: unknown } | undefined)?.items;
        const items = Array.isArray(raw) ? raw.filter(isRecent).slice(0, MAX_RECENT) : [];
        return { ...current, items };
      },
    },
  ),
);

function isRecent(v: unknown): v is RecentCharacter {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.imageCount === 'number';
}

export function toRecent(character: Character, workName: string | null): RecentCharacter {
  return {
    id: character.id,
    name: character.name,
    workName,
    coverImageId: character.coverImageId,
    coverFocus: character.coverFocus,
    coverRating: character.coverRating,
    imageCount: character.imageCount,
  };
}

/**
 * 不管从哪里进的角色详情页（书架、排行、命令面板），都记一笔。
 * 和详情页用同一个 query key，不会多发请求。
 */
export function useTrackRecentCharacters() {
  const id = useMatch('/characters/:id')?.params.id;
  const { data } = useCharacter(id);

  useEffect(() => {
    if (!data || data.character.id !== id) return;
    useRecentCharacters.getState().push(toRecent(data.character, data.works[0]?.name ?? null));
  }, [data, id]);
}
