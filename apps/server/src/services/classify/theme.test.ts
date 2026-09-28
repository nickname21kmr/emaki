import { describe, expect, it } from 'vitest';
import { artScore, classifyTheme, resolveTheme, THEME_TAG_NAMES, type StoredTheme } from './theme.ts';

const CASES: [string, [string, number][] | null, number | null, StoredTheme | null][] = [
  ['无人物', [['no_humans', 0.9]], 0, 'odd'],
  ['分数太低', [['1girl', 0.99], ['solo', 0.9]], -35, 'odd'],
  ['男性梗图', [['1boy', 0.9], ['male_focus', 0.8], ['parody', 0.5]], 0, 'odd'],
  ['普通男性', [['1boy', 0.9], ['male_focus', 0.8]], 10, 'other'],
  ['双人 + 腿', [['2girls', 0.8], ['thighhighs', 0.9]], 0, 'multi'],
  ['男女', [['1girl', 0.9], ['1boy', 0.7]], 0, 'multi'],
  ['泳装优先于腿', [['bikini', 0.7], ['thighhighs', 0.9]], 0, 'swim'],
  ['兽耳优先于胸', [['cat_ears', 0.8], ['cleavage', 0.9]], 0, 'kemono'],
  ['女仆优先于腿', [['maid', 0.75], ['thighhighs', 0.95]], 0, 'costume'],
  ['丝袜', [['thighhighs', 0.9]], 0, 'legs'],
  ['丝袜但是半身像', [['thighhighs', 0.9], ['upper_body', 0.6]], 0, 'other'],
  ['脚', [['feet', 0.65]], 0, 'legs'],
  ['腿和胸同时命中归腿', [['thighhighs', 0.9], ['cleavage', 0.9]], 0, 'legs'],
  ['胸', [['cleavage', 0.7]], 0, 'chest'],
  ['large_breasts 不够', [['large_breasts', 0.79]], 0, 'other'],
  ['large_breasts 够', [['large_breasts', 0.8]], 0, 'chest'],
  ['空标签', [], 0, 'other'],
  ['没打标签', null, null, null],
];

describe('classifyTheme', () => {
  it.each(CASES)('%s', (_n, tags, score, want) => expect(classifyTheme(tags, score)).toBe(want));
});

describe('resolveTheme', () => {
  it('漫画、不像插画优先于分级；敏感优先于存的主题', () => {
    expect(resolveTheme({ kind: 'comic', rating: 'explicit', theme: 'legs' })).toBe('comic');
    expect(resolveTheme({ kind: 'illustration', rating: 'explicit', theme: 'odd' })).toBe('odd');
    expect(resolveTheme({ kind: 'illustration', rating: 'questionable', theme: 'legs' })).toBe('nsfw');
    expect(resolveTheme({ kind: 'illustration', rating: 'general', theme: null })).toBe('other');
  });
});

describe('artScore', () => {
  it('单人插画为正，截图很低', () => {
    expect(artScore({ w: 1200, h: 1700, fileName: 'a.png' }, [['solo', 0.95]])).toBeGreaterThan(0);
    expect(artScore({ w: 1080, h: 2340, fileName: 'Screenshot_1.png' }, [])).toBeLessThanOrEqual(-30);
  });
  it('THEME_TAG_NAMES 覆盖规则和质量分用到的标签', () => {
    expect(THEME_TAG_NAMES).toEqual(expect.arrayContaining(['thighhighs', 'solo', 'no_humans']));
  });
});
