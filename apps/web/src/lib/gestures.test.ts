import { describe, expect, it } from 'vitest';
import { swipePagerDecision as readerSwipeDecision } from './pager/useSwipePager';
import {
  GESTURE,
  dismissVisual,
  dragDecision,
  isDoubleTap,
  isTap,
  lockAxis,
  pinchZoom,
  pushSample,
  swipeDecision,
  swipeOffset,
  tapZone,
  velocityOf,
} from './gestures';

// A1 的触屏手势：判定都是纯函数，组件（看图器、阅读器、底部面板、长按）只管喂指针事件

describe('方向锁定和点按', () => {
  it('动了不到 slop 不锁定；过了以后横向为主是 x，纵向为主是 y', () => {
    expect(lockAxis(5, 5)).toBeNull();
    expect(lockAxis(12, 3)).toBe('x');
    expect(lockAxis(-12, 3)).toBe('x');
    expect(lockAxis(4, 15)).toBe('y');
  });

  it('点按：没怎么动、按的时间比长按短；双击：间隔和距离都够近', () => {
    expect(isTap(120, 2)).toBe(true);
    expect(isTap(120, GESTURE.slop)).toBe(false);
    expect(isTap(GESTURE.longPressMs + 1, 0)).toBe(false);
    const first = { x: 100, y: 100, t: 0 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { x: 110, y: 104, t: 200 })).toBe(true);
    expect(isDoubleTap(first, { x: 110, y: 104, t: GESTURE.doubleTapMs + 1 })).toBe(false);
    expect(isDoubleTap(first, { x: 160, y: 100, t: 100 })).toBe(false);
  });

  it('阅读器的点按区：左右三分之一和中间', () => {
    expect([10, 129, 130, 195, 261, 380].map((x) => tapZone(x, 390))).toEqual(['left', 'left', 'center', 'center', 'right', 'right']);
  });
});

describe('左右滑切图', () => {
  const ends = { hasPrev: true, hasNext: true };
  it('跟手：两头都有图时 1:1；到头了的方向加阻尼', () => {
    expect(swipeOffset(-100, ends)).toBe(-100);
    expect(swipeOffset(100, { hasPrev: false, hasNext: true })).toBe(100 * GESTURE.edgeResistance);
    expect(swipeOffset(-100, { hasPrev: true, hasNext: false })).toBe(-100 * GESTURE.edgeResistance);
  });

  it('过了距离阈值（宽度的 20%，最多 120px）就切：左滑下一张，右滑上一张', () => {
    // 手机 390 宽：阈值 78
    expect(swipeDecision({ dx: -80, vx: 0, width: 390, ...ends })).toBe(1);
    expect(swipeDecision({ dx: 80, vx: 0, width: 390, ...ends })).toBe(-1);
    expect(swipeDecision({ dx: -70, vx: 0, width: 390, ...ends })).toBe(0);
    // 平板横屏 1280 宽：阈值封顶 120
    expect(swipeDecision({ dx: -119, vx: 0, width: 1280, ...ends })).toBe(0);
    expect(swipeDecision({ dx: -121, vx: 0, width: 1280, ...ends })).toBe(1);
  });

  it('甩：距离不够但速度够快、方向一致、至少滑了 24px 也切；反方向的速度不算', () => {
    expect(swipeDecision({ dx: -40, vx: -0.8, width: 390, ...ends })).toBe(1);
    expect(swipeDecision({ dx: -40, vx: 0.8, width: 390, ...ends })).toBe(0);
    expect(swipeDecision({ dx: -10, vx: -2, width: 390, ...ends })).toBe(0);
  });

  it('到头了不切（弹回）', () => {
    expect(swipeDecision({ dx: 200, vx: 1, width: 390, hasPrev: false, hasNext: true })).toBe(0);
    expect(swipeDecision({ dx: -200, vx: -1, width: 390, hasPrev: true, hasNext: false })).toBe(0);
  });

  it('阅读器：左开时左滑是下一页；右开（本子）时反过来，右滑是下一页；第一页往回不翻', () => {
    expect(readerSwipeDecision({ dx: -100, vx: 0, width: 390, rtl: false, hasPrev: true })).toBe('forward');
    expect(readerSwipeDecision({ dx: 100, vx: 0, width: 390, rtl: false, hasPrev: true })).toBe('back');
    expect(readerSwipeDecision({ dx: 100, vx: 0, width: 390, rtl: true, hasPrev: true })).toBe('forward');
    expect(readerSwipeDecision({ dx: -100, vx: 0, width: 390, rtl: true, hasPrev: true })).toBe('back');
    expect(readerSwipeDecision({ dx: 100, vx: 0, width: 390, rtl: false, hasPrev: false })).toBeNull();
    expect(readerSwipeDecision({ dx: -30, vx: 0, width: 390, rtl: false, hasPrev: true })).toBeNull();
    // 未识别的最后一张：没有下一张可跳
    expect(readerSwipeDecision({ dx: -100, vx: 0, width: 390, rtl: false, hasPrev: true, hasNext: false })).toBeNull();
  });
});

describe('下滑关闭 / 往下拖收起', () => {
  it('过了距离（高度的 15%，最多 140px）或者够快就收起；往上不收', () => {
    expect(dragDecision(130, 0, 844)).toBe(1); // 844 × 0.15 = 126.6
    expect(dragDecision(120, 0, 844)).toBe(0);
    expect(dragDecision(141, 0, 2000)).toBe(1);
    expect(dragDecision(40, 0.9, 844)).toBe(1);
    expect(dragDecision(10, 2, 844)).toBe(0);
    expect(dragDecision(-200, -2, 844)).toBe(0);
  });

  it('跟手的样子：拖到一半高度时缩到 0.8、背景淡完；往上拖不变', () => {
    expect(dismissVisual(0, 800)).toEqual({ progress: 0, scale: 1, opacity: 1 });
    expect(dismissVisual(200, 800)).toEqual({ progress: 0.5, scale: 0.9, opacity: 0.5 });
    expect(dismissVisual(1000, 800)).toEqual({ progress: 1, scale: 0.8, opacity: 0 });
    expect(dismissVisual(-50, 800).scale).toBe(1);
  });
});

describe('捏合缩放', () => {
  const z0 = { scale: 1, x: 0, y: 0 };
  it('缩放按两指距离之比，限制在 [1, max]', () => {
    expect(pinchZoom(z0, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 250, 1, 4).scale).toBe(2.5);
    expect(pinchZoom(z0, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 900, 1, 4).scale).toBe(4);
    expect(pinchZoom(z0, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 50, 1, 4).scale).toBe(1);
  });

  it('以两指中点为中心：开始时中点下的那一点，缩放后还在中点下', () => {
    const mid = { x: -75, y: -90 };
    const z = pinchZoom(z0, mid, 60, mid, 200, 1, 10);
    // 屏幕上的点 = t + q·s，q 是图片盒子里的那一点（开始时 = mid）
    expect(z.x + mid.x * z.scale).toBeCloseTo(mid.x);
    expect(z.y + mid.y * z.scale).toBeCloseTo(mid.y);
    // 在左上方捏：图片往右下移
    expect(z.x).toBeGreaterThan(0);
    expect(z.y).toBeGreaterThan(0);
  });

  it('放大着再捏、两指一起挪：那一点跟着新的中点走', () => {
    const start = { scale: 2, x: 40, y: -20 };
    const mid0 = { x: 10, y: 10 };
    const mid1 = { x: 60, y: 30 };
    const z = pinchZoom(start, mid0, 100, mid1, 150, 1, 10);
    const qx = (mid0.x - start.x) / start.scale;
    const qy = (mid0.y - start.y) / start.scale;
    expect(z.scale).toBe(3);
    expect(z.x + qx * z.scale).toBeCloseTo(mid1.x);
    expect(z.y + qy * z.scale).toBeCloseTo(mid1.y);
  });
});

describe('速度', () => {
  it('按最近 100ms 里的移动算；样本不够是 0', () => {
    expect(velocityOf([{ x: 0, y: 0, t: 0 }])).toEqual({ vx: 0, vy: 0 });
    let s = [{ x: 0, y: 0, t: 0 }];
    for (let t = 16; t <= 320; t += 16) s = pushSample(s, { x: t, y: -t / 2, t });
    // 前面的样本已经丢掉了，只看最近一段：1 px/ms 向右、0.5 px/ms 向上
    expect(s[0]!.t).toBeGreaterThanOrEqual(320 - GESTURE.velocityWindow - 16);
    const v = velocityOf(s);
    expect(v.vx).toBeCloseTo(1);
    expect(v.vy).toBeCloseTo(-0.5);
  });
});
