import type { Character, ID, Work } from '@emaki/shared';
import { useMemo } from 'react';
import { useWorks } from '@/lib/queries';

const EMPTY: Work[] = [];

/** 作品列表（按张数）+ id 索引。chip 行、书架分组、弹窗都用同一份缓存。 */
export function useWorkIndex() {
  const query = useWorks({ sort: 'imageCount' });
  const works = query.data ?? EMPTY;
  const byId = useMemo(() => new Map(works.map((w) => [w.id, w])), [works]);
  return { works, byId, isLoading: query.isLoading, isError: query.isError, error: query.error, refetch: query.refetch };
}

export type WorkIndex = Map<ID, Work>;

/** 角色的主作品名（workIds 第一个） */
export function primaryWorkName(c: Character, byId: WorkIndex): string | null {
  const id = c.workIds[0];
  return id ? (byId.get(id)?.name ?? null) : null;
}

/** 作品封面的小头像地址 */
/** 作品的圆头像：封面图 + 分级 + 主色（给 ChipAvatar） */
export const workAvatar = (w: Work) => (w.coverImageId ? { id: w.coverImageId, rating: w.coverRating, color: w.coverColor } : null);
