import { describe, expect, it } from 'vitest';
import { ASSIGN_CANDIDATES_KEY, cacheScope, EVERYTHING_SCOPE } from './cacheScope.ts';
import { ALL_CHANGES, type Change, type ChangeType } from './changes.ts';

/** 结果缓存里现在用到的键，每种各一个 */
const KEYS = [
  'counts',
  'summary',
  'kinds',
  'count:{}',
  'count:{"favorite":true}',
  'count:{"rating":["explicit"]}',
  'count:{"rated":true}',
  'count:{"poseClass":"full_01"}',
  'count:{"posewearPose":"full_single_P001","posewearReliable":true}',
  'count:{"characterId":"7"}',
  'dups:0',
  'dups:1',
  'artists',
  'qtext:mika',
  ASSIGN_CANDIDATES_KEY,
  '以后新加的键',
];
const kept = (changes: Change[]) => {
  const scope = cacheScope(changes);
  return KEYS.filter((k) => !scope.drops(k));
};
const img = <T extends ChangeType>(type: T, ...ids: number[]) => ({ type, ids }) as Extract<Change, { type: T }>;

describe('一次提交让哪些缓存失效', () => {
  it('一条变化都没有（不声明变化的命令）：全部失效', () => {
    expect(cacheScope([])).toBe(EVERYTHING_SCOPE);
    expect(kept([])).toEqual([]);
  });

  it('不认识的变化类型：全部失效', () => {
    expect(cacheScope([{ type: 'plugin.somethingNew', ids: [1] } as unknown as Change])).toBe(EVERYTHING_SCOPE);
  });

  it('收藏：只清带收藏筛选的总数、重复组和没列出来的键；角色和作品只在改到封面图时才管', () => {
    const scope = cacheScope([img('curation.favoriteChanged', 3, 4)]);
    expect(scope).toMatchObject({ everything: false, unrecognized: false, tagCounts: false });
    expect(scope.derived).toEqual({ all: false, covers: [3, 4], links: [], original: [], seen: [] });
    expect(kept([img('curation.favoriteChanged', 3)])).toEqual([
      'counts',
      'summary',
      'kinds',
      'count:{}',
      'count:{"rating":["explicit"]}',
      'count:{"rated":true}',
      'count:{"poseClass":"full_01"}',
      'count:{"posewearPose":"full_single_P001","posewearReliable":true}',
      'count:{"characterId":"7"}',
      'qtext:mika',
      ASSIGN_CANDIDATES_KEY,
    ]);
  });

  it('分级：带分级筛选的总数、别册、重复组、未识别汇总', () => {
    const scope = cacheScope([img('curation.ratingChanged', 9)]);
    expect(scope).toMatchObject({ everything: false, unrecognized: true, tagCounts: false });
    expect(scope.derived).toMatchObject({ all: false, covers: [9] });
    expect(kept([img('curation.ratingChanged', 9)])).toEqual([
      'counts',
      'summary',
      'count:{}',
      'count:{"favorite":true}',
      'count:{"poseClass":"full_01"}',
      'count:{"posewearPose":"full_single_P001","posewearReliable":true}',
      'count:{"characterId":"7"}',
      'qtext:mika',
      ASSIGN_CANDIDATES_KEY,
    ]);
  });

  it('放下：统计、全部总数、重复组、未识别汇总；角色和作品不动', () => {
    const scope = cacheScope([img('curation.shelvedChanged', 5)]);
    expect(scope).toMatchObject({ everything: false, unrecognized: true, tagCounts: false });
    expect(scope.derived).toEqual({ all: false, covers: [], links: [], original: [], seen: [] });
    expect(kept([img('curation.shelvedChanged', 5)])).toEqual(['kinds', 'qtext:mika', ASSIGN_CANDIDATES_KEY]);
  });

  it('姿势：只清按姿势筛的总数和没列出来的键', () => {
    const scope = cacheScope([img('pose.changed', 1, 2)]);
    expect(scope).toMatchObject({ everything: false, unrecognized: false, tagCounts: false });
    expect(scope.derived).toEqual({ all: false, covers: [], links: [], original: [], seen: [] });
    expect(kept([img('pose.changed', 1)])).toEqual([
      'counts',
      'summary',
      'kinds',
      'count:{}',
      'count:{"favorite":true}',
      'count:{"rating":["explicit"]}',
      'count:{"rated":true}',
      'count:{"characterId":"7"}',
      'dups:0',
      'dups:1',
    ]);
  });

  it('看过了：只重算那个角色的 +N，别的都留着', () => {
    const scope = cacheScope([{ type: 'catalog.characterSeen', characterIds: [12], ids: [] }]);
    expect(scope).toMatchObject({ everything: false, unrecognized: false, tagCounts: false });
    expect(scope.derived).toEqual({ all: false, covers: [], links: [], original: [], seen: [12] });
    expect(kept([{ type: 'catalog.characterSeen', characterIds: [12], ids: [] }])).toEqual(KEYS);
  });

  it('归类、原创、否决：角色和作品定向重算，结果缓存全清，标签张数不动', () => {
    const scope = cacheScope([img('curation.charactersChanged', 1, 2), img('curation.vetoesChanged', 2), img('curation.autoOriginalChanged', 7)]);
    expect(scope).toMatchObject({ everything: false, unrecognized: true, tagCounts: false });
    expect(scope.derived).toEqual({ all: false, covers: [], links: [1, 2], original: [7], seen: [] });
    expect(kept([img('curation.charactersChanged', 1)])).toEqual([]);
    expect(cacheScope([img('curation.originalChanged', 3)]).derived).toMatchObject({ all: false, links: [], original: [3] });
  });

  it('混着来取并集：收藏 + 归类 → 结果缓存全清，封面检查和定向重算都要做', () => {
    const scope = cacheScope([img('curation.favoriteChanged', 3), img('curation.charactersChanged', 4)]);
    expect(scope.derived).toEqual({ all: false, covers: [3], links: [4], original: [], seen: [] });
    expect(scope.unrecognized).toBe(true);
    expect(kept([img('curation.favoriteChanged', 3), img('curation.charactersChanged', 4)])).toEqual([]);
    // 收藏 + 分级：两边都说可以留的才留
    expect(kept([img('curation.favoriteChanged', 3), img('curation.ratingChanged', 3)])).toEqual([
      'counts',
      'summary',
      'count:{}',
      'count:{"poseClass":"full_01"}',
      'count:{"posewearPose":"full_single_P001","posewearReliable":true}',
      'count:{"characterId":"7"}',
      'qtext:mika',
      ASSIGN_CANDIDATES_KEY,
    ]);
  });

  it('有一条没有专门规则的变化：角色、作品、结果缓存、未识别汇总照旧全部失效', () => {
    for (const other of [img('image.kindChanged', 1), img('curation.artistsChanged', 1), { type: 'catalog.characterChanged', characterIds: [1], ids: [] }] as Change[]) {
      const scope = cacheScope([img('curation.favoriteChanged', 3), other]);
      expect(scope.derived.all).toBe(true);
      expect(scope.unrecognized).toBe(true);
      expect(KEYS.every((k) => scope.drops(k))).toBe(true);
    }
    // 排除结果变了：连标签张数也过期，就是原来的全部失效
    expect(cacheScope([img('curation.favoriteChanged', 3), { type: 'visibility.changed', ids: [3], excluded: [3], released: [] }])).toBe(EVERYTHING_SCOPE);
  });

  it('标签张数只在图的标签、图计不计入变了的时候过期', () => {
    const stale = ALL_CHANGES.filter((type) => cacheScope([{ type, ids: [1], characterIds: [1], rootIds: [1] } as unknown as Change]).tagCounts);
    expect([...stale].sort()).toEqual(
      [
        'evidence.changed',
        'image.added',
        'image.fileChanged',
        'image.gone',
        'image.moved',
        'image.restored',
        'image.returned',
        'image.trashed',
        'library.opened',
        'root.visibilityChanged',
        'visibility.changed',
      ].sort(),
    );
  });

  it('只有这几种变化收窄了，其余每一种单独来都是角色、作品、结果缓存全部失效', () => {
    const narrowed = ALL_CHANGES.filter((type) => !cacheScope([{ type, ids: [1], characterIds: [1], rootIds: [1] } as unknown as Change]).derived.all);
    expect([...narrowed].sort()).toEqual(
      [
        'catalog.characterSeen',
        'curation.autoOriginalChanged',
        'curation.charactersChanged',
        'curation.favoriteChanged',
        'curation.originalChanged',
        'curation.ratingChanged',
        'curation.shelvedChanged',
        'curation.vetoesChanged',
        'pose.changed',
      ].sort(),
    );
  });
});
