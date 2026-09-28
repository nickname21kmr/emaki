import type { ContentKind, Rating } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { blurLabel, blurReason, type BlurPrefs } from './blur';

const P: BlurPrefs = { blurSensitive: true, blurLevel: 'questionable', blurPhoto: true, blurText: false };
const img = (rating: Rating, kind?: ContentKind) => ({ rating, kind });

describe('blurReason', () => {
  it.each([
    ['全年龄插画', img('general', 'illustration'), P, null],
    ['轻微', img('sensitive'), P, null],
    ['较敏感', img('questionable'), P, 'rating'],
    ['限制级照片按分级', img('explicit', 'photo'), P, 'rating'],
    ['全年龄照片', img('general', 'photo'), P, 'photo'],
    ['轻微照片', img('sensitive', 'photo'), P, 'photo'],
    ['文字默认不模糊', img('general', 'text'), P, null],
    ['文字打开后模糊', img('general', 'text'), { ...P, blurText: true }, 'text'],
    ['仅限制级：较敏感不模糊', img('questionable'), { ...P, blurLevel: 'explicit' }, null],
    ['仅限制级：较敏感照片仍按照片', img('questionable', 'photo'), { ...P, blurLevel: 'explicit' }, 'photo'],
    ['总开关关着', img('explicit', 'photo'), { ...P, blurSensitive: false }, null],
  ] as const)('%s', (_n, subject, prefs, want) => expect(blurReason(subject, prefs)).toBe(want));
});

describe('blurLabel', () => {
  it('照片 / 分级 / 文字', () => {
    expect(blurLabel('photo', 'general')).toBe('照片');
    expect(blurLabel('rating', 'questionable')).toBe('较敏感');
    expect(blurLabel('text', 'general')).toBe('文字');
  });
});
