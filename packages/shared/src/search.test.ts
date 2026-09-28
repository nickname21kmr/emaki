import { describe, expect, it } from 'vitest';
import { matchesQuery, searchKey } from './search.ts';

describe('searchKey', () => {
  it('全角转半角、转小写', () => expect(searchKey('ＭＩＫＡ')).toBe('mika'));
  it('片假名等同平假名', () => expect(searchKey('ミカ')).toBe(searchKey('みか')));
  it('去掉括号里的作品后缀和下划线', () => expect(searchKey('Mika_(Blue_Archive)')).toBe('mika'));
  it('空白、下划线、中点都忽略', () => expect(searchKey('hatsune_miku')).toBe(searchKey('Hatsune Miku')));
  it('空查询永远命中', () => expect(matchesQuery('  ', ['x'])).toBe(true));
  it('任一候选包含即命中', () => expect(matchesQuery('未花', ['圣园未花', null])).toBe(true));
});
