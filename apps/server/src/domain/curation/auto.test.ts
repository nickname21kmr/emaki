/**
 * decideAuto（docs/core-architecture.md 第 4.2 节）是纯函数：只看传进来的事实、证据、当前决定、设置和编目解析。
 * 这里不开库，直接喂输入，覆盖加关联、建档、否决、D2 撤回、D8 原创的规则。
 */
import { describe, expect, it } from 'vitest';
import { decideAuto, type CatalogView, type CurrentLink, type Evidence, type ImageFacts } from './auto.ts';

const ALICE = 1;
const BOB = 2;
const known: Record<string, number> = { alice: ALICE, bob: BOB };

const image = (over: Partial<ImageFacts> = {}): ImageFacts => ({
  id: 10,
  kind: 'illustration',
  shelved: false,
  original: { marked: false, decision: null, rule: null, provider: null },
  inBook: false,
  inComicArea: false,
  excluded: false,
  ...over,
});
const tagger = (candidates: [string, number][], fresh = false): Evidence => ({
  provider: 'tagger',
  fresh,
  original: false,
  candidates: candidates.map(([tag, score]) => ({ tag, characterId: null, score })),
});
const pixiv = (candidates: [string, number][], opts: { fresh?: boolean; original?: boolean } = {}): Evidence => ({
  provider: 'pixiv',
  fresh: opts.fresh ?? false,
  original: opts.original ?? false,
  candidates: candidates.map(([tag, score]) => ({ tag, characterId: null, score })),
});
const settings = { threshold: (p: string) => (p === 'pixiv' ? 0.5 : 0.85) };
const catalog = (creating: string[] = []): CatalogView => ({
  resolve: (c) => c.characterId ?? known[c.tag] ?? null,
  canCreate: (tag) => !tag.startsWith('emaki:'),
  creating: (tag) => creating.includes(tag),
});
const link = (characterId: number, over: Partial<CurrentLink> = {}): CurrentLink => ({
  characterId,
  decision: 'auto',
  rule: 'auto-accept@2',
  provider: 'tagger',
  tag: null,
  score: 0.9,
  ...over,
});
const none = { links: [], vetoed: new Set<number>() };

describe('decideAuto', () => {
  it('同样的输入一定得到同样的输出（纯函数）', () => {
    const args = [image(), [tagger([['alice', 0.9], ['carol', 0.95]])], none, settings, catalog()] as const;
    expect(decideAuto(...args)).toEqual(decideAuto(...args));
  });

  it('达到这个来源的自动阈值才关联；阈值按来源取', () => {
    const d = decideAuto(image(), [tagger([['alice', 0.84], ['bob', 0.85]]), pixiv([['alice', 0.6]])], none, settings, catalog());
    expect(d.link.map((l) => [l.characterId, l.provider])).toEqual([
      [BOB, 'tagger'],
      [ALICE, 'pixiv'],
    ]);
  });

  it('同一个角色多份证据只关联一次，取分数最高的那份', () => {
    const d = decideAuto(image(), [tagger([['alice', 0.9]]), pixiv([['alice', 1]])], none, settings, catalog());
    expect(d.link).toEqual([{ characterId: ALICE, tag: 'alice', provider: 'pixiv', score: 1 }]);
  });

  it('已经关联的、用户否决过的不加', () => {
    const d = decideAuto(image(), [tagger([['alice', 0.9], ['bob', 0.9]])], { links: [link(ALICE, { decision: 'manual' })], vetoed: new Set([BOB]) }, settings, catalog());
    expect(d.link).toEqual([]);
  });

  it('放下、归了原创、在漫画区、被排除的图不加关联', () => {
    const ev = [tagger([['alice', 0.9]])];
    for (const over of [{ shelved: true }, { original: { marked: true, decision: 'manual' as const, rule: null, provider: null } }, { inComicArea: true }, { excluded: true }]) {
      expect(decideAuto(image(over), ev, none, settings, catalog()).link).toEqual([]);
    }
    // 整本处理的合集里的页照样关联（角色在本子里出现的页数按页上的关联算）
    expect(decideAuto(image({ inBook: true }), ev, none, settings, catalog()).link).toHaveLength(1);
  });

  it('新角色：插画、漫画上建档（动的也一样，D5：是否动图不是 decideAuto 的输入）；截图、表情只复用同一轮里别的图建的', () => {
    const ev = [tagger([['carol', 0.9]])];
    for (const kind of ['illustration', 'comic'] as const) {
      const d = decideAuto(image({ kind }), ev, none, settings, catalog());
      expect(d.createCharacters).toEqual([{ tag: 'carol' }]);
      expect(d.link).toEqual([{ characterId: null, tag: 'carol', provider: 'tagger', score: 0.9 }]);
    }
    expect(decideAuto(image({ kind: 'screenshot' }), ev, none, settings, catalog())).toEqual({ link: [], unlink: [], createCharacters: [] });
    expect(decideAuto(image({ kind: 'meme' }), ev, none, settings, catalog())).toEqual({ link: [], unlink: [], createCharacters: [] });
    const shared = decideAuto(image({ kind: 'screenshot' }), ev, none, settings, catalog(['carol']));
    expect(shared.createCharacters).toEqual([]);
    expect(shared.link).toEqual([{ characterId: null, tag: 'carol', provider: 'tagger', score: 0.9 }]);
    // 自建角色的占位标签不建档；自建角色已经不在了的候选作废
    const custom: Evidence = { provider: 'pixiv', fresh: false, original: false, candidates: [{ tag: 'emaki:character:9', characterId: 9, score: 1 }] };
    expect(decideAuto(image(), [custom], none, settings, { ...catalog(), resolve: () => null }).link).toEqual([]);
  });

  describe('D2：证据不再支持时撤回', () => {
    it('依据的来源证据刚换过、新证据里没有这个候选或分数不够：撤回', () => {
      const current = { links: [link(ALICE), link(BOB)], vetoed: new Set<number>() };
      const d = decideAuto(image(), [tagger([['bob', 0.6]], true)], current, settings, catalog());
      expect(d.unlink.map((l) => l.characterId)).toEqual([ALICE, BOB]);
    });

    it('证据没换过（阈值调高、补采纳、改类型）不撤回', () => {
      const current = { links: [link(ALICE)], vetoed: new Set<number>() };
      expect(decideAuto(image({ kind: 'screenshot' }), [tagger([['alice', 0.6]])], current, settings, catalog()).unlink).toEqual([]);
    });

    it('别的来源换了证据不撤回这个来源的；手动的、来历不明（legacy）的永远不撤回', () => {
      const current = {
        links: [link(ALICE), link(BOB, { decision: 'manual', rule: null }), link(3, { rule: 'legacy', provider: null })],
        vetoed: new Set<number>(),
      };
      expect(decideAuto(image(), [tagger([['alice', 0.9]]), pixiv([], { fresh: true })], current, settings, catalog()).unlink).toEqual([]);
      expect(decideAuto(image(), [tagger([], true)], current, settings, catalog()).unlink.map((l) => l.characterId)).toEqual([ALICE]);
      // 来源已知的旧数据（legacy:tagger）照样按证据撤回
      const legacy = { links: [link(ALICE, { rule: 'legacy:tagger' })], vetoed: new Set<number>() };
      expect(decideAuto(image(), [tagger([], true)], legacy, settings, catalog()).unlink).toHaveLength(1);
    });

    it('别的来源仍然支持：撤回再加回（写入时只改来历）', () => {
      const current = { links: [link(ALICE)], vetoed: new Set<number>() };
      const d = decideAuto(image(), [tagger([], true), pixiv([['alice', 1]])], current, settings, catalog());
      expect(d.unlink.map((l) => l.characterId)).toEqual([ALICE]);
      expect(d.link).toEqual([{ characterId: ALICE, tag: 'alice', provider: 'pixiv', score: 1 }]);
    });
  });

  describe('D8：原创', () => {
    it('证据里有原创信号、还没有决定、也没有角色：自动标原创', () => {
      expect(decideAuto(image(), [pixiv([], { original: true })], none, settings, catalog()).original).toEqual({ value: true, provider: 'pixiv', rule: 'auto-original@1' });
      expect(decideAuto(image(), [pixiv([], { original: true })], { links: [link(ALICE)], vetoed: new Set() }, settings, catalog()).original).toBeUndefined();
    });

    it('手动标原创、手动取消原创都是决定，自动不改', () => {
      const cleared = image({ original: { marked: false, decision: 'manual', rule: null, provider: null } });
      expect(decideAuto(cleared, [pixiv([], { original: true, fresh: true })], none, settings, catalog()).original).toBeUndefined();
      const marked = image({ original: { marked: true, decision: 'manual', rule: null, provider: null } });
      expect(decideAuto(marked, [pixiv([], { fresh: true })], none, settings, catalog()).original).toBeUndefined();
    });

    it('自动标的原创：依据的来源证据刚换过、信号不在了才撤回', () => {
      const auto = image({ original: { marked: true, decision: 'auto', rule: 'auto-original@1', provider: 'pixiv' } });
      expect(decideAuto(auto, [pixiv([['alice', 1]], { fresh: true })], none, settings, catalog()).original).toEqual({ value: false });
      expect(decideAuto(auto, [pixiv([['alice', 1]])], none, settings, catalog()).original).toBeUndefined();
      expect(decideAuto(auto, [pixiv([], { fresh: true, original: true })], none, settings, catalog()).original).toBeUndefined();
    });
  });
});
