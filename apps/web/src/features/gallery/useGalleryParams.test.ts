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

describe('PoseWear 姿势参数（?pwPose=）', () => {
  it('选一个姿势：写 pwPose，不写排序（按匹配名次），读回来一样', () => {
    const next = patch('kind=illustration&sort=bytes', { pwPose: 'full_sexy_P012' });
    expect(next.get('pwPose')).toBe('full_sexy_P012');
    expect(next.get('sort')).toBeNull();
    const f = parse(next.toString());
    expect([f.pwPose, f.poseOrder]).toEqual(['full_sexy_P012', true]);
  });

  it('明确选了排序就按排序（最近添加也写出来），再选回按名次', () => {
    const a = patch('kind=illustration&pwPose=upper80v2_P003', { sort: 'addedAt' });
    expect(a.get('sort')).toBe('addedAt');
    expect(parse(a.toString()).poseOrder).toBe(false);
    expect(parse(patch(a.toString(), { poseOrder: true }).toString()).poseOrder).toBe(true);
  });

  it('和 51 类只能选一个；去掉姿势排序也去掉', () => {
    const a = patch('kind=illustration&poseClass=full_01&poseLike=9', { pwPose: 'full_single_P001' });
    expect([a.get('pwPose'), a.get('poseClass'), a.get('poseLike')]).toEqual(['full_single_P001', null, null]);
    const b = patch(a.toString(), { poseClass: 'mid_02' });
    expect([b.get('pwPose'), b.get('poseClass')]).toEqual([null, 'mid_02']);
    const c = parse(patch(a.toString(), { pwPose: undefined }).toString());
    expect([c.pwPose, c.poseOrder]).toEqual([undefined, false]);
  });

  it('不认的 id 当没写（双人的 pair60 也不认）', () => {
    expect(parse('pwPose=pair60_P001').pwPose).toBeUndefined();
    expect(parse('pwPose=../../x').pwPose).toBeUndefined();
    expect(parse('pwPose=full_single_P1').pwPose).toBeUndefined();
  });

  it('关着时都去掉；51 类没显示时只去掉类别，PoseWear 留着', () => {
    expect(gatePose(parse('pwPose=full_single_P001'), false).pwPose).toBeUndefined();
    const f = gatePose(parse('pwPose=full_single_P001'), true, false);
    expect([f.pwPose, f.poseOrder]).toEqual(['full_single_P001', true]);
    const g = gatePose(parse('poseClass=bust_04&poseLike=a'), true, false);
    expect([g.poseClass, g.poseLike, g.poseOrder]).toEqual([undefined, undefined, false]);
  });
});
