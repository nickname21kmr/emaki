import type { LibraryStats } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { importPhase } from './utils';

const idle = { scan: null, thumbnail: null, tag: null, dedupe: null };
const stats = (s: Partial<LibraryStats>) => ({ pendingTagCount: 0, untaggedCount: 0, recentImport: null, ...s }) as LibraryStats;

describe('importPhase', () => {
  it('没有近期导入就不是导入态', () => {
    expect(importPhase(stats({ pendingTagCount: 5, untaggedCount: 5 }), idle)).toBeNull();
  });

  it('新加的文件夹都识别完了，库里别处还有没识别的，不算暂停', () => {
    const s = stats({ pendingTagCount: 117, untaggedCount: 117, recentImport: { at: '2026-10-20T00:00:00Z', count: 21, pending: 0 } });
    expect(importPhase(s, idle)).toBeNull();
  });

  it('这次导入的还有没识别的、识别没在跑 → 暂停', () => {
    const s = stats({ pendingTagCount: 117, untaggedCount: 117, recentImport: { at: '2026-10-20T00:00:00Z', count: 21, pending: 3 } });
    expect(importPhase(s, idle)).toBe('paused');
  });
});
