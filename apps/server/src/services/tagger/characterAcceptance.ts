import type { ContentKind } from '@emaki/shared';

/** 达标时可复用已有角色；插画、漫画和动图也可建立角色。 */
export function canAutoAcceptCharacter(kind: ContentKind, characterId: number | string | null): boolean {
  return characterId !== null || kind === 'illustration' || kind === 'comic' || kind === 'animated';
}
