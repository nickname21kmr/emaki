import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectsPlate, lastPlate, plateShape } from './dailyPlateState';

describe('今日一枚：上次有没有图版（占不占位置看它）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('没记过（第一次打开）按有算；只有明确记了「没有」才不占位', () => {
    expect(expectsPlate(null)).toBe(true);
    expect(expectsPlate('1')).toBe(true);
    expect(expectsPlate('0')).toBe(false);
    // 被改坏的值也按有算
    expect(expectsPlate('')).toBe(true);
    expect(expectsPlate('{"day":"20261128"}')).toBe(true);
  });

  it('记在 localStorage：抽到记有，没抽到记没有，下次读回来', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(lastPlate.get()).toBe(true);
    lastPlate.set(false);
    expect(lastPlate.get()).toBe(false);
    lastPlate.set(true);
    expect(lastPlate.get()).toBe(true);
    expect([...store.keys()]).toEqual(['emaki.daily-plate.last']);
  });

  it('存储用不了（隐私模式、被禁用）：读写都不抛错，按第一次算', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => lastPlate.set(false)).not.toThrow();
    expect(lastPlate.get()).toBe(true);
  });
});

describe('plateShape：图版的宽高比和排法', () => {
  it('宽高比夹在 0.66–2.4 之间', () => {
    expect(plateShape(1000, 1000).ar).toBe(1);
    expect(plateShape(500, 2000).ar).toBe(0.66);
    expect(plateShape(4000, 1000).ar).toBe(2.4);
    // 高度是 0 的坏数据不除零
    expect(plateShape(800, 0).ar).toBe(2.4);
  });

  it('比 1.2 窄的算竖图（图框固定高 440），1.2 起算横图', () => {
    expect(plateShape(1414, 2024).tall).toBe(true);
    expect(plateShape(1199, 1000).tall).toBe(true);
    expect(plateShape(1200, 1000).tall).toBe(false);
    expect(plateShape(1920, 1080).tall).toBe(false);
  });
});
