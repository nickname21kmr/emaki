import { describe, expect, it } from 'vitest';
import { artistGroups, kanaToRomaji, pickDisplayName, twitterOf, type ArtistMeta } from '../artistNames.ts';

describe('画师名字', () => {
  it('假名转罗马字', () => {
    expect(kanaToRomaji('カントク')).toBe('kantoku');
    expect(kanaToRomaji('しゃしん')).toBe('shashin');
    expect(kanaToRomaji('きっと')).toBe('kitto');
  });

  it('显示名：读音对得上标签的日文名优先，全名胜过昵称；对不上取第一个；没有日文名为 null', () => {
    expect(pickDisplayName('mishima_kurone', ['くろねぇ', 'くろねお姉ちゃん', '三嶋くろね', '三嶋黒音', 'luciahreat'], 'ShiroPro')).toBe('三嶋くろね');
    expect(pickDisplayName('kantoku', ['5年目の放課後', 'カントク', '5-y.2-d'], 'afterschool_of_the_5th_year')).toBe('カントク');
    expect(pickDisplayName('ama_mitsuki', ['aienkien', '天三月'], null)).toBe('天三月');
    expect(pickDisplayName('someone', ['someone_art'], null)).toBeNull();
  });

  it('推特账号：跳过 intent 这类链接，还在用的优先', () => {
    expect(twitterOf([{ url: 'https://twitter.com/intent/user?user_id=1' }, { url: 'https://x.com/old', is_active: false }, { url: 'https://twitter.com/new_one' }])).toBe(
      'new_one',
    );
    expect(twitterOf([{ url: 'https://www.pixiv.net/users/1' }])).toBeNull();
  });

  it('合并：改过名的旧标签并到新标签；社团名只属于一个人时并到这个人', () => {
    const m = (name: string, names: string[] = [], aliasOf: string | null = null): [string, ArtistMeta] => [name, { name, display: null, names, twitter: null, aliasOf }];
    const meta = new Map([m('old_name', [], 'new_name'), m('new_name'), m('a', ['circle']), m('b', ['shared']), m('c', ['shared'])]);
    const g = artistGroups(['old_name', 'new_name', 'a', 'circle', 'b', 'c', 'shared'], meta);
    expect(g.get('old_name')).toBe('new_name');
    expect(g.get('circle')).toBe('a');
    // 两个人共用的社团不并
    expect(g.get('shared')).toBe('shared');
  });

  it('两个人：B 在 Danbooru 上有自己的资料、又没提到 A，就算 A 的其他名字里写着 B 也不并（よつば）', () => {
    const m = (name: string, display: string | null, names: string[]): [string, ArtistMeta] => [name, { name, display, names, twitter: null, aliasOf: null }];
    const meta = new Map([m('kitada_mo', 'よつば', ['ikuchan_kaoru', 'よつば', '北田藻']), m('ikuchan_kaoru', '貧乏', ['iku', '郁'])]);
    expect(artistGroups(['kitada_mo', 'ikuchan_kaoru'], meta).get('ikuchan_kaoru')).toBe('ikuchan_kaoru');
    // B 的资料里也提到了 A：还是同一个人
    const both = new Map([m('kitada_mo', 'よつば', ['ikuchan_kaoru']), m('ikuchan_kaoru', null, ['kitada_mo'])]);
    expect(artistGroups(['kitada_mo', 'ikuchan_kaoru'], both).get('ikuchan_kaoru')).toBe('kitada_mo');
  });

  it('手动拆开 / 合并优先于自动', () => {
    const m = (name: string, names: string[] = [], aliasOf: string | null = null): [string, ArtistMeta] => [name, { name, display: null, names, twitter: null, aliasOf }];
    const meta = new Map([m('a', ['circle']), m('old', [], 'new'), m('new')]);
    const g = artistGroups(['a', 'circle', 'old', 'new', 'x', 'y'], meta, new Map<string, string | null>([['circle', null], ['old', null], ['x', 'y']]));
    expect([g.get('circle'), g.get('old'), g.get('x'), g.get('y')]).toEqual(['circle', 'old', 'y', 'y']);
  });

  it('绕成环（手动合并互指、改名互指）：环上的标签都落到字母序最小的那个', () => {
    const g = artistGroups(['b', 'c', 'a'], new Map(), new Map<string, string | null>([['b', 'c'], ['c', 'a'], ['a', 'b']]));
    expect([g.get('a'), g.get('b'), g.get('c')]).toEqual(['a', 'a', 'a']);
  });
});
