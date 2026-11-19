import { searchKey } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { buildPhraseDict, parseTagPhrase } from './tagPhrase.ts';

// 小词库：结构和真实 tag_i18n 一样（标签名、中文名、别名）
const ROWS: [string, string, string[], number][] = [
  ['1girl', '一个女孩', ['女孩', '少女', '女生', '女性'], 600],
  ['2girls', '两个女孩', ['2girl'], 90],
  ['3girls', '三个女孩', [], 20],
  ['multiple_girls', '多名女性', ['群像'], 160],
  ['1boy', '一个男孩', ['少年', '男人'], 110],
  ['multiple_boys', '多名男性', ['群像'], 30],
  ['solo', '单人', [], 500],
  ['black_hair', '黑发', ['黑毛', '黑髪'], 170],
  ['blonde_hair', '金发', ['金毛', 'blonde'], 140],
  ['white_hair', '白发', ['白毛', '白髪'], 110],
  ['grey_hair', '灰发', ['白髪', '银髪'], 100],
  ['long_hair', '长发', [], 650],
  ['short_hair', '短发', [], 150],
  ['twintails', '双马尾', ['twin_tails'], 110],
  ['thighhighs', '过膝袜', ['长筒袜'], 140],
  ['red_eyes', '红眼', ['赤瞳'], 120],
  ['blue_eyes', '蓝眼', ['碧眼'], 180],
  ['maid', '女仆', [], 40],
];
const dict = buildPhraseDict(
  ROWS.map(([tag, zh, aliases, count]) => ({ tag, primary: [searchKey(tag), searchKey(zh)], aliases: aliases.map(searchKey), count })),
);
const parse = (text: string) => parseTagPhrase(text, dict);

describe('parseTagPhrase', () => {
  it('人数 + 颜色长发 + 性别：两个黑色长发女孩', () => {
    expect(parse('两个黑色长发女孩')).toEqual({ tags: ['2girls', 'black_hair', 'long_hair'], rest: '' });
  });

  it('词库里的词连在一起：金发双马尾', () => {
    expect(parse('金发双马尾')).toEqual({ tags: ['blonde_hair', 'twintails'], rest: '' });
  });

  it('虚词跳过，单独的「女孩」= 1girl：穿过膝袜的女孩', () => {
    expect(parse('穿过膝袜的女孩')).toEqual({ tags: ['thighhighs', '1girl'], rest: '' });
  });

  it('词库没有的颜色组合按规则拼：白发红瞳（「红瞳」不在词库里）', () => {
    expect(parse('白发红瞳')).toEqual({ tags: ['white_hair', 'red_eyes'], rest: '' });
  });

  it('认不出的字留在 rest，不影响其他的', () => {
    expect(parse('黑发 宇宙飞船 少女')).toEqual({ tags: ['black_hair', '1girl'], rest: '宇宙飞船' });
    expect(parse('完全不认识')).toEqual({ tags: [], rest: '完全不认识' });
    // 原来用空格隔开的，rest 里也分开
    expect(parse('宇宙飞船 机甲 金发')).toEqual({ tags: ['blonde_hair'], rest: '宇宙飞船 机甲' });
  });

  it('长词优先：女仆不拆成 女 + 仆；同一个别名对上两个标签时取张数多的（白髪）', () => {
    expect(parse('女仆').tags).toEqual(['maid']);
    expect(parse('白髪').tags).toEqual(['white_hair']);
  });

  it('人数的各种写法', () => {
    expect(parse('一男一女').tags).toEqual(['1boy', '1girl']);
    expect(parse('2个女生').tags).toEqual(['2girls']);
    expect(parse('三名少女').tags).toEqual(['3girls']);
    expect(parse('一群男生').tags).toEqual(['multiple_boys']);
    expect(parse('多个女孩').tags).toEqual(['multiple_girls']);
    // 没写男女：单人本身是词（solo），两人按女孩算
    expect(parse('单人').tags).toEqual(['solo']);
    expect(parse('两人 金发').tags).toEqual(['2girls', 'blonde_hair']);
  });

  it('颜色和部位分开写、带「色」「的」', () => {
    expect(parse('金色的短发').tags).toEqual(['blonde_hair', 'short_hair']);
    expect(parse('蓝色眼睛').tags).toEqual(['blue_eyes']);
    expect(parse('黑长发').tags).toEqual(['black_hair', 'long_hair']);
    expect(parse('黑长直').tags).toEqual(['black_hair', 'long_hair']); // 词库里没有 straight_hair 就不出
  });

  it('英文：空格和下划线都行', () => {
    expect(parse('2girls black hair, twin_tails').tags).toEqual(['2girls', 'black_hair', 'twintails']);
  });

  it('只输出 has 认可的标签', () => {
    const r = parseTagPhrase('两个黑色长发女孩', dict, (t) => t !== 'black_hair');
    expect(r.tags).toEqual(['2girls', 'long_hair']);
  });
});
