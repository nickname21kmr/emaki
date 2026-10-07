import type { BulkImageAction, ContentKind, ID, Rating } from '@emaki/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorMessage, useMutate } from '@/lib/queries';
import { useLightbox } from '@/lib/stores';

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

/** 排除 / 删除后把这张从看图器列表里拿掉，自动显示下一张（列表空了看图器会自己关） */
function dropFromLightbox(id: ID) {
  const s = useLightbox.getState();
  s.syncIds(s.ids.filter((x) => x !== id));
}

export function useImageActions(current: CurrentImage | undefined) {
  const favorite = useMutate((v: { id: ID; value: boolean }) => api.updateImage(v.id, { favorite: v.value }));
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
  const artist = useMutate((v: { id: ID; action: BulkImageAction }) => api.bulkImages({ ids: [v.id], action: v.action }));
  const exclude = useMutate((id: ID) => api.bulkImages({ ids: [id], action: { type: 'exclude' } }), {
    onSuccess: (_, id) => dropFromLightbox(id),
  });
  const trash = useMutate((id: ID) => api.bulkImages({ ids: [id], action: { type: 'trash' } }), {
    onSuccess: (_, id) => dropFromLightbox(id),
  });

  const id = current?.id;
  const pendingFor = <V extends { id: ID }>(m: { isPending: boolean; variables?: V }) =>
    m.isPending && m.variables?.id === id ? m.variables : undefined;

  // 乐观显示：请求还没回来时按目标值画，心形 / 分级不会慢半拍
  const favoriteValue = pendingFor(favorite)?.value ?? current?.favorite ?? false;
  const originalValue = pendingFor(original)?.value ?? current?.original ?? false;
  const ratingValue = pendingFor(rating)?.value ?? current?.rating;
  const kindPending = pendingFor(kind)?.value;
  const kindValue = kindPending && kindPending !== 'auto' ? kindPending : current?.kind;
  const characterIds = pendingFor(characters)?.characterIds ?? current?.characterIds ?? [];

  return {
    favorite: favoriteValue,
    original: originalValue,
    rating: ratingValue,
    kind: kindValue,
    kindBusy: kind.isPending,
    characterIds,
    busy: {
      exclude: exclude.isPending,
      trash: trash.isPending,
      accept: accept.isPending ? accept.variables?.danbooruTag : undefined,
      artist: artist.isPending,
    },
    toggleFavorite: () => {
      if (current && !favorite.isPending) favorite.mutate({ id: current.id, value: !favoriteValue });
    },
    /** 归为原创 / 移出原创（可撤销）；留在当前这张，方便接着往后翻 */
    toggleOriginal: () => {
      if (current && !original.isPending) original.mutate({ id: current.id, value: !originalValue });
    },
    /** 改类型（T32a）；'auto' = 恢复自动判断 */
    setKind: (value: ContentKind | 'auto') => {
      if (current && !kind.isPending) kind.mutate({ id: current.id, value });
    },
    setRating: (value: Rating) => {
      if (current && value !== ratingValue) rating.mutate({ id: current.id, value });
    },
    addCharacter: (characterId: ID) => {
      if (current && !characterIds.includes(characterId))
        characters.mutate({ id: current.id, characterIds: [...characterIds, characterId] });
    },
    removeCharacter: (characterId: ID) => {
      if (current) characters.mutate({ id: current.id, characterIds: characterIds.filter((c) => c !== characterId) });
    },
    /** 手动改画师（可撤销）：改过的图之后识别不再动它 */
    addArtist: (tag: string) => {
      if (current && !artist.isPending) artist.mutate({ id: current.id, action: { type: 'artist', mode: 'add', artists: [tag] } });
    },
    /** tags：这位画师在这张图上的全部标签 */
    removeArtist: (tags: string[]) => {
      if (current && !artist.isPending) artist.mutate({ id: current.id, action: { type: 'artist', mode: 'remove', artists: tags } });
    },
    /** 标成没有画师（识别认出的不对，又不知道是谁） */
    clearArtists: () => {
      if (current && !artist.isPending) artist.mutate({ id: current.id, action: { type: 'artist', mode: 'set', artists: [] } });
    },
    artistsAuto: () => {
      if (current && !artist.isPending) artist.mutate({ id: current.id, action: { type: 'artist-auto' } });
    },
    acceptSuggestion: (danbooruTag: string) => {
      if (current && !accept.isPending) accept.mutate({ id: current.id, danbooruTag });
    },
    exclude: () => {
      if (current && !exclude.isPending) exclude.mutate(current.id);
    },
    trash: () => {
      if (current && !trash.isPending) trash.mutate(current.id);
    },
    reveal: () => {
      if (!current) return;
      api.revealImage(current.id).catch((err: unknown) => toast.error(errorMessage(err)));
    },
  };
}

export type ImageActions = ReturnType<typeof useImageActions>;
