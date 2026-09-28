/**
 * 从 related_tag 的 copyright 候选里挑出角色的作品（纯函数）。
 * 候选有噪音（comiket_106 这种展会也是 category 3），只能靠 frequency 阈值过滤。
 */
export interface CopyrightCandidate {
  name: string;
  frequency: number;
  postCount: number;
  /** implication 的传递闭包 */
  implies: string[];
}

export function pickCopyrights(
  cands: CopyrightCandidate[],
  o = { minFrequency: 0.3, secondaryMin: 0.5, tieEpsilon: 0.02, max: 3 },
): string[] {
  const c = cands
    .filter((x) => x.frequency >= o.minFrequency)
    .sort((a, b) => b.frequency - a.frequency || b.postCount - a.postCount);
  const top = c[0];
  if (!top) return [];
  // 并列里被其他并列候选 implies 的是上层系列；剩下的第一个（更具体的）是主作品
  const tied = c.filter((x) => top.frequency - x.frequency <= o.tieEpsilon);
  const tiedNames = new Set(tied.map((x) => x.name));
  const umbrellas = new Set(tied.flatMap((x) => x.implies.filter((n) => tiedNames.has(n))));
  const primary = tied.find((x) => !umbrellas.has(x.name)) ?? top;
  const out = [primary.name];
  for (const x of c) {
    if (out.length >= o.max) break;
    if (x.name === primary.name || x.frequency < o.secondaryMin) continue;
    if (x.implies.includes(primary.name)) continue; // implies 主作品的是动画版等子作品
    out.push(x.name);
  }
  return out;
}

/** 离线兜底：mika_(blue_archive) → 限定词 blue_archive → 查 copyright */
export function guessCopyrightFromQualifier(tag: string, lookup: (qualifier: string) => string | null): string | null {
  const m = /_\(([^()]+)\)$/.exec(tag);
  return m ? lookup(m[1]!) : null;
}
