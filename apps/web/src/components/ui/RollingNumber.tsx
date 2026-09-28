import { animate, AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { EASE_OUT } from '@/lib/motion';

type Size = 'xl' | 'md' | 'xs';

const nf0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 每一位翻动的时长和错开（秒）；xs 是侧栏的小字，快一点、不错开 */
const TIMING: Record<Size, { duration: number; stagger: number }> = {
  xl: { duration: 0.32, stagger: 0.035 },
  md: { duration: 0.32, stagger: 0.035 },
  xs: { duration: 0.24, stagger: 0 },
};
/** 大跨度的连续补间（原 AnimatedNumber） */
const TWEEN_S = 0.9;
/** 位数变化时新位展开 / 旧位收起 */
const GROW = { duration: 0.24, ease: EASE_OUT };

/**
 * 记住每个数字上次显示的值：第一次出现从 0 滚上来，
 * 之后重新挂载（比如回到首页）只在数值变了的时候从旧值滚到新值，不会每次都重播。
 */
const lastShown = new Map<string, number>();

/** 大跨度：差值 > 10 且超过当前值的 5% 时不再逐位翻，改成连续补间 */
export function isLeap(from: number, to: number): boolean {
  const d = Math.abs(to - from);
  return d > 10 && d > Math.abs(from) * 0.05;
}

export interface Glyph {
  /** 从右往左数的位置，同一位置的 key 稳定（位数变化时只增删左边的位） */
  key: string;
  char: string;
  /** 数字位从个位往上数第几位；非数字（逗号、小数点、单位）为 null */
  place: number | null;
}

/** 格式化后的字符串从右往左拆成字符；数字位可滚动，其余是静态的 */
export function splitGlyphs(text: string): Glyph[] {
  const out: Glyph[] = [];
  let place = 0;
  const chars = [...text];
  for (let i = chars.length - 1, pos = 0; i >= 0; i--, pos++) {
    const char = chars[i]!;
    const digit = char >= '0' && char <= '9';
    out.unshift({ key: digit ? `d${pos}` : `s${pos}:${char}`, char, place: digit ? place++ : null });
  }
  return out;
}

const roundTo = (v: number, digits: 0 | 1) => (digits ? Math.round(v * 10) / 10 : Math.round(v));

/** dir：+1 变大（新数字从下往上翻进来），-1 变小（从上往下） */
const ROLL: Variants = {
  enter: (dir: number) => ({ y: dir > 0 ? '0.55em' : '-0.55em', opacity: 0 }),
  center: { y: '0em', opacity: 1 },
  exit: (dir: number) => ({ y: dir > 0 ? '-0.55em' : '0.55em', opacity: 0 }),
};

/**
 * 机械计数（SEL-18）：数字变化时只有变了的那几位像翻页计数器一样滚动，方向和增减一致。
 * 首次出现、或者跨度很大（isLeap）时沿用连续补间；减少动效时直接替换。
 *
 * - mode='auto'：按上面的规则自动选；'roll'：永远逐位翻，不做补间
 * - appear=false：首次出现直接显示（例如选择栏，本身就有入场动画）
 * - id：记住上次显示的值，重新挂载时从旧值补间过去而不是从 0
 */
export function RollingNumber({
  value,
  size = 'md',
  mode = 'auto',
  digits = 0,
  format,
  id,
  appear = true,
  className,
}: {
  value: number;
  size?: Size;
  mode?: 'auto' | 'roll';
  /** 保留几位小数（补间过程中也按这个取整） */
  digits?: 0 | 1;
  /** 自定义格式化（例如 formatCompact）；数字以外的字符都当静态字 */
  format?: (n: number) => string;
  id?: string;
  appear?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const [shown, setShown] = useState(() => {
    if (!appear || reduce || mode === 'roll') return value;
    const from = (id ? lastShown.get(id) : undefined) ?? 0;
    // 差一两张没必要从头数上来
    return Math.abs(value - from) > 1 ? from : value;
  });
  const [dir, setDir] = useState(1);
  const [tweening, setTweening] = useState(false);
  const shownRef = useRef(shown);
  /** 第一次到位之前都算「首次出现」（StrictMode 下 effect 会跑两遍，不能只看第一次） */
  const settled = useRef(false);
  /** 挂载完之后新增的位才从 0 宽展开，并让数字翻进来 */
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  useEffect(() => {
    if (id) lastShown.set(id, value);
    const from = shownRef.current;
    const show = (v: number) => {
      shownRef.current = v;
      setShown(v);
    };
    if (from === value || reduce) {
      settled.current = true;
      setTweening(false);
      show(value);
      return;
    }
    if (mode === 'auto' && (!settled.current || isLeap(from, value))) {
      setTweening(true);
      const controls = animate(from, value, {
        duration: TWEEN_S,
        ease: EASE_OUT,
        onUpdate: (v) => show(roundTo(v, digits)),
        onComplete: () => {
          settled.current = true;
          show(value);
          setTweening(false);
        },
      });
      return () => controls.stop();
    }
    settled.current = true;
    setDir(value > from ? 1 : -1);
    setTweening(false);
    show(value);
  }, [id, value, reduce, mode, digits]);

  const text = format ? format(roundTo(shown, digits)) : (digits ? nf1 : nf0).format(shown);
  const glyphs = splitGlyphs(text);
  const still = reduce || tweening;
  const timing = TIMING[size];

  return (
    <span aria-live="polite" aria-atomic className={cn('whitespace-nowrap', className)}>
      <span aria-hidden>
        <AnimatePresence initial={false}>
          {glyphs.map((g) => (
            <Column
              key={g.key}
              char={g.char}
              dir={dir}
              still={still}
              grow={!still && mounted.current}
              duration={timing.duration}
              delay={g.place === null ? 0 : g.place * timing.stagger}
            />
          ))}
        </AnimatePresence>
      </span>
      <span className="sr-only">{format ? format(value) : (digits ? nf1 : nf0).format(value)}</span>
    </span>
  );
}

/**
 * 一位：固定 1em 高的窗口，上下裁掉，左右放开（斜体数字的笔画会探出去）。
 * 用 clip-path 而不是 overflow-hidden：后者会把 inline-block 的基线挪到盒子底边，数字整体上浮。
 * 底部 -.1em 外边距：窗口比 .9 的行高多出来的那截不撑高行盒，和换成纯文字时一样高。
 */
function Column({
  char,
  dir,
  still,
  grow,
  duration,
  delay,
}: {
  char: string;
  dir: number;
  still: boolean;
  /** 新出现的位：宽度从 0 展开，数字也翻进来 */
  grow: boolean;
  duration: number;
  delay: number;
}) {
  // 只在挂载时决定要不要翻进来
  const [enter] = useState(grow);
  return (
    <motion.span
      initial={grow ? { width: 0 } : false}
      animate={{ width: 'auto' }}
      exit={still ? { width: 0, transition: { duration: 0 } } : { width: 0, opacity: 0, transition: GROW }}
      transition={GROW}
      className="relative -mb-[.1em] inline-block h-[1em] align-baseline leading-[.9]"
      style={{ clipPath: 'inset(0 -0.3em)' }}
    >
      {still || !/\d/.test(char) ? (
        <span className="inline-block">{char}</span>
      ) : (
        <AnimatePresence mode="popLayout" initial={enter} custom={dir}>
          <motion.span
            key={char}
            custom={dir}
            variants={ROLL}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{
              y: { duration, delay, ease: EASE_OUT },
              opacity: { duration: duration * 0.6, delay, ease: EASE_OUT },
            }}
            className="inline-block"
          >
            {char}
          </motion.span>
        </AnimatePresence>
      )}
    </motion.span>
  );
}
