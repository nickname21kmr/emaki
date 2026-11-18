/**
 * 触屏手势的判定（A1，纯函数，gestures.test.ts 测）：看图器的左右滑切图、下滑关闭、捏合缩放、点按 / 双击，
 * 阅读器的滑动翻页，网格的长按多选，底部面板往下拖收起。阈值都在 GESTURE 里，组件只管把指针事件喂进来。
 * 只认 pointerType === 'touch'；鼠标、键盘的行为不经过这里。
 */

export const GESTURE = {
  /** 手指移动超过这个距离（px）才算拖动，之前算点按 / 长按 */
  slop: 10,
  /** 按住不动这么久算长按（ms） */
  longPressMs: 500,
  /** 按下到抬起不超过这么久才算点按（ms） */
  tapMs: 300,
  /** 两次点按的间隔（ms）和距离（px）在这以内算双击 */
  doubleTapMs: 300,
  doubleTapDist: 32,
  /** 左右滑：滑过舞台宽度的这个比例就切，比例换算出来最多要求这么多 px */
  swipeRatio: 0.2,
  swipeMax: 120,
  /** 甩：速度（px/ms）够快、方向一致、至少滑了 minFlick px，距离不够也切 */
  flickVelocity: 0.45,
  minFlick: 24,
  /** 到头了（没有上一张 / 下一张）跟手的比例：阻尼 */
  edgeResistance: 0.35,
  /** 下滑关闭（和底部面板往下拖）：滑过高度的这个比例，最多要求这么多 px；或者够快 */
  dismissRatio: 0.15,
  dismissMax: 140,
  dismissVelocity: 0.5,
  /** 速度按最近这么久（ms）里的移动算 */
  velocityWindow: 100,
} as const;

export interface Point {
  x: number;
  y: number;
}

export interface Sample extends Point {
  t: number;
}

export type Axis = 'x' | 'y' | null;

/** 手指移动过了 slop 才锁定方向：横向为主是 x（切图、翻页），纵向为主是 y（下滑关闭）；之前是 null */
export function lockAxis(dx: number, dy: number, slop: number = GESTURE.slop): Axis {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/** 横向拖动时图片跟手的位移（右滑为正，往上一张）：没有那一张的方向加阻尼 */
export function swipeOffset(dx: number, ends: { hasPrev: boolean; hasNext: boolean }): number {
  const blocked = (dx > 0 && !ends.hasPrev) || (dx < 0 && !ends.hasNext);
  return blocked ? dx * GESTURE.edgeResistance : dx;
}

/**
 * 松手时切不切：-1 上一张、1 下一张、0 弹回。dx 是手指的横向位移（右滑为正 = 上一张），vx 是松手前的速度（px/ms）。
 * 过了距离阈值（宽度的 20%，最多 120px），或者甩得够快且方向一致；到头了的那一边不切。
 */
export function swipeDecision(p: { dx: number; vx: number; width: number; hasPrev: boolean; hasNext: boolean }): -1 | 0 | 1 {
  const dist = Math.min(GESTURE.swipeMax, p.width * GESTURE.swipeRatio);
  const flick = Math.abs(p.vx) >= GESTURE.flickVelocity && Math.abs(p.dx) >= GESTURE.minFlick && Math.sign(p.vx) === Math.sign(p.dx);
  if (Math.abs(p.dx) < dist && !flick) return 0;
  if (p.dx > 0) return p.hasPrev ? -1 : 0;
  return p.hasNext ? 1 : 0;
}

/** 往下拖（下滑关闭看图器、收起底部面板）松手时：1 收起，0 弹回。dy 往下为正，vy px/ms，height 是被拖的东西的高度 */
export function dragDecision(dy: number, vy: number, height: number): 0 | 1 {
  if (dy <= 0) return 0;
  const dist = Math.min(GESTURE.dismissMax, height * GESTURE.dismissRatio);
  if (dy >= dist) return 1;
  return vy >= GESTURE.dismissVelocity && dy >= GESTURE.minFlick ? 1 : 0;
}

/** 下滑关闭时的样子：拖到高度的一半时图片缩到 0.8、背景淡到 0；往上拖不变 */
export function dismissVisual(dy: number, height: number): { progress: number; scale: number; opacity: number } {
  const progress = Math.min(1, Math.max(0, dy) / Math.max(1, height * 0.5));
  return { progress, scale: 1 - 0.2 * progress, opacity: 1 - progress };
}

/**
 * 捏合缩放（以两指中点为中心）：开始时的缩放 z0、两指中点 mid0（相对舞台中心）、两指距离 d0；
 * 现在的中点 mid、距离 d。缩放按距离之比，开始时中点下的那一点跟着现在的中点走（两指一起拖也能平移）。
 * 缩放限制在 [minScale, maxScale]；平移的边界由调用方再 clampPan。
 */
export function pinchZoom(
  z0: { scale: number; x: number; y: number },
  mid0: Point,
  d0: number,
  mid: Point,
  d: number,
  minScale: number,
  maxScale: number,
): { scale: number; x: number; y: number } {
  const scale = Math.min(maxScale, Math.max(minScale, z0.scale * (d / Math.max(1, d0))));
  // 开始时中点下的那一点在图片盒子里的位置（缩放前的坐标）：q = (mid0 - t0) / s0
  const qx = (mid0.x - z0.x) / z0.scale;
  const qy = (mid0.y - z0.y) / z0.scale;
  return { scale, x: mid.x - qx * scale, y: mid.y - qy * scale };
}

export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 一次按下算不算点按：没怎么动、没按太久 */
export const isTap = (dt: number, moved: number): boolean => dt <= GESTURE.tapMs && moved < GESTURE.slop;

/** 这次点按和上一次能不能凑成双击 */
export function isDoubleTap(prev: Sample | null, cur: Sample): boolean {
  if (!prev) return false;
  return cur.t - prev.t <= GESTURE.doubleTapMs && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= GESTURE.doubleTapDist;
}

/** 记一个移动样本：只留最近 velocityWindow 毫秒里的（至少留两个） */
export function pushSample(samples: Sample[], s: Sample): Sample[] {
  const next = [...samples, s];
  while (next.length > 2 && s.t - next[0]!.t > GESTURE.velocityWindow) next.shift();
  return next;
}

/** 最近一段的速度（px/ms）；样本不够时是 0 */
export function velocityOf(samples: readonly Sample[]): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const a = samples[0]!;
  const b = samples[samples.length - 1]!;
  const dt = b.t - a.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
}

/**
 * 阅读器、看图器里的点按落在哪一块：左三分之一、中间、右三分之一（阅读器点两边翻页、中间切换界面）。
 * x 是相对容器左边的位置。
 */
export function tapZone(x: number, width: number): 'left' | 'center' | 'right' {
  if (x < width / 3) return 'left';
  if (x > (width * 2) / 3) return 'right';
  return 'center';
}
