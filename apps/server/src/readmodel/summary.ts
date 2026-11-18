/**
 * 汇总接口 GET /api/summary（docs/core-architecture.md 第 6 节，P5，附录 #28、#29）：侧栏、首页、命令面板、统计条要显示的所有计数。
 *
 * 数都来自统计那一遍扫描（LibraryQueries.readCounts，口径在 readmodel/terms.ts），这里只把它们按界面要的样子组合起来，
 * 前端不再自己加减。和旧数的对账（每个数是原来哪个数加减什么）见 summary.test.ts。
 */
import type { LibrarySummary } from '@emaki/shared';
import type { LibraryCounts } from '../datasource/sqlite/library.ts';

const ratio = (n: number, d: number): number | null => (d > 0 ? Math.min(1, Math.max(0, n / d)) : null);

export function summarize({ stats: s, artScope }: LibraryCounts): LibrarySummary {
  const illustrations = s.kindCounts.illustration;
  // 等你确认 = 「插画 · 漫画」队列 − 待识别（待识别是队列的子集）
  const review = s.unrecognizedCount - s.untaggedCount;
  // 已认出 = 队列范围 − 队列里没认出的 − 放下的（三者同一个范围：ART_QUEUE_SCOPE）
  const recognized = artScope - s.unrecognizedCount - s.shelvedCount;
  return {
    images: {
      total: s.imageCount,
      illustrations,
      annex: s.imageCount - illustrations,
      byKind: s.kindCounts,
      animated: s.animatedCount,
      original: s.originalCount,
      bytes: s.totalBytes,
      averageBytes: s.imageCount > 0 ? s.totalBytes / s.imageCount : null,
    },
    added: {
      last7Days: s.addedLast7Days,
      week: s.addedLast7Days.reduce((a, b) => a + b, 0),
      today: s.addedLast7Days[6] ?? 0,
      lastAt: s.lastAddedAt,
    },
    characters: s.characterCount,
    works: s.workCount,
    triage: {
      images: review,
      books: s.pendingCollectionCount,
      total: review + s.pendingCollectionCount,
      waiting: s.untaggedCount,
      shelved: s.shelvedCount,
    },
    recognition: { scope: artScope, recognized, ratio: ratio(recognized, artScope) },
    tagging: { pending: s.pendingTagCount, seenRatio: s.imageCount > 0 ? 1 - s.pendingTagCount / s.imageCount : null },
    duplicates: s.duplicateGroupCount,
    customMatchable: s.customMatchableCount,
    collections: s.collectionCounts,
    originalWorkId: s.originalWorkId,
    lastScanAt: s.lastScanAt,
    recentImport: s.recentImport,
  };
}
