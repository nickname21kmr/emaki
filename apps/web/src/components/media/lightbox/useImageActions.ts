import type { BulkImageAction, ContentKind, ID, Rating } from '@emaki/shared';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAllowedActions, type Need } from '@/lib/capabilities';
import { errorMessage, patchImages, useMutate } from '@/lib/queries';
import { useLightbox, useUndoStore } from '@/lib/stores';
import { canLeave, pendingOn } from './actionGuards';

/** 看图器里对「当前这张」的所有修改。快捷键和信息面板共用，保证行为一致。 */
export interface CurrentImage {
  id: ID;
  favorite: boolean;
  /** 归为原创了 */
  original: boolean;
  rating: Rating;
  kind?: ContentKind;
  characterIds: ID[];
}

/**
 * 看图器里每个操作需要的能力（docs/mobile.md 4.4，lib/capabilities.ts）：按它实际调的命令定。
 * 信息面板的按钮、快捷键、各栏的编辑入口都按 allow 显示，手机上默认没有「定位」（desktop）和「回收站」（organize-files）
 */
export const IMAGE_ACTION_NEEDS = {
  favorite: 'curate',
  original: 'curate',
  rating: 'curate',
  kind: 'curate',
  characters: 'curate',
  artists: 'curate',
  source: 'curate',
  exclude: 'curate',
  trash: 'organize-files',
  reveal: 'desktop',
  collection: 'collections',
} as const satisfies Record<string, Need>;

/** 排除 / 删除后把这张从看图器列表里拿掉，自动显示下一张（列表空了看图器会自己关） */
function dropFromLightbox(id: ID) {
  const s = useLightbox.getState();
  s.syncIds(s.ids.filter((x) => x !== id));
}

/** 排除 / 移到回收站之后在原地停多久再换下一张：这段时间里再按同一个键不会落到下一张上 */
export const LEAVE_HOLD_MS = 800;

export function useImageActions(current: CurrentImage | undefined) {
  const allow = useAllowedActions(IMAGE_ACTION_NEEDS);
  // 刚排除 / 移到回收站的那张：原地变暗、写着可以撤销，停一会儿再拿掉
  const [leaving, setLeaving] = useState<{ id: ID; kind: 'exclude' | 'trash' } | null>(null);
  const leavingRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      useLightbox.getState().setHold(null);
    },
    [],
  );
  const leave = (id: ID, kind: 'exclude' | 'trash', token: string | null) => {
    leavingRef.current = true;
    setLeaving({ id, kind });
    // 停留期间网格刷新也先别把它从看图器里拿掉
    useLightbox.getState().setHold(id);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      leavingRef.current = false;
      setLeaving(null);
      useLightbox.getState().setHold(null);
      // 停留期间已经按 Ctrl+Z 撤回了：留在这张，不拿掉
      if (token && !useUndoStore.getState().entries.some((e) => e.token === token)) return;
      dropFromLightbox(id);
    }, LEAVE_HOLD_MS);
  };

  const favorite = useMutate((v: { id: ID; value: boolean }) => api.updateImage(v.id, { favorite: v.value }), {
    // 先改缓存：背后网格上的心同时变；翻走再翻回来（这个 hook 已经在跟下一张的请求）看到的也是新值。失败了改回去
    optimistic: (v, client) => patchImages(client, [v.id], { favorite: v.value }),
  });
  const original = useMutate((v: { id: ID; value: boolean }) =>
    api.bulkImages({ ids: [v.id], action: { type: 'original', value: v.value } }),
  );
  const rating = useMutate((v: { id: ID; value: Rating }) => api.updateImage(v.id, { rating: v.value }));
  const kind = useMutate((v: { id: ID; value: ContentKind | 'auto' }) => api.updateImage(v.id, { kind: v.value }));
  const characters = useMutate((v: { id: ID; characterIds: ID[] }) =>
    api.updateImage(v.id, { characterIds: v.characterIds }),
  );
  const accept = useMutate((v: { id: ID; danbooruTag: string }) =>
    api.acceptSuggestion(v.id, { danbooruTag: v.danbooruTag }),
  );
  const assignCandidate = useMutate((v: { id: ID; danbooruTag: string }) =>
    api.bulkImages({ ids: [v.id], action: { type: 'assignTag', danbooruTag: v.danbooruTag } }),
  );
  const artist = useMutate((v: { id: ID; action: BulkImageAction }) => api.bulkImages({ ids: [v.id], action: v.action }));
  const exclude = useMutate((id: ID) => api.bulkImages({ ids: [id], action: { type: 'exclude' } }), {
    label: '排除这张',
    onSuccess: (r, id) => leave(id, 'exclude', r.undoToken),
  });
  const trash = useMutate((id: ID) => api.bulkImages({ ids: [id], action: { type: 'trash' } }), {
    label: '把这张移到回收站',
    onSuccess: (r, id) => leave(id, 'trash', r.undoToken),
  });

  const id = current?.id;
  // 这个动作在「当前这张」上还在进行（actionGuards.ts）。守卫和下面的乐观显示都只看当前这张：
  // 上一张的请求、刷新还没完，不挡这一张
  const pendingFor = <V extends { id: ID }>(m: { isPending: boolean; variables?: V }) => pendingOn(m, id);

  // 乐观显示：请求还没回来时按目标值画，心形 / 分级不会慢半拍
  const favoriteValue = pendingFor(favorite)?.value ?? current?.favorite ?? false;
  const originalValue = pendingFor(original)?.value ?? current?.original ?? false;
  const ratingValue = pendingFor(rating)?.value ?? current?.rating;
  const kindPending = pendingFor(kind)?.value;
  const kindValue = kindPending && kindPending !== 'auto' ? kindPending : current?.kind;
  const characterIds = pendingFor(characters)?.characterIds ?? current?.characterIds ?? [];

  return {
    /** 这台设备能用哪些操作（IMAGE_ACTION_NEEDS） */
    allow,
    favorite: favoriteValue,
    original: originalValue,
    rating: ratingValue,
    kind: kindValue,
    kindBusy: !!pendingFor(kind),
    characterIds,
    busy: {
      exclude: exclude.isPending,
      trash: trash.isPending,
      accept: pendingFor(accept)?.danbooruTag,
      artist: !!pendingFor(artist),
    },
    toggleFavorite: () => {
      if (current && !pendingFor(favorite)) favorite.mutate({ id: current.id, value: !favoriteValue });
    },
    /** 归为原创 / 移出原创（可撤销）；留在当前这张，方便接着往后翻 */
    toggleOriginal: () => {
      if (current && !pendingFor(original)) original.mutate({ id: current.id, value: !originalValue });
    },
    /** 改类型（T32a）；'auto' = 恢复自动判断 */
    setKind: (value: ContentKind | 'auto') => {
      if (current && !pendingFor(kind)) kind.mutate({ id: current.id, value });
    },
    setRating: (value: Rating) => {
      if (current && value !== ratingValue) rating.mutate({ id: current.id, value });
    },
    addCharacter: (characterId: ID) => {
      if (current && !characterIds.includes(characterId))
        characters.mutate({ id: current.id, characterIds: [...characterIds, characterId] });
    },
    addCandidate: (danbooruTag: string) => {
      if (current && !pendingFor(assignCandidate)) assignCandidate.mutate({ id: current.id, danbooruTag });
    },
    removeCharacter: (characterId: ID) => {
      if (current) characters.mutate({ id: current.id, characterIds: characterIds.filter((c) => c !== characterId) });
    },
    /** 手动改画师（可撤销）：改过的图之后识别不再动它 */
    addArtist: (tag: string) => {
      if (current && !pendingFor(artist)) artist.mutate({ id: current.id, action: { type: 'artist', mode: 'add', artists: [tag] } });
    },
    /** tags：这位画师在这张图上的全部标签 */
    removeArtist: (tags: string[]) => {
      if (current && !pendingFor(artist)) artist.mutate({ id: current.id, action: { type: 'artist', mode: 'remove', artists: tags } });
    },
    /** 标成没有画师（识别认出的不对，又不知道是谁） */
    clearArtists: () => {
      if (current && !pendingFor(artist)) artist.mutate({ id: current.id, action: { type: 'artist', mode: 'set', artists: [] } });
    },
    artistsAuto: () => {
      if (current && !pendingFor(artist)) artist.mutate({ id: current.id, action: { type: 'artist-auto' } });
    },
    acceptSuggestion: (danbooruTag: string) => {
      if (current && !pendingFor(accept)) accept.mutate({ id: current.id, danbooruTag });
    },
    /** 正在原地停留的那张（看图器画变暗 + 提示） */
    leaving,
    // 排除 / 回收站的锁不分图（canLeave）：停留期间再按同一个键，不能落到下一张上
    exclude: () => {
      if (current && canLeave({ excluding: exclude.isPending, trashing: trash.isPending, holding: leavingRef.current })) exclude.mutate(current.id);
    },
    trash: () => {
      if (current && canLeave({ excluding: exclude.isPending, trashing: trash.isPending, holding: leavingRef.current })) trash.mutate(current.id);
    },
    reveal: () => {
      if (!current) return;
      api.revealImage(current.id).catch((err: unknown) => toast.error(errorMessage(err)));
    },
  };
}

export type ImageActions = ReturnType<typeof useImageActions>;
