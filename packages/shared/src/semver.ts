/**
 * 版本号和版本范围（插件清单的 version、engines.emaki，docs/plugins.md 第 8 节）。只认常见的写法，够插件用：
 * - 版本：`1.2.3`，可以带预发布 `1.2.3-beta.1`（比较时预发布排在正式版前面）；
 * - 范围：`*`、`1.2.3`、`=1.2.3`、`>=0.1 <0.2`（空格是「并且」）、`^0.1.17`、`~1.2`、`1.x`、`0.1`，`||` 是「或者」。
 * 写不出来的范围算不合法（清单校验报出来），不猜。
 */

type V = [number, number, number, string];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(s: string): V | null {
  const m = VERSION.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : null;
}

export const validVersion = (s: string): boolean => parseVersion(s) !== null;

function cmp(a: V, b: V): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3] < b[3] ? -1 : 1;
}

export const compareVersions = (a: string, b: string): number => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`不是版本号：${x ? b : a}`);
  return cmp(x, y);
};

type Test = (v: V) => boolean;

/** 「1」「1.2」「1.x」「1.2.3」：缺的部分是 null（任意） */
function partial(s: string): [number, number | null, number | null, string] | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m) return null;
  const n = (x: string | undefined) => (x === undefined || /^[xX*]$/.test(x) ? null : Number(x));
  const major = n(m[1]);
  if (major === null) return [0, null, null, ''];
  const minor = n(m[2]);
  return [major, minor, minor === null ? null : n(m[3]), m[4] ?? ''];
}

function comparator(token: string): Test | null {
  if (token === '*' || token === 'x' || token === 'X') return () => true;
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = partial(m[2]!);
  if (!p) return null;
  const [major, minor, patch, pre] = p;
  if (/^[xX*]/.test(m[2]!)) return op === '' || op === '=' || op === '>=' || op === '<=' ? () => true : null;
  const lo: V = [major, minor ?? 0, patch ?? 0, pre];
  // 部分版本号的上界：1 → <2.0.0，1.2 → <1.3.0
  const nextOf = (): V => (minor === null ? [major + 1, 0, 0, ''] : patch === null ? [major, minor + 1, 0, ''] : [major, minor, patch + 1, '']);
  const ge = (v: V) => cmp(v, lo) >= 0;
  switch (op) {
    case '':
    case '=': {
      if (minor !== null && patch !== null) return (v) => cmp(v, lo) === 0;
      const hi = nextOf();
      return (v) => ge(v) && cmp(v, [hi[0], hi[1], hi[2], '0']) < 0;
    }
    case '>=':
      return ge;
    case '>':
      return minor !== null && patch !== null ? (v) => cmp(v, lo) > 0 : (v) => cmp(v, nextOf()) >= 0;
    case '<':
      // 上界不含它的预发布版：<0.2 不含 0.2.0-beta（预发布号「0」排在所有预发布前面）
      return (v) => cmp(v, lo[3] ? lo : [lo[0], lo[1], lo[2], '0']) < 0;
    case '<=': {
      if (minor !== null && patch !== null) return (v) => cmp(v, lo) <= 0;
      const hi = nextOf();
      return (v) => cmp(v, [hi[0], hi[1], hi[2], '0']) < 0;
    }
    case '^': {
      // ^1.2.3 → <2.0.0；^0.2.3 → <0.3.0；^0.0.3 → <0.0.4
      const hi: V = major > 0 || minor === null ? [major + 1, 0, 0, '0'] : minor > 0 || patch === null ? [0, minor + 1, 0, '0'] : [0, 0, patch + 1, '0'];
      return (v) => ge(v) && cmp(v, hi) < 0;
    }
    case '~': {
      const hi: V = minor === null ? [major + 1, 0, 0, '0'] : [major, minor + 1, 0, '0'];
      return (v) => ge(v) && cmp(v, hi) < 0;
    }
  }
  return null;
}

function compile(range: string): Test | null {
  const alts = range.trim().split(/\s*\|\|\s*/);
  const ors: Test[] = [];
  for (const alt of alts) {
    // 「>= 0.1」这种运算符后面带空格的，先粘回去
    const tokens = alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    const ands: Test[] = [];
    for (const t of tokens) {
      const c = comparator(t);
      if (!c) return null;
      ands.push(c);
    }
    ors.push((v) => ands.every((f) => f(v)));
  }
  return (v) => ors.some((f) => f(v));
}

export const validRange = (range: string): boolean => compile(range) !== null;

/** version 在不在 range 里；写法不对的都算不在 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const test = compile(range);
  return !!v && !!test && test(v);
}
