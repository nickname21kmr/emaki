import { useEffect, useMemo, useRef, useState } from 'react';

export interface DoneInfo {
  /** 原地显示的那句话，例如「已合并」「已整理」 */
  label: string;
  /** 行内「撤销」用的 token；没有就不显示撤销 */
  token: string | null;
}

/**
 * 刷新后的列表和上一次显示的列表合在一起：处理过的行即使已经不在新列表里，也留在原来的位置，
 * 免得下一行挪到鼠标下面；其余按新列表来，新出现的接在后面。
 */
export function keepInPlace<T>(prev: readonly T[], next: readonly T[], keep: (key: string) => boolean, keyOf: (t: T) => string): T[] {
  const fresh = new Map(next.map((t) => [keyOf(t), t] as const));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const t of prev) {
    const k = keyOf(t);
    const now = fresh.get(k);
    if (now !== undefined) out.push(now);
    else if (keep(k)) out.push(t);
    else continue;
    seen.add(k);
  }
  for (const t of next) if (!seen.has(keyOf(t))) out.push(t);
  return out;
}

/**
 * 处理过的行原地变成「已处理 · 撤销」，不立刻收起：鼠标离开列表几秒后才一起收起。
 * 撤销后（行内按钮或 Ctrl+Z）这一项回到列表里，自动恢复成普通的行。
 */
export function useDoneRows<T>(items: readonly T[], keyOf: (t: T) => string, collapseMs = 3000) {
  const [done, setDone] = useState<ReadonlyMap<string, DoneInfo>>(() => new Map());
  const [hover, setHover] = useState(false);
  const prev = useRef<T[]>([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => keepInPlace(prev.current, items, (k) => done.has(k), keyOf), [items, done]);
  useEffect(() => {
    prev.current = rows;
  });

  // 处理过的那项从列表里消失后又回来了：说明撤销了，恢复成普通的行
  const left = useRef(new Set<string>());
  useEffect(() => {
    if (!done.size) return;
    const present = new Set(items.map(keyOf));
    const back: string[] = [];
    for (const k of done.keys()) {
      if (!present.has(k)) left.current.add(k);
      else if (left.current.has(k)) back.push(k);
    }
    if (back.length) {
      for (const k of back) left.current.delete(k);
      setDone((m) => new Map([...m].filter(([k]) => !back.includes(k))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, done]);

  useEffect(() => {
    if (!done.size || hover) return;
    const t = window.setTimeout(() => {
      left.current.clear();
      setDone(new Map());
    }, collapseMs);
    return () => window.clearTimeout(t);
  }, [done, hover, collapseMs]);

  return {
    rows,
    done,
    mark: (key: string, info: DoneInfo) => setDone((m) => new Map(m).set(key, info)),
    unmark: (key: string) =>
      setDone((m) => {
        if (!m.has(key)) return m;
        const next = new Map(m);
        next.delete(key);
        return next;
      }),
    /** 挂在列表外层：鼠标在列表上时不收起 */
    hoverProps: { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) },
  };
}
