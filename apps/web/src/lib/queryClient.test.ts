import { DOMAIN_CHANGES } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { EVENT_FRESH_ROOTS, EVENT_FRESH_STALE_MS, REFRESH } from './events';
import { createQueryClient } from './queryClient';

describe('QueryClient 的缺省值（lib/queryClient.ts）', () => {
  const client = createQueryClient();
  /** 这个查询实际用的选项：hook 上写的（own）盖过按第一段设的，再盖过全局缺省 */
  const optionsOf = (queryKey: unknown[], own: { staleTime?: number; gcTime?: number } = {}) => client.defaultQueryOptions({ queryKey, ...own });

  it('过期时间缺省 30 秒；没人用的查询留 30 分钟再回收', () => {
    for (const key of [['summary'], ['stats'], ['settings'], ['jobs'], ['assistant-settings'], ['tagger', 'promotable', 0.5, 'all'], ['search', '未花']]) {
      expect(optionsOf(key).staleTime, String(key[0])).toBe(30_000);
      expect(optionsOf(key).gcTime, String(key[0])).toBe(30 * 60_000);
    }
  });

  it('事件覆盖到的重列表过期时间 10 分钟，子键跟着（角色的 Top、合集的数目、换封面的候选）', () => {
    expect(EVENT_FRESH_STALE_MS).toBe(10 * 60_000);
    const keys: unknown[][] = [
      ['images', { kind: ['illustration'] }],
      ['image', 'i1'],
      ['characters', { sort: 'imageCount' }],
      ['characters', 'top', {}],
      ['character', 'c1'],
      ['character', 'c1', 'cover-candidates', 12],
      ['works', {}],
      ['work', 'w1'],
      ['collections', {}],
      ['collections', 'counts', {}],
      ['collection', 'k1'],
      ['content-kinds'],
    ];
    for (const key of keys) expect(optionsOf(key).staleTime, JSON.stringify(key)).toBe(EVENT_FRESH_STALE_MS);
  });

  it('按第一段整段匹配：image 不带上 image-count；画师、重复组、未识别、汇总、统计都还是 30 秒', () => {
    for (const key of [['image-count', {}], ['artists'], ['duplicates', false], ['unrecognized', 'art'], ['summary'], ['stats'], ['undo-status', 't']])
      expect(optionsOf(key).staleTime, String(key[0])).toBe(30_000);
  });

  it('hook 自己写了时间的照它自己的', () => {
    // 首页别册目录 5 分钟、每日一图不过期、预取下一张 30 秒、移动预览不缓存
    expect(optionsOf(['images', { kind: ['screenshot'] }], { staleTime: 5 * 60_000 }).staleTime).toBe(5 * 60_000);
    expect(optionsOf(['images', 'daily', 'seed', false], { staleTime: Infinity }).staleTime).toBe(Infinity);
    expect(optionsOf(['image', 'i2'], { staleTime: 30_000 }).staleTime).toBe(30_000);
    expect(optionsOf(['move-preview', null], { staleTime: 0, gcTime: 0 })).toMatchObject({ staleTime: 0, gcTime: 0 });
  });

  it('放长的每一种查询：除了查重结果和姿势数据，任何一种变化都会让它过期', () => {
    for (const change of DOMAIN_CHANGES) {
      if (change === 'duplicates.changed' || change === 'pose.changed') continue;
      for (const root of EVENT_FRESH_ROOTS) expect(REFRESH[change], `${change} → ${root}`).toContain(root);
    }
  });

  it('画师、重复组不是每种相关的变化都刷新它们，所以不在放长的名单里', () => {
    const roots: readonly string[] = EVENT_FRESH_ROOTS;
    // 识别顺带写的画师走 evidence.changed；重复组的「默认保留」看合集归属
    expect(REFRESH['evidence.changed']).not.toContain('artists');
    expect(REFRESH['collections.changed']).not.toContain('duplicates');
    expect(roots).not.toContain('artists');
    expect(roots).not.toContain('duplicates');
  });
});
