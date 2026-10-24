import { describe, expect, it } from 'vitest';
import type { Character } from '@emaki/shared';
import { freshRecents, keepFullCharacters, useRecentCharacters } from './recentCharacters';

const full = (id: string) => ({ id, name: id, aliases: [], workIds: ['w1'], imageCount: 1 });
// 命令面板「最近访问」的精简快照
const slim = (id: string) => ({ id, name: id, workName: null, coverImageId: null, coverFocus: null, imageCount: 1 });

describe('keepFullCharacters', () => {
  it('去掉命令面板的精简快照，只留完整角色', () => {
    expect(keepFullCharacters([slim('a'), full('b'), slim('c')]).map((c) => c.id)).toEqual(['b']);
  });

  it('坏数据返回空', () => {
    expect(keepFullCharacters(undefined)).toEqual([]);
    expect(keepFullCharacters('x')).toEqual([]);
    expect(keepFullCharacters([null, 1, {}])).toEqual([]);
  });
});

const ch = (id: string, name = id) => ({ ...full(id), name }) as unknown as Character;

describe('最近使用的快照', () => {
  it('freshRecents 用新数据换掉过时的快照，没有新数据的保持原样', () => {
    const old = [ch('a', '由比ヶ浜結衣'), ch('b')];
    const fresh = new Map([['a', ch('a', '雪ノ下雪乃')]]);
    expect(freshRecents(old, (id) => fresh.get(id)).map((c) => c.name)).toEqual(['雪ノ下雪乃', 'b']);
  });

  it('patch 改名不改位置，不在列表里的不加进来', () => {
    const s = useRecentCharacters.getState();
    s.push(ch('a'));
    s.push(ch('b'));
    s.patch({ id: 'a', name: '新名字' });
    s.patch({ id: 'zz', name: '别的' });
    expect(useRecentCharacters.getState().items.map((c) => [c.id, c.name])).toEqual([
      ['b', 'b'],
      ['a', '新名字'],
    ]);
  });
});
