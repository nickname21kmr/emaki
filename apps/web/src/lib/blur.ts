/**
 * 模糊策略（T29b-4，CB-6、D6）：纯函数，不 import stores，方便单测。
 * 优先级：分级 > 照片 > 文字；总开关关着一律不模糊。封面类（角色封面、头像、扇形）不传 kind，只按分级。
 */
import type { ContentKind, Rating } from '@emaki/shared';
import { isSensitive, RATING_LABEL } from './format';

export type BlurLevel = 'questionable' | 'explicit';
export type BlurReason = 'rating' | 'photo' | 'text';

export interface BlurPrefs {
  blurSensitive: boolean;
  blurLevel: BlurLevel;
  blurPhoto: boolean;
  blurText: boolean;
}

export interface BlurSubject {
  rating: Rating;
  kind?: ContentKind | null;
}

export function blurReason(img: BlurSubject, p: BlurPrefs): BlurReason | null {
  if (!p.blurSensitive) return null;
  if (p.blurLevel === 'explicit' ? img.rating === 'explicit' : isSensitive(img.rating)) return 'rating';
  if (img.kind === 'photo' && p.blurPhoto) return 'photo';
  if (img.kind === 'text' && p.blurText) return 'text';
  return null;
}

export const shouldBlur = (img: BlurSubject, p: BlurPrefs) => blurReason(img, p) !== null;

export const blurLabel = (r: BlurReason, rating: Rating) => (r === 'photo' ? '照片' : r === 'text' ? '文字' : RATING_LABEL[rating]);
