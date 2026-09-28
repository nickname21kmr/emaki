import { describe, expect, it } from 'vitest';
import { keepFullCharacters } from './recentCharacters';

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
