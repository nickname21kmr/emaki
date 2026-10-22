import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import type { JobContext } from '../../core/jobs.ts';
import { closeDatabase, openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { processPixels, thumbPath } from './pixels.ts';
import { sharp } from './sharpConfig.ts';
import { ThumbnailService } from './ThumbnailService.ts';
import { animationHtml } from '../../../test/helpers/htmlAnimation.ts';
import { htmlAnimationCache } from './htmlAnimation.ts';
import { readFile } from 'node:fs/promises';

const SHA = 'ab'.repeat(32);
const T = '2026-01-01T00:00:00.000Z';

const ctx: JobContext = {
  signal: new AbortController().signal,
  setTotal() {},
  advance() {},
  setMessage() {},
  shouldYield: () => false,
  requeue() {},
  yielded: false,
};

/** 带纹理的原图（纯色图的 dHash 全是 0，看不出对错） */
function original(): Promise<Buffer> {
  const w = 600;
  const h = 800;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = (x * 3) % 256;
      buf[i + 1] = (y * 5) % 256;
      buf[i + 2] = ((x + y) % 64) * 4;
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

type Row = { thumb_at: string | null; dhash: string | null; dominant_color: string | null };

describe('ThumbnailService.runBackfill', () => {
  let dir: string;
  let thumbs: string;
  let db: Db;
  let svc: ThumbnailService;
  let src: Buffer;
  const row = () => db.prepare('SELECT thumb_at, dhash, dominant_color FROM images WHERE id = 1').get() as Row;

  beforeEach(async () => {
    dir = makeTmpDir('thumbsvc');
    thumbs = path.join(dir, 'thumbs');
    const lib = path.join(dir, 'lib');
    mkdirSync(lib);
    src = await original();
    writeFileSync(path.join(lib, 'a.png'), src);
    db = openDatabase(':memory:');
    migrate(db);
    db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(lib.replaceAll('\\', '/'));
    db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
      VALUES (1, 1, 'a.png', 'a.png', 600, 800, ?, 'png', ?, '${T}', '${T}')`).run(src.length, SHA);
    svc = new ThumbnailService({ db, thumbsRoot: thumbs, now: () => Date.parse(T) });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有缓存：从原图生成两档，写上 thumb_at 和 dHash', async () => {
    expect(svc.pendingCount()).toBe(1);
    await svc.runBackfill(ctx);
    expect(existsSync(thumbPath(thumbs, SHA, 480))).toBe(true);
    expect(existsSync(thumbPath(thumbs, SHA, 240))).toBe(true);
    const r = row();
    expect(r.thumb_at).toBe(T);
    expect(r.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(svc.pendingCount()).toBe(0);
  });

  it('旧库已有缩略图的动画 WebP 也会补帧数和分类，保留手工类型',async()=>{
    const animation=await htmlAnimationCache(await animationHtml(),dir);
    const input=await readFile(animation);
    writeFileSync(path.join(dir,'lib','animation.webp'),input);
    db.prepare("UPDATE images SET rel_path='animation.webp',file_name='animation.webp',format='webp',width=4,height=3,frame_count=NULL,thumb_at=?,content_kind='illustration'").run(T);
    await processPixels(input,'webp',SHA,thumbs);
    expect(svc.pendingCount()).toBe(1);
    await svc.runBackfill(ctx);
    expect(db.prepare('SELECT frame_count,content_kind FROM images WHERE id=1').get()).toEqual({frame_count:2,content_kind:'animated'});
    expect(svc.pendingCount()).toBe(0);
    db.exec("UPDATE images SET frame_count=NULL,content_kind='illustration',content_kind_manual=1");
    await svc.runBackfill(ctx);
    expect(db.prepare('SELECT frame_count,content_kind FROM images WHERE id=1').get()).toEqual({frame_count:2,content_kind:'illustration'});
  });

  it('补静态图片帧数时保留已有分类及其判定依据',async()=>{
    db.exec("UPDATE images SET content_kind='screenshot',content_kind_source='tags',content_kind_evidence='已有视觉分类结果'");
    await svc.runBackfill(ctx);
    expect(db.prepare('SELECT frame_count,content_kind,content_kind_evidence FROM images WHERE id=1').get())
      .toEqual({frame_count:1,content_kind:'screenshot',content_kind_evidence:'已有视觉分类结果'});
  });

  it('只有 480 没有 240（写到一半被打断）：补出 240，写上 thumb_at 和 dHash', async () => {
    // 先完整跑一遍拿到期望值，再删掉 240 模拟中断
    const want = await processPixels(src, 'png', SHA, thumbs);
    rmSync(thumbPath(thumbs, SHA, 240));
    expect(row().thumb_at).toBeNull();
    expect(svc.pendingCount()).toBe(1);

    await svc.runBackfill(ctx);
    expect(existsSync(thumbPath(thumbs, SHA, 240))).toBe(true);
    const r = row();
    expect(r.thumb_at).toBe(T);
    expect(r.dhash).toBe(want.dhash);
    expect(r.dominant_color).toBe(want.dominantColor);
    expect(svc.pendingCount()).toBe(0);
  });
});
