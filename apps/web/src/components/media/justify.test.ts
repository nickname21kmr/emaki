import { describe, expect, it } from 'vitest';
import { justify } from './justify';

// 两端对齐行（ImageGrid）。A1 给窄屏加了 balance：一行只放得下两三张时，不让最后挤进来的宽图把整行压扁

const portrait = { width: 700, height: 1000 };
const wide = { width: 1620, height: 1000 };
const items = [portrait, portrait, portrait, wide, portrait, portrait, portrait];

describe('justify', () => {
  it('默认（电脑上）照旧：加到超过容器宽才收行，每行铺满宽度，最后一行用目标行高', () => {
    const rows = justify(items, 358, 160, 4);
    // 三张竖图在 160 高时 336 + 8 < 358，加上宽图才超过：四张一行，被压到约 94
    expect(rows[0]).toMatchObject({ start: 0, end: 4 });
    expect(rows[0]!.height).toBeCloseTo((358 - 12) / (0.7 * 3 + 1.62), 5);
    for (const r of rows.slice(0, -1)) expect(r.widths.reduce((a, b) => a + b, 0) + 4 * (r.widths.length - 1)).toBeCloseTo(358, 5);
    expect(rows.at(-1)!.height).toBe(160);
  });

  it('balance（窄屏）：不放那张宽图更接近目标行高时先收行，宽图去下一行打头', () => {
    const rows = justify(items, 358, 160, 4, { balance: true });
    expect(rows[0]).toMatchObject({ start: 0, end: 3 });
    expect(rows[0]!.height).toBeCloseTo((358 - 8) / 2.1, 5); // ≈ 167
    expect(rows[1]!.start).toBe(3);
    // 每一行（最后一行除外）都比不平衡时更接近目标
    const plain = justify(items, 358, 160, 4);
    expect(Math.abs(rows[0]!.height - 160)).toBeLessThan(Math.abs(plain[0]!.height - 160));
    // 一张不少、顺序不变
    expect(rows.flatMap((r) => Array.from({ length: r.end - r.start }, (_, k) => r.start + k))).toEqual(items.map((_, i) => i));
  });

  it('balance：一张就撑满一行的超宽图自己一行', () => {
    const pano = { width: 4000, height: 1000 }; // 比例封顶 3
    // 两张竖图在 300 宽时约 211 高，加上全景图会压到约 66：先收行；全景图 3 × 160 已经超过 300，自己一行（100 高）
    const rows = justify([portrait, portrait, pano, portrait], 300, 160, 4, { balance: true });
    expect(rows.map((r) => [r.start, r.end])).toEqual([[0, 2], [2, 3], [3, 4]]);
    expect(rows[1]!.height).toBeCloseTo(100, 5);
  });

  it('宽屏一行张数多时两种方式结果差不多（电脑上不开 balance，也不需要）', () => {
    const many = Array.from({ length: 40 }, (_, i) => (i % 5 === 3 ? wide : portrait));
    const a = justify(many, 1200, 240, 6);
    const b = justify(many, 1200, 240, 6, { balance: true });
    const spread = (rows: typeof a) => Math.max(...rows.slice(0, -1).map((r) => Math.abs(r.height - 240)));
    expect(spread(b)).toBeLessThanOrEqual(spread(a));
  });
});
