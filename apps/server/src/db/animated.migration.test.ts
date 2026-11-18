/**
 * 迁移 038（D5，P4b）：造一个停在 v37 的库，放进各种原来的 animated（自动判的 / 手动选的，多帧 / 单帧 / 帧数没读过，
 * 不同文件夹和标签）和别的类型的图，迁移之后核对；再按启动时的做法重判（classifyStale）看它们落到哪个类型；
 * 最后在迁移后的库上 ATTACH 迁移前的自动备份，跑一遍核对 SQL（scripts/verify-migration-038.sql）。
 * 不变量：
 * - 是否动图 = 迁移 SQL 的规则 = 分析模块的 isAnimated（逐种格式 × 帧数核对）；
 * - 原来是 animated 的：手动标记清掉，类型交给分析模块按新规则重判（动的插画判插画、动的表情判表情、「3话」里的判漫画）；
 *   原来 animated 的张数和迁移后是动图的张数不等时，差在哪里由核对 SQL 按原因分开（单帧 GIF、手动选的静态图、表情包文件夹里的 GIF……）；
 * - 原来不是 animated 的：类型、手动标记、判定依据都不变，版本直接记成 2，启动时不重判；
 * - 决定（收藏、分级、放下、角色关联）一条不动。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ImageFormat } from '@emaki/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { classifyStale } from '../domain/analysis/analyze.ts';
import { CLASSIFIER_VERSION, isAnimated } from '../services/classify/rules.ts';
import { openDatabase, type Db } from './connection.ts';
import { loadMigrations, migrate } from './migrate.ts';

let db: Db;
let dir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  dir = makeTmpDir('migrate-038');
  // 迁移目录只放到 v37，库停在迁移 038 之前
  const schema = path.join(dir, 'v37');
  mkdirSync(path.join(schema, 'migrations'), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, 'schema.sql'), path.join(schema, 'schema.sql'));
  for (const m of loadMigrations().slice(1, 37)) writeFileSync(path.join(schema, 'migrations', m.name), m.sql);
  expect(migrate(db, { dir: schema })).toEqual({ from: 0, to: 37 });
  db.exec("INSERT INTO library_roots (id, path) VALUES (1, '//emaki-test/038')");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = '2026-01-01T00:00:00.000Z';

interface Spec {
  id: number;
  rel: string;
  format: ImageFormat;
  frames: number | null;
  kind: string;
  manual?: boolean;
  source?: string | null;
  version?: number | null;
  /** 识别标签（有就算识别过） */
  tags?: Record<string, number>;
  favorite?: boolean;
}

function insert(s: Spec): void {
  db.prepare(
    `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, frame_count, tagged_at,
       content_kind, content_kind_source, content_kind_evidence, content_kind_manual, content_kind_version, favorite, rating, camera)
     VALUES (@id, 1, @rel, @name, 1200, 1700, 1000, @format, @sha, @at, @at, @frames, @tagged, @kind, @source, @evidence, @manual, @version,
       @favorite, 'sensitive', '')`,
  ).run({
    id: s.id,
    rel: s.rel,
    name: s.rel.split('/').at(-1),
    format: s.format,
    sha: `sha-${s.id}`,
    at: T,
    frames: s.frames,
    tagged: s.tags ? T : null,
    kind: s.kind,
    source: s.manual ? 'manual' : s.source === undefined ? (s.kind === 'animated' ? 'format' : 'default') : s.source,
    evidence: s.kind === 'animated' && !s.manual ? 'GIF 动图' : null,
    manual: s.manual ? 1 : 0,
    version: s.version === undefined ? 1 : s.version,
    favorite: s.favorite ? 1 : 0,
  });
  for (const [name, score] of Object.entries(s.tags ?? {})) {
    db.prepare("INSERT OR IGNORE INTO tags (name, category) VALUES (?, 'general')").run(name);
    db.prepare('INSERT INTO image_tags (image_id, tag_id, score) SELECT ?, id, ? FROM tags WHERE name = ?').run(s.id, score, name);
  }
}

/** 一套有代表性的旧数据 */
const SPECS: Spec[] = [
  // 自动判的 animated
  { id: 1, rel: 'pixiv/1_p0.gif', format: 'gif', frames: 24, kind: 'animated', tags: { '1girl': 0.99, solo: 0.9 }, favorite: true },
  { id: 2, rel: '某漫画 3话/01.gif', format: 'gif', frames: 8, kind: 'animated' },
  { id: 3, rel: 'misc/react.gif', format: 'gif', frames: 30, kind: 'animated', tags: { meme: 0.8 } },
  { id: 4, rel: 'misc/still.gif', format: 'gif', frames: 1, kind: 'animated' },
  { id: 5, rel: 'misc/unread.gif', format: 'gif', frames: null, kind: 'animated' },
  { id: 6, rel: 'misc/anim.webp', format: 'webp', frames: 2, kind: 'animated' },
  { id: 7, rel: 'misc/frames.html', format: 'html', frames: 12, kind: 'animated' },
  // 手动选的 animated：多帧的、帧数显示不是动图的（单帧 PNG、帧数没读过的 WebP）
  { id: 8, rel: 'misc/manual.webp', format: 'webp', frames: 8, kind: 'animated', manual: true },
  { id: 9, rel: 'misc/manual-still.png', format: 'png', frames: 1, kind: 'animated', manual: true },
  { id: 10, rel: 'misc/manual-unread.webp', format: 'webp', frames: null, kind: 'animated', manual: true },
  // 别的类型：表情包文件夹里的动图（以前文件夹规则在前，判成表情）、手动截图的动图、普通插画和漫画、没判过类型的
  { id: 11, rel: '表情包/a.gif', format: 'gif', frames: 12, kind: 'meme', source: 'folder' },
  { id: 12, rel: 'misc/rec.gif', format: 'gif', frames: 40, kind: 'screenshot', manual: true },
  { id: 13, rel: 'pixiv/13_p0.png', format: 'png', frames: 1, kind: 'illustration', source: 'tags', tags: { '1girl': 0.99 } },
  { id: 14, rel: 'misc/14.jpg', format: 'jpeg', frames: null, kind: 'comic', source: 'tags', tags: { comic: 0.9 } },
  { id: 15, rel: 'misc/15.png', format: 'png', frames: null, kind: 'illustration', source: null, version: null },
];

it('是否动图：迁移的 SQL 和分析模块的 isAnimated 逐种一致', () => {
  const formats: ImageFormat[] = ['gif', 'webp', 'png', 'avif', 'jpeg', 'bmp', 'html'];
  const frames = [null, 1, 2, 30];
  let id = 100;
  const want = new Map<number, boolean>();
  for (const format of formats)
    for (const f of frames) {
      insert({ id, rel: `grid/${id}.${format}`, format, frames: f, kind: 'illustration', source: 'default' });
      want.set(id++, isAnimated({ format, frames: f }));
    }
  migrate(db);
  const got = db.prepare('SELECT id, animated FROM images').all() as { id: number; animated: number }[];
  expect(got.map((r) => [r.id, r.animated === 1])).toEqual([...want]);
});

it('原来的 animated：手动标记清掉、类型交给分析模块重判，是否动图按帧数；别的图一行不变', () => {
  for (const s of SPECS) insert(s);
  db.exec("INSERT INTO characters (id, name, source, created_at) VALUES (1, '爱丽丝', 'custom', '2026-01-01')");
  db.exec("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (1, 1, 'manual', 'user', '2026-01-01')");
  const others = () =>
    db
      .prepare(
        `SELECT id, content_kind, content_kind_source, content_kind_manual, theme, art_score FROM images WHERE id BETWEEN 11 AND 15 ORDER BY id`,
      )
      .all();
  const before = others();
  expect(migrate(db, { backupDir: dir })).toEqual({ from: 37, to: 38 });

  const rows = () =>
    db.prepare('SELECT id, content_kind AS kind, content_kind_manual AS manual, content_kind_version AS v, animated FROM images ORDER BY id').all() as {
      id: number;
      kind: string;
      manual: number;
      v: number | null;
      animated: number;
    }[];
  // 迁移刚做完：原来的 animated 先放成插画占位，等启动时重判（版本为空）
  const migrated = rows();
  expect(migrated.filter((r) => r.id <= 10)).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => ({
      id,
      kind: 'illustration',
      manual: 0,
      v: null,
      animated: [4, 9, 10].includes(id) ? 0 : 1,
    })),
  );
  // 别的图：类型、判定依据、手动标记不变，版本记成 2（没判过的还是空，启动时照常判）
  expect(others()).toEqual(before);
  expect(migrated.filter((r) => r.id > 10).map((r) => [r.id, r.v, r.animated])).toEqual([
    [11, 2, 1],
    [12, 2, 1],
    [13, 2, 0],
    [14, 2, 0],
    [15, null, 0],
  ]);
  expect(db.prepare('SELECT COUNT(*) FROM images WHERE content_kind = ?').pluck().get('animated')).toBe(0);

  // 启动时版本过期的行按新规则重判：只重判这几张（原来的 animated + 没判过的），别的不动
  expect(classifyStale(db).rows).toBe(11);
  const kinds = db.prepare('SELECT id, content_kind, animated, content_kind_version FROM images ORDER BY id').all() as {
    id: number;
    content_kind: string;
    animated: number;
    content_kind_version: number;
  }[];
  expect(kinds.every((r) => r.content_kind_version === CLASSIFIER_VERSION)).toBe(true);
  expect(Object.fromEntries(kinds.map((r) => [r.id, `${r.content_kind}${r.animated ? '·动' : ''}`]))).toEqual({
    1: 'illustration·动', // 动的插画就是插画
    2: 'comic·动', // 「3话」文件夹里的是漫画
    3: 'meme·动', // 动的表情就是表情
    4: 'illustration', // 单帧 GIF 不是动图
    5: 'illustration·动', // 帧数没读过的 GIF 先算动图
    6: 'illustration·动',
    7: 'illustration·动',
    8: 'illustration·动', // 手动选的 animated → 自动类型 + 动图
    9: 'illustration', // 手动选的，但帧数显示不是动图
    10: 'illustration',
    11: 'meme·动',
    12: 'screenshot·动', // 手动的类型保留
    13: 'illustration',
    14: 'comic',
    15: 'illustration',
  });
  // 决定不动
  expect(db.prepare('SELECT favorite, rating FROM images WHERE id = 1').get()).toEqual({ favorite: 1, rating: 'sensitive' });
  expect(db.prepare('SELECT image_id, character_id, decision FROM image_characters').all()).toEqual([{ image_id: 1, character_id: 1, decision: 'manual' }]);
});

it('核对 SQL 在迁移后的库上能跑，数字对得上', () => {
  for (const s of SPECS) insert(s);
  migrate(db, { backupDir: dir });
  classifyStale(db);
  db.prepare('ATTACH DATABASE ? AS old').run(path.join(dir, 'emaki.v37.bak.sqlite'));
  const sql = readFileSync(path.join(import.meta.dirname, '../../scripts/verify-migration-038.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  const out: unknown[][] = [];
  for (const stmt of sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) out.push(...(db.prepare(stmt).raw().all() as unknown[][]));
  const get = (prefix: string) => out.filter((r) => String(r[0]).startsWith(prefix));

  expect(get('1a')[0]!.slice(1)).toEqual([10, 3]);
  // 原来 10 张 animated → 现在 9 张动图（原来的 7 张 + 表情包文件夹的 + 手动截图的）
  expect(get('1b')[0]!.slice(1)).toEqual([9, 9]);
  expect(get('1c')[0]!.slice(1)).toEqual([7]);
  expect(get('1d').map((r) => r.slice(0, 3)).sort()).toEqual([
    ['1d 原来 animated、现在不是动图：单帧 GIF（静态 GIF，以前 GIF 一律算动图）', 1, 0],
    ['1d 原来 animated、现在不是动图：单帧 PNG（只可能是手动选的）', 1, 1],
    ['1d 原来 animated、现在不是动图：帧数还没读过的 WEBP（缩略图任务读到帧数后按帧数判）', 1, 1],
  ]);
  expect(get('1e').map((r) => r.slice(0, 2)).sort()).toEqual([
    ['1e 原来不是 animated、现在是动图：原来是 meme，GIF', 1],
    ['1e 原来不是 animated、现在是动图：原来是 screenshot（手动），GIF', 1],
  ]);
  for (const zero of ['1f', '1g', '1h', '2b', '2c', '3b', '3c', '3d', '4b', '4c']) {
    const r = get(zero)[0]!;
    expect([r[0], r[1]]).toEqual([r[0], zero === '1f' ? 1 : 0]);
  }
  expect(get('2a').map((r) => r.slice(0, 2)).sort()).toEqual(
    [
      ['2a 原来 animated → 现在：illustration · 动图（判定依据 tags）', 1],
      ['2a 原来 animated → 现在：comic · 动图（判定依据 folder）', 1],
      ['2a 原来 animated → 现在：meme · 动图（判定依据 tags）', 1],
      ['2a 原来 animated → 现在：illustration · 动图（判定依据 default）', 4],
      ['2a 原来 animated → 现在：illustration · 不是动图（判定依据 default）', 3],
    ].sort(),
  );
  expect(get('3a')[0]!.slice(1)).toEqual([1, 2]);
  expect(get('3e').map((r) => r[1])).toEqual([9, 10]);
  expect(get('4a')[0]!.slice(1)).toEqual([15, 15]);
  expect(get('5c')[0]!.slice(1)).toEqual([1, 1]);
});
