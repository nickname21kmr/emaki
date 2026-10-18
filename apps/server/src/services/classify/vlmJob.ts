import { existsSync } from 'node:fs';
import type { JobContext } from '../../core/jobs.ts';
import type { Db } from '../../db/connection.ts';
import { toAbs } from '../fs/paths.ts';
import { shutdownTagger } from '../tagger/client.ts';
import { backfillClassification } from './backfill.ts';
import { IN_COMIC } from './comicAreas.ts';
import { readContentReview } from './contentReview.ts';
import { startVlm, type VlmClient } from './vlmClient.ts';
import { VLM_PROFILE, readVlmDecision, type VlmDecision, type VlmFiles } from './vlmDecision.ts';

interface Row {
  id: number; sha256: string; content_review: string | null; source_site: string | null;
  root_path: string; rel_path: string; tagged_at: string;
}
export interface ContentStage {
  enabled(): boolean;
  isReady(): boolean;
  pendingCount(): number;
  retryErrors(): void;
  stop(): Promise<void>;
  run(ctx: JobContext): Promise<string>;
}
export function createContentStage(o: {
  db: Db; enabled: boolean; files: VlmFiles; onChanged(final?: boolean): void;
  start?: (files: VlmFiles, signal: AbortSignal) => Promise<VlmClient>;
  releaseTagger?: () => Promise<void>;
}): ContentStage {
  const shutdown = new AbortController();
  let running: Promise<string> | undefined;
  const filesReady = () => [o.files.server, o.files.model, o.files.projector].every(existsSync);
  const select = o.db.prepare(`SELECT i.id, i.sha256, i.content_review, i.source_site, i.rel_path,
      i.tagged_at, r.path AS root_path FROM images i JOIN library_roots r ON r.id=i.root_id
    WHERE r.enabled=1 AND r.removed_at IS NULL AND i.missing=0 AND i.trashed_at IS NULL
      AND i.excluded_by IS NULL AND i.content_kind_manual=0 AND NOT ${IN_COMIC('i')}
      AND i.format!='gif' AND i.content_kind='illustration' AND i.tagged_at IS NOT NULL
      AND COALESCE(i.source_site,'')!='pixiv' ORDER BY i.id`);
  const candidates = () => (select.all() as Row[]).filter(r =>
    !readVlmDecision(r.content_review, r.sha256) && !readContentReview(r.content_review, r.sha256));
  const guard = `WHERE id=@id AND sha256=@sha256 AND content_review IS @before AND source_site IS @site
      AND tagged_at=@tagged AND rel_path=@rel AND content_kind_manual=0
      AND content_kind='illustration' AND missing=0 AND trashed_at IS NULL AND excluded_by IS NULL
      AND NOT ${IN_COMIC('images')}
      AND EXISTS (SELECT 1 FROM library_roots r WHERE r.id=images.root_id
        AND r.path=@root AND r.enabled=1 AND r.removed_at IS NULL)`;
  const update = o.db.prepare('UPDATE images SET content_review=@decision ' + guard);
  const stillEligible = o.db.prepare('SELECT 1 FROM images ' + guard);
  return {
    enabled: () => o.enabled,
    isReady: () => o.enabled && filesReady(),
    pendingCount: () => o.enabled ? candidates().length : 0,
    retryErrors: () => {
      // Malformed/legacy records are not touched. An explicit retry only resets this profile's file errors.
      const rows = o.db.prepare('SELECT id,sha256,content_review FROM images WHERE content_review IS NOT NULL').all() as Row[];
      const clear = o.db.prepare('UPDATE images SET content_review=NULL WHERE id=? AND content_review=?');
      o.db.transaction(() => { for (const r of rows) if (readVlmDecision(r.content_review, r.sha256)?.status === 'error') clear.run(r.id, r.content_review); })();
    },
    run(ctx) {
      return running ??= execute(ctx).finally(() => { running = undefined; });
    },
    async stop() {
      shutdown.abort();
      await running?.catch(() => {});
    },
  };
  async function execute(context: JobContext): Promise<string> {
      const ctx = { ...context, signal: AbortSignal.any([context.signal, shutdown.signal]) };
      if (!o.enabled) return '图片分类：未启用可选 4B 分类器';
      const rows = candidates();
      ctx.setTotal(rows.length);
      if (!rows.length) return '图片分类：没有待处理图片（Pixiv 来源直接保留）';
      if (!filesReady()) throw new Error('4B 模型或 llama.cpp 文件未配置；请查看 docs/content-filter.md，不会自动下载');
      let client: VlmClient | undefined;
      let applied = 0, errors = 0, changed = 0;
      try {
        ctx.signal.throwIfAborted();
        if (ctx.shouldYield()) { ctx.requeue(); return '图片分类：等待角色识别完成'; }
        // Same GPU lane as tag/artist jobs, but their idle cache must also be released.
        await (o.releaseTagger ?? shutdownTagger)();
        ctx.setMessage('图片分类：加载 Qwen3.5-4B…');
        client = await (o.start ?? startVlm)(o.files, ctx.signal);
        for (const row of rows) {
          ctx.signal.throwIfAborted();
          if (ctx.shouldYield()) { ctx.requeue(); break; }
          const identity = { id: row.id, sha256: row.sha256, before: row.content_review,
            site: row.source_site, tagged: row.tagged_at, rel: row.rel_path, root: row.root_path };
          if (!stillEligible.get(identity)) { ctx.advance(1, '图片分类：跳过状态已变化的图片'); continue; }
          const prediction = await client.classify(toAbs(row.root_path, row.rel_path), row.sha256);
          ctx.signal.throwIfAborted();
          const record: VlmDecision = { version: 2, profile: VLM_PROFILE, sha256: row.sha256,
            kind: prediction.kind, status: prediction.fileError ? 'error' : 'ok', at: new Date().toISOString(),
            ...(prediction.fileError ? { error: prediction.fileError } : {}) };
          const n = o.db.transaction(() => {
            const n = update.run({ ...identity, decision: JSON.stringify(record) }).changes;
            if (n) backfillClassification(o.db, { ids: [row.id] });
            return n;
          })();
          applied += n;
          if (prediction.fileError) errors++;
          if (n && record.status === 'ok' && !['illustration', 'uncertain'].includes(record.kind)) changed++;
          ctx.advance(1, `图片分类：已处理 ${applied} · 排除 ${changed} · 文件错误 ${errors}`);
          if (applied && applied % 20 === 0) o.onChanged();
        }
        return `图片分类：处理 ${applied} 张 · 排除 ${changed} 张非插画 · 文件错误 ${errors}`;
      } finally {
        await client?.dispose();
        if (applied) o.onChanged(true);
      }
  }
}
