import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import type { JobContext } from '../../core/jobs.ts';
import { backfillClassification, CLASS_COLS, computeClassification, type ClassRow } from './backfill.ts';
import { createContentStage } from './vlmJob.ts';
import { VLM_PROFILE, parseVlmResponse, readVlmDecision, type VlmKind } from './vlmDecision.ts';
import { TagResultWriter } from '../tagger/writer.ts';
import { CharacterCatalog } from '../catalog/characterCatalog.ts';
import { CopyrightResolver } from '../catalog/copyrights.ts';

let db: Db, dir: string;
beforeEach(() => {
  db = openDatabase(':memory:'); migrate(db);
  dir = mkdtempSync(path.join(os.tmpdir(), 'emaki-vlm-'));
  for (const file of ['server', 'model', 'projector']) writeFileSync(path.join(dir, file), '');
  db.exec("INSERT INTO library_roots(id,path) VALUES(1,'D:/pictures')");
  for (let id = 1; id <= 3; id++)
    db.prepare(`INSERT INTO images(id,root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at,tagged_at)
      VALUES(?,1,?,?,800,800,1,'png',?,'x','x','x')`).run(id, id+'.png', id+'.png', 'sha'+id);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const context = (signal = new AbortController().signal): JobContext => ({
  signal, setTotal: vi.fn(), setMessage: vi.fn(), advance: vi.fn(), shouldYield: () => false, requeue: vi.fn(), yielded: false,
});
function setup(predict: () => Promise<{ kind: VlmKind; fileError?: string }> = async () => ({ kind: 'photo' }), enabled = true) {
  const classify = vi.fn(predict), dispose = vi.fn(async () => {}), releaseTagger = vi.fn(async () => {}), onChanged = vi.fn();
  const start = vi.fn(async () => ({ classify, dispose }));
  const stage = createContentStage({ db, enabled, files: { server: path.join(dir,'server'), model: path.join(dir,'model'), projector: path.join(dir,'projector') },
    start, releaseTagger, onChanged });
  return { stage, classify, dispose, start, releaseTagger, onChanged };
}
const cached = (changes = {}) => JSON.stringify({ version: 2, profile: VLM_PROFILE, sha256: 'sha1',
  kind: 'photo', status: 'ok', at: '2026-10-18T00:00:00Z', ...changes });

it('disabled means zero model startup and zero pending work', async () => {
  const s = setup(undefined, false);
  expect(s.stage.pendingCount()).toBe(0); expect(s.stage.isReady()).toBe(false);
  await s.stage.run(context()); expect(s.start).not.toHaveBeenCalled();
});
it('Pixiv bypasses inference; manual, GIF, comic roots, offline roots and unread images are skipped', async () => {
  db.exec("UPDATE images SET source_site='pixiv' WHERE id=1; UPDATE images SET content_kind_manual=1 WHERE id=2; UPDATE images SET format='gif' WHERE id=3");
  const s = setup(); expect(s.stage.pendingCount()).toBe(0);
  await s.stage.run(context()); expect(s.start).not.toHaveBeenCalled();
  db.exec("UPDATE images SET source_site=NULL,content_kind_manual=0,format='png'; UPDATE library_roots SET content_mode='comic'");
  expect(s.stage.pendingCount()).toBe(0);
  db.exec("UPDATE library_roots SET content_mode='auto',enabled=0"); expect(s.stage.pendingCount()).toBe(0);
  db.exec("UPDATE library_roots SET enabled=1; UPDATE images SET tagged_at=NULL"); expect(s.stage.pendingCount()).toBe(0);
});
it('persistent decisions survive rule backfill and character retagging, and do not become manual', async () => {
  const s = setup(); await s.stage.run(context());
  expect(s.classify).toHaveBeenCalledTimes(3); expect(s.dispose).toHaveBeenCalledTimes(1);
  expect(s.releaseTagger).toHaveBeenCalledTimes(1);
  expect(s.stage.pendingCount()).toBe(0);
  backfillClassification(db,{ ids: [1] });
  const copyrights = new CopyrightResolver(db, {});
  const writer = new TagResultWriter(db,new CharacterCatalog(db,{ copyrights }),copyrights,
    { repo:'test',generalThreshold:.35,characterThreshold:.35,autoAcceptThreshold:.85 });
  writer.writeBatch([{ id:1,ok:true,rating:null,general:[],character:[] }]);
  expect(db.prepare('SELECT content_kind,content_kind_manual FROM images WHERE id=1').get()).toEqual({ content_kind:'photo',content_kind_manual:0 });
  await s.stage.run(context()); expect(s.start).toHaveBeenCalledTimes(1);
});
it('uncertain is retained and cached; file errors are retained and retried only on explicit retry', async () => {
  const s = setup(async () => ({ kind:'uncertain', fileError:'broken image' }));
  await s.stage.run(context()); expect(s.stage.pendingCount()).toBe(0);
  expect(db.prepare('SELECT DISTINCT content_kind FROM images').pluck().all()).toEqual(['illustration']);
  s.stage.retryErrors(); expect(s.stage.pendingCount()).toBe(3);
  const u = setup(async () => ({ kind:'uncertain' })); await u.stage.run(context());
  u.stage.retryErrors(); expect(u.stage.pendingCount()).toBe(0);
});
it.each([
  "UPDATE images SET content_kind_manual=1,content_kind='meme' WHERE id=1",
  "UPDATE images SET source_site='pixiv' WHERE id=1",
  "UPDATE images SET sha256='changed' WHERE id=1",
  "UPDATE images SET tagged_at='changed' WHERE id=1",
  "UPDATE images SET rel_path='moved.png' WHERE id=1",
  "UPDATE library_roots SET enabled=0",
  "UPDATE library_roots SET content_mode='comic'",
  "UPDATE images SET trashed_at='now' WHERE id=1",
])('does not commit stale inference after concurrent mutation: %s', async (sql) => {
  let first = true;
  const s=setup(async () => { if(first) { first=false; db.exec(sql); } return {kind:'photo'}; });
  await s.stage.run(context());
  expect(db.prepare('SELECT content_review FROM images WHERE id=1').pluck().get()).toBeNull();
});
it('cancellation before committing preserves records and releases model', async () => {
  const abort = new AbortController();
  const s = setup(async () => { abort.abort(); return { kind:'photo' }; });
  await expect(s.stage.run(context(abort.signal))).rejects.toThrow();
  expect(db.prepare('SELECT COUNT(*) FROM images WHERE content_review IS NOT NULL').pluck().get()).toBe(0);
  expect(s.dispose).toHaveBeenCalledTimes(1);
});
it('engine errors propagate, do not cache a prediction, and release the engine', async () => {
  const s=setup(async () => {throw new Error('engine crashed');});
  await expect(s.stage.run(context())).rejects.toThrow('engine crashed');
  expect(s.dispose).toHaveBeenCalledTimes(1); expect(s.stage.pendingCount()).toBe(3);
});
it('yields before loading a model when the GPU lane has a higher priority job', async () => {
  const s=setup(),ctx=context();ctx.shouldYield=()=>true;
  await s.stage.run(ctx);expect(ctx.requeue).toHaveBeenCalled();expect(s.start).not.toHaveBeenCalled();
});
it('changed hashes/profiles invalidate cached predictions and schedule new work', () => {
  db.prepare('UPDATE images SET content_review=? WHERE id=1').run(cached());
  const s=setup();expect(s.stage.pendingCount()).toBe(2);
  db.exec("UPDATE images SET sha256='new' WHERE id=1");expect(s.stage.pendingCount()).toBe(3);
  expect(readVlmDecision(cached({profile:'old'}),'sha1')).toBeNull();
});
it('Pixiv priority applies in recomputation; manual, imported comic and GIF still win', () => {
  db.prepare("UPDATE images SET source_site='pixiv',file_name='Screenshot.png',content_review=? WHERE id=1").run(cached());
  backfillClassification(db,{ids:[1]});
  expect(db.prepare('SELECT content_kind FROM images WHERE id=1').pluck().get()).toBe('illustration');
  db.exec("UPDATE images SET format='gif' WHERE id=1");backfillClassification(db,{ids:[1]});
  expect(db.prepare('SELECT content_kind FROM images WHERE id=1').pluck().get()).toBe('animated');
  db.exec("UPDATE images SET content_kind_manual=1,content_kind='text' WHERE id=1");backfillClassification(db,{ids:[1]});
  expect(db.prepare('SELECT content_kind FROM images WHERE id=1').pluck().get()).toBe('text');
  const row=db.prepare('SELECT '+CLASS_COLS+' FROM images WHERE id=1').get() as ClassRow;
  expect(computeClassification({...row,comic_root:1,content_kind_manual:0},[]).kind).toBe('comic');
});
it.each([null,{}, {kind:'bad'}, {kind:'photo',explanation:'extra'}, ['photo']])('rejects invalid constrained output: %j', value => {
  expect(()=>parseVlmResponse(value)).toThrow();
});
