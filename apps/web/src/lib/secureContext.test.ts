import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from './random';

// 手机用局域网 http 地址打开页面时不是安全上下文：crypto.randomUUID、navigator.clipboard 都是 undefined。
// 这两样只能经 lib/random.ts 的 uuid() 和 lib/clipboard.ts 的 copyText() 用，它们带了退路。

const SRC = path.resolve(import.meta.dirname, '..');
const HELPERS = new Set(['lib/random.ts', 'lib/clipboard.ts']);
const SECURE_ONLY = /crypto\.randomUUID|navigator\.clipboard/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('不在安全上下文里也能用', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('只在带退路的工具函数里用 crypto.randomUUID、navigator.clipboard', () => {
    const offenders = sources(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .filter((rel) => !HELPERS.has(rel) && SECURE_ONLY.test(readFileSync(path.join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('没有 crypto.randomUUID 时 uuid() 用 getRandomValues 生成合法的 v4', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    expect(typeof crypto.randomUUID).toBe('undefined');
    const ids = new Set(Array.from({ length: 200 }, () => uuid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
