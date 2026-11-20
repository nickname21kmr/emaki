import { describe, expect, it } from 'vitest';
import { applyGalleryPatch, gatePose, parseGalleryParams } from './useGalleryParams';

const KIND = ['illustration'] as const;
const parse = (s: string) => parseGalleryParams(new URLSearchParams(s), [...KIND]);
const patch = (s: string, p: Parameters<typeof applyGalleryPatch>[1]) => applyGalleryPatch(new URLSearchParams(s), p, [...KIND], true);

describe('姿势参数', () => {
  it('选一类：写 poseClass，不写排序（按典型度），读回来一样', () => {
    const next = patch('kind=illustration&sort=bytes', { poseClass: 'full_03' });
    expect(next.get('poseClass')).toBe('full_03');
    expect(next.get('sort')).toBeNull();
    const f = parse(next.toString());
    expect(f.poseClass).toBe('full_03');
    expect(f.poseOrder).toBe(true);
  });

  it('选着类别时明确选「最近添加」要写进 URL，再换回典型度就去掉', () => {
    const a = patch('kind=illustration&poseClass=mid_02', { sort: 'addedAt' });
    expect(a.get('sort')).toBe('addedAt');
    expect(parse(a.toString()).poseOrder).toBe(false);
    const b = patch(a.toString(), { poseOrder: true });
    expect(b.get('sort')).toBeNull();
    expect(b.get('order')).toBeNull();
  });

  it('找同姿势：poseLike 跟着类别；改别的筛选只丢 poseLike，去掉类别两个都没了', () => {
    const s = 'kind=illustration&poseClass=full_01&poseLike=img42';
    expect(parse(s).poseLike).toBe('img42');
    const r = patch(s, { rating: ['general'] });
    expect(r.get('poseLike')).toBeNull();
    expect(r.get('poseClass')).toBe('full_01');
    const c = patch(s, { poseClass: undefined });
    expect(c.get('poseClass')).toBeNull();
    expect(c.get('poseLike')).toBeNull();
  });

  it('不认的类别 id、没有类别的 poseLike 当没写', () => {
    expect(parse('poseClass=../x').poseClass).toBeUndefined();
    expect(parse('poseLike=img1').poseLike).toBeUndefined();
  });

  it('姿势检索关着：去掉姿势参数，排序回到原来的', () => {
    const f = gatePose(parse('poseClass=bust_04&poseLike=a'), false);
    expect(f.poseClass).toBeUndefined();
    expect(f.poseLike).toBeUndefined();
    expect(f.poseOrder).toBe(false);
    expect(gatePose(parse('poseClass=bust_04'), true).poseClass).toBe('bust_04');
  });
});
