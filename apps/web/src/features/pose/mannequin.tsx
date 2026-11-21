import type { PoseWearPose, PoseWearSkeleton } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { request } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * 没有线稿的姿势：按随包的骨架（pose.posewearSkeleton）画一个灰色的小木偶。
 * 蛋形的头带十字辅助线，四肢是一头粗一头细的圆头条，关节一个小圈；双人画两个。
 * 画框和线稿一样是 3:4，颜色全用主题变量，浅色、深色都成立。
 */

type Pt = [number, number, number];
type XY = [number, number];

export interface MannequinShape {
  /** limb：四肢、躯干、脖子（填纸色、描边）；joint：关节小圈；head：头；guide：头上的辅助线 */
  kind: 'limb' | 'joint' | 'head' | 'guide';
  d: string;
  /** 头和辅助线：移到头的中心、按朝向转过去 */
  transform?: string;
  /** 第几个人（双人里第二个人描边深一点） */
  person: number;
}

const f = (n: number) => (Math.round(n * 10000) / 10000).toString();
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a: XY, b: XY): XY => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const avg = (ps: XY[]): XY => [ps.reduce((s, q) => s + q[0], 0) / ps.length, ps.reduce((s, q) => s + q[1], 0) / ps.length];

function circle(c: XY, r: number): string {
  return `M${f(c[0] - r)} ${f(c[1])}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
}

/** 一头粗一头细的圆头条：两个圆和两条外公切线 */
export function taper(a: XY, ra: number, b: XY, rb: number): string {
  const d = dist(a, b);
  if (d < 1e-6 || d <= Math.abs(ra - rb)) return circle(ra >= rb ? a : b, Math.max(ra, rb));
  const t = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const al = Math.acos((ra - rb) / d);
  const on = (c: XY, r: number, ang: number): XY => [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
  const a1 = on(a, ra, t + al);
  const b1 = on(b, rb, t + al);
  const b2 = on(b, rb, t - al);
  const a2 = on(a, ra, t - al);
  const big2 = 2 * al > Math.PI ? 1 : 0;
  const big1 = 2 * Math.PI - 2 * al > Math.PI ? 1 : 0;
  return `M${f(a1[0])} ${f(a1[1])}L${f(b1[0])} ${f(b1[1])}A${f(rb)} ${f(rb)} 0 ${big2} 0 ${f(b2[0])} ${f(b2[1])}L${f(a2[0])} ${f(a2[1])}A${f(ra)} ${f(ra)} 0 ${big1} 0 ${f(a1[0])} ${f(a1[1])}Z`;
}

/** 一个人的形状，按画的先后：躯干、腿、胳膊、脖子、头。points 是 COCO 17 点 + 脚 6 点，thr 以下的点不用 */
export function personShapes(points: readonly Pt[], thr: number, person = 0): MannequinShape[] {
  const ok = (i: number) => (points[i]?.[2] ?? 0) >= thr;
  const p = (i: number): XY => [points[i]![0], points[i]![1]];
  const out: MannequinShape[] = [];
  const add = (kind: MannequinShape['kind'], d: string, transform?: string) => out.push(transform ? { kind, d, transform, person } : { kind, d, person });

  const shoulders = ok(5) && ok(6) ? mid(p(5), p(6)) : null;
  const hips = ok(11) && ok(12) ? mid(p(11), p(12)) : null;
  const face = [0, 1, 2, 3, 4].filter(ok);
  const ears = [3, 4].filter(ok);

  // 头宽：几种估法取大的（侧面时肩宽很小、俯仰时躯干变短，各自只会估小）
  const guesses: number[] = [];
  if (ears.length === 2) guesses.push(dist(p(3), p(4)) * 1.25);
  if (shoulders) guesses.push(dist(p(5), p(6)) * 0.55);
  if (shoulders && hips) guesses.push(dist(shoulders, hips) * 0.42);
  for (const [a, b] of [[5, 7], [6, 8], [11, 13], [12, 14]] as const) if (ok(a) && ok(b)) guesses.push(dist(p(a), p(b)) * (a < 11 ? 0.62 : 0.42));
  if (!guesses.length) {
    // 只剩脸上的几个点：按点散开的程度
    if (face.length < 2) return out;
    guesses.push(Math.max(...face.flatMap((i) => face.map((j) => dist(p(i), p(j))))) * 1.6);
  }
  const hw = Math.min(0.24, Math.max(0.035, Math.max(...guesses)));

  // 连得上身体的点：只从肩、髋往外画，断开的半截（只看得到的一只脚、一截小腿）不画，免得飘在空中
  const linked = new Set<number>();
  const seg = (a: number, b: number, ra: number, rb: number) => {
    if (!linked.has(a) || !ok(b)) return;
    add('limb', taper(p(a), ra * hw, p(b), rb * hw));
    linked.add(b);
  };
  const joint = (i: number) => {
    if (linked.has(i)) add('joint', circle(p(i), 0.075 * hw));
  };
  // 垂直于肩线的方向（down：朝下的那个）
  const across = (down: boolean): XY => {
    const sx = p(6)[0] - p(5)[0];
    const sy = p(6)[1] - p(5)[1];
    const n = Math.hypot(sx, sy) || 1;
    const v: XY = [-sy / n, sx / n];
    return v[1] < 0 === down ? [-v[0], -v[1]] : v;
  };

  // 躯干：肩、髋四个点连成的块；没有髋就从肩往下画一截。四肢从看得到的肩、髋开始
  for (const i of [5, 6, 11, 12]) if (ok(i)) linked.add(i);
  if (shoulders && hips) {
    const c = mid(shoulders, hips);
    const push = (q: XY, k: number): XY => [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k];
    const pts = [push(p(5), 1.06), push(p(6), 1.06), push(p(12), 1.04), push(p(11), 1.04)];
    add('limb', `M${pts.map((q) => `${f(q[0])} ${f(q[1])}`).join('L')}Z`);
  } else if (shoulders) {
    const dn = across(true);
    add('limb', taper(shoulders, 0.42 * hw, [shoulders[0] + dn[0] * hw * 1.6, shoulders[1] + dn[1] * hw * 1.6], 0.3 * hw));
  }

  // 腿：大腿、小腿、脚（脚尖取大脚趾、小脚趾的中点）
  for (const [hip, knee, ankle, t1, t2] of [[11, 13, 15, 17, 18], [12, 14, 16, 20, 21]] as const) {
    seg(hip, knee, 0.26, 0.17);
    seg(knee, ankle, 0.17, 0.1);
    if (linked.has(ankle) && (ok(t1) || ok(t2))) {
      const toe = ok(t1) && ok(t2) ? mid(p(t1), p(t2)) : p(ok(t1) ? t1 : t2);
      add('limb', taper(p(ankle), 0.1 * hw, toe, 0.07 * hw));
    }
    joint(hip);
    joint(knee);
    joint(ankle);
  }

  // 胳膊：上臂、前臂，手是顺着前臂往外的一小截
  for (const [sh, el, wr] of [[5, 7, 9], [6, 8, 10]] as const) {
    seg(sh, el, 0.17, 0.12);
    seg(el, wr, 0.12, 0.09);
    if (linked.has(el) && linked.has(wr)) {
      const e = p(el);
      const w = p(wr);
      const k = (0.32 * hw) / (dist(e, w) || 1);
      add('limb', taper(w, 0.1 * hw, [w[0] + (w[0] - e[0]) * k, w[1] + (w[1] - e[1]) * k], 0.08 * hw));
    }
    joint(sh);
    joint(el);
    joint(wr);
  }

  // 头：朝向 = 脖子根到脸的方向
  const rx = hw / 2;
  const ry = rx * 1.22;
  const fc: XY | null = ears.length === 2 ? mid(p(3), p(4)) : face.length ? avg(face.map(p)) : null;
  let up: XY = [0, -1];
  let center: XY | null = null;
  if (fc) {
    if (shoulders) {
      const v: XY = [fc[0] - shoulders[0], fc[1] - shoulders[1]];
      const n = Math.hypot(v[0], v[1]);
      if (n > 1e-6) up = [v[0] / n, v[1] / n];
    }
    center = [fc[0] + up[0] * ry * 0.12, fc[1] + up[1] * ry * 0.12];
  } else if (shoulders) {
    // 看不到脸（背面）：放在肩膀上面
    up = across(false);
    center = [shoulders[0] + up[0] * (ry + hw * 0.35), shoulders[1] + up[1] * (ry + hw * 0.35)];
  }
  if (!center) return out;
  const chin: XY = [center[0] - up[0] * ry, center[1] - up[1] * ry];
  if (shoulders) add('limb', taper(shoulders, 0.13 * hw, chin, 0.11 * hw));
  const deg = (Math.atan2(up[0], -up[1]) * 180) / Math.PI;
  const tr = `translate(${f(center[0])} ${f(center[1])}) rotate(${f(deg)})`;
  const egg = [
    `M0 ${f(-ry)}`,
    `C${f(0.56 * rx)} ${f(-ry)} ${f(rx)} ${f(-0.62 * ry)} ${f(rx)} ${f(-0.1 * ry)}`,
    `C${f(rx)} ${f(0.45 * ry)} ${f(0.5 * rx)} ${f(ry)} 0 ${f(ry)}`,
    `C${f(-0.5 * rx)} ${f(ry)} ${f(-rx)} ${f(0.45 * ry)} ${f(-rx)} ${f(-0.1 * ry)}`,
    `C${f(-rx)} ${f(-0.62 * ry)} ${f(-0.56 * rx)} ${f(-ry)} 0 ${f(-ry)}Z`,
  ].join('');
  add('head', egg, tr);
  // 十字辅助线：横的在眼睛那一高度，竖的按鼻子偏多少弯过去（背面看不到鼻子就不画）
  const eyeY = 0.12 * ry;
  const hx = rx * 0.97;
  add('guide', `M${f(-hx)} ${f(eyeY)}A${f(hx)} ${f(ry * 0.24)} 0 0 0 ${f(hx)} ${f(eyeY)}`, tr);
  if (ok(0)) {
    const r: XY = [-up[1], up[0]];
    const off = Math.max(-0.9, Math.min(0.9, ((p(0)[0] - center[0]) * r[0] + (p(0)[1] - center[1]) * r[1]) / rx));
    const d = Math.abs(off) < 0.06 ? `M0 ${f(-ry)}L0 ${f(ry)}` : `M0 ${f(-ry)}A${f(Math.abs(off) * rx)} ${f(ry)} 0 0 ${off > 0 ? 1 : 0} 0 ${f(ry)}`;
    add('guide', d, tr);
  }
  return out;
}

/** 线稿上没检测到人时的占位：一个站着的人（双人两个），画得很淡 */
const STANDING: Pt[] = [
  [0.375, 0.165, 1], [0.362, 0.152, 1], [0.388, 0.152, 1], [0.345, 0.16, 1], [0.405, 0.16, 1],
  [0.315, 0.265, 1], [0.435, 0.265, 1], [0.3, 0.39, 1], [0.45, 0.39, 1], [0.295, 0.5, 1], [0.455, 0.5, 1],
  [0.34, 0.52, 1], [0.41, 0.52, 1], [0.335, 0.7, 1], [0.415, 0.7, 1], [0.335, 0.875, 1], [0.415, 0.875, 1],
  [0.315, 0.9, 1], [0.32, 0.9, 1], [0.34, 0.885, 1], [0.435, 0.9, 1], [0.43, 0.9, 1], [0.41, 0.885, 1],
];

export function placeholderPersons(pair: boolean): Pt[][] {
  if (!pair) return [STANDING];
  const shift = (dx: number) => STANDING.map(([x, y, c]) => [0.375 + (x - 0.375) * 0.9 + dx, 0.1 + (y - 0.1) * 0.9, c] as Pt);
  return [shift(-0.14), shift(0.14)];
}

/** 整张图的形状：每个人一组 */
export function mannequinShapes(skel: Pick<PoseWearSkeleton, 'persons' | 'minConfidence'>): MannequinShape[] {
  return skel.persons.flatMap((q, i) => personShapes(q.points, skel.minConfidence, i));
}

// ------------------------------------------------------------------ 组件

/** 骨架随包不变：长缓存；键不用 'pose' 开头，免得提取时每批 pose.changed 都重拉 */
function useSkeleton(url: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['posewear-skeleton', url],
    queryFn: () => request<PoseWearSkeleton>('GET', url!.replace(/^\/api/, '')),
    enabled: enabled && !!url,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
  });
}

/** 滚到附近才拉骨架（挑姿势的对话框里有两百多格） */
function useNear<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/**
 * 小木偶。url 是骨架地址（pose.skeletonUrl，可以带 ?view=）；pair 决定画不出时的占位是一个人还是两个。
 * mini：很小的地方（工具条 chip、看图器那一行）只画实心的剪影
 */
export function PoseMannequin({ url, pair, mini = false, className }: { url: string | undefined; pair: boolean; mini?: boolean; className?: string }) {
  const [ref, near] = useNear<HTMLSpanElement>();
  const q = useSkeleton(url, near);
  const skel = q.data;
  const w = skel && skel.w > 0 ? skel.w : 0.75;
  const h = skel && skel.h > 0 ? skel.h : 1;
  const empty = !!skel && skel.persons.length === 0;
  const stub = empty || q.isError;
  const shapes = skel && !empty ? mannequinShapes(skel) : stub ? mannequinShapes({ persons: placeholderPersons(pair).map((points) => ({ points })), minConfidence: 0.3 }) : [];
  return (
    <span
      ref={ref}
      role="img"
      aria-label={stub ? '没有封面' : '没有封面，按骨架画的小人'}
      className={cn('block aspect-[3/4] shrink-0 overflow-hidden bg-sunken', className)}
    >
      {shapes.length > 0 && (
        <svg viewBox={`0 0 ${f(w)} ${f(h)}`} className={cn('block size-full', stub && 'opacity-40')} aria-hidden>
          {mini ? <MiniFigure shapes={shapes} /> : <FullFigure shapes={shapes} />}
        </svg>
      )}
    </span>
  );
}

function FullFigure({ shapes }: { shapes: MannequinShape[] }) {
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      {shapes.map((s, i) => {
        const line = s.person === 1 ? 'var(--c-fg)' : 'var(--c-fg-muted)';
        if (s.kind === 'guide')
          return <path key={i} transform={s.transform} d={s.d} fill="none" stroke={line} strokeOpacity={0.55} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />;
        return (
          <path
            key={i}
            transform={s.transform}
            d={s.d}
            fill="var(--c-raised)"
            stroke={line}
            strokeWidth={s.kind === 'joint' ? 0.9 : 1.15}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </g>
  );
}

/** 很小的时候：只填色，不描边、不画关节和辅助线 */
function MiniFigure({ shapes }: { shapes: MannequinShape[] }) {
  return (
    <g fill="var(--c-fg-muted)">
      {shapes
        .filter((s) => s.kind === 'limb' || s.kind === 'head')
        .map((s, i) => (
          <path key={i} transform={s.transform} d={s.d} />
        ))}
    </g>
  );
}

/**
 * 姿势的封面：有线稿用线稿（白纸，深色主题里也是白纸），没有或者加载失败就画小木偶。
 * view 给了就画那个视角（看图器里匹配上的视角）
 */
export function PoseWearCover({
  pose,
  src,
  hasCover,
  view,
  mini,
  className,
}: {
  pose: Pick<PoseWearPose, 'set' | 'skeletonUrl'>;
  /** 线稿地址（thumbUrl 或 viewThumbUrl） */
  src: string;
  hasCover: boolean;
  view?: string | undefined;
  mini?: boolean;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!hasCover || broken) {
    const url = view ? `${pose.skeletonUrl}?view=${encodeURIComponent(view)}` : pose.skeletonUrl;
    return <PoseMannequin url={url} pair={pose.set === 'pair'} mini={mini} className={className} />;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setBroken(true)}
      className={cn('aspect-[3/4] shrink-0 bg-white object-contain', className)}
    />
  );
}
