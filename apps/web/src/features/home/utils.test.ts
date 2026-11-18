import type { LibrarySummary } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { importPhase, JOB_LABEL } from './utils';

const idle = { scan: null, thumbnail: null, tag: null, dedupe: null };
const summary = (waiting: number, recentImport: LibrarySummary['recentImport'] = null) =>
  ({ recentImport, triage: { images: 0, books: 0, total: 0, waiting, shelved: 0 } }) satisfies Pick<LibrarySummary, 'recentImport' | 'triage'>;

describe('importPhase', () => {
  it('没有近期导入就不是导入态', () => {
    expect(importPhase(summary(5), idle)).toBeNull();
  });

  it('新加的文件夹都识别完了，库里别处还有没识别的，不算暂停', () => {
    expect(importPhase(summary(117, { at: '2026-10-20T00:00:00Z', count: 21, pending: 0 }), idle)).toBeNull();
  });

  it('这次导入的还有没识别的、识别没在跑 → 暂停', () => {
    expect(importPhase(summary(117, { at: '2026-10-20T00:00:00Z', count: 21, pending: 3 }), idle)).toBe('paused');
  });
});

describe('JOB_LABEL', () => {
  it('横幅的「正在……」由共用的任务名拼出来（任务名只有一份，附录 #38）', () => {
    expect(JOB_LABEL.tag).toBe('正在识别角色');
    expect(JOB_LABEL['pixiv-tags']).toBe('正在补充 Pixiv 角色');
  });
});
