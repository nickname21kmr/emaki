/**
 * 演示模式（--demo / npm run dev:demo）：用 SQLite 跑一份假图库，走和真实图库完全一样的代码。
 * - 图片文件：按演示库画成小 JPEG / WebP，放在 picsDir；第一次要画一会儿，之后复用，缺了的补画、多出来的删掉。
 * - 数据库：每次启动都从头导入，上次的改动不会留下来。
 * - 缩略图缓存留着：文件内容不变，sha 是固定的。图片重画时一起清掉。
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { closeDatabase, openDatabase } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';
import { buildDemoDb, type ImageRow, type SeedDb } from './fixtures.ts';
import { placeholderSvg } from './placeholder.ts';
import { seedDatabase } from './seed.ts';

/** 演示库的图片张数（另有合集和重复组的几十张） */
export const DEMO_IMAGE_COUNT = 3000;
/** 改了图片的画法或演示库的生成规则就加一：图片和缩略图会重新生成 */
const PICS_VERSION = 1;
/** 原图的长边：只是演示用，小一点画得快、占地方少 */
const LONG_SIDE = 800;
/** 先按这个长边画 SVG（渐变色块，放大看不出差别），再放大到 LONG_SIDE，比直接画大图快几倍 */
const RENDER_SIDE = 160;

const ROOT_DIRS: Record<string, string> = { root1: '插画', root2: 'pixiv' };

export interface DemoPaths {
  /** 演示用的数据目录（数据库、缩略图） */
  dataDir: string;
  /** 演示图片放这里，不能在 dataDir 里面（数据目录不能当图库文件夹） */
  picsDir: string;
}

export async function prepareDemo(paths: DemoPaths, o: { now?: number; log?: (m: string) => void } = {}): Promise<void> {
  const log = o.log ?? ((m: string) => console.log(`[演示] ${m}`));
  const now = o.now ?? Date.now();
  const demo = buildDemoDb(now, { imageCount: DEMO_IMAGE_COUNT });
  placeIn(demo, paths.picsDir);

  await mkdir(paths.dataDir, { recursive: true });
  const stamp = path.join(paths.picsDir, '.demo-version');
  const want = JSON.stringify({ version: PICS_VERSION, imageCount: DEMO_IMAGE_COUNT });
  const have = existsSync(stamp) ? await readFile(stamp, 'utf8') : null;
  if (have !== want) {
    if (have !== null) log('演示库的生成规则变了，重新画图');
    await rm(paths.picsDir, { recursive: true, force: true });
    await rm(path.join(paths.dataDir, 'thumbs'), { recursive: true, force: true });
  }
  await mkdir(paths.picsDir, { recursive: true });
  await syncPictures(demo, paths.picsDir, log);
  await writeFile(stamp, want);

  // 数据库每次从头来：删掉上次的（含 WAL），迁移到最新再导入
  for (const suffix of ['', '-wal', '-shm']) await rm(path.join(paths.dataDir, `emaki.sqlite${suffix}`), { force: true });
  const db = openDatabase(path.join(paths.dataDir, 'emaki.sqlite'));
  try {
    migrate(db);
    seedDatabase(db, demo, { now });
  } finally {
    closeDatabase(db);
  }
  log(`已导入 ${demo.images.size} 张图、${demo.characters.size} 个角色、${demo.works.size} 部作品`);
}

/**
 * 图库文件夹换成 picsDir 下的真实目录；PNG 改成 JPEG（渐变色块存 PNG 一张要几百 KB）。
 * 改名后撞上同目录的同名文件就在文件名后面加序号（Windows 不分大小写）。
 */
function placeIn(demo: SeedDb, picsDir: string) {
  const base = picsDir.split(path.sep).join('/');
  for (const root of demo.settings.libraryRoots) root.path = `${base}/${ROOT_DIRS[root.id] ?? root.id}`;
  const used = new Set([...demo.images.values()].map((img) => key(img)));
  for (const img of demo.images.values()) {
    if (img.format !== 'png') continue;
    used.delete(key(img));
    img.format = 'jpeg';
    const stem = img.fileName.replace(/\.png$/i, '');
    let name = `${stem}.jpg`;
    for (let n = 2; used.has(key(img, name)); n++) name = `${stem} (${n}).jpg`;
    img.fileName = name;
    img.relPath = img.relPath.replace(/[^/]+$/, name);
    used.add(key(img));
  }
}

const key = (img: ImageRow, name?: string) =>
  `${img.libraryRootId}|${(name ? img.relPath.replace(/[^/]+$/, name) : img.relPath).toLowerCase()}`;

function absPath(demo: SeedDb, img: ImageRow): string {
  const root = demo.settings.libraryRoots.find((r) => r.id === img.libraryRootId)!;
  return path.join(root.path, ...img.relPath.split('/'));
}

/** 让 picsDir 里正好是演示库的这些文件：多的删掉（上次演示里移动过的），缺的补画 */
async function syncPictures(demo: SeedDb, picsDir: string, log: (m: string) => void) {
  const expected = new Map<string, ImageRow>();
  for (const img of demo.images.values()) expected.set(path.normalize(absPath(demo, img)).toLowerCase(), img);

  const present = new Set<string>();
  for (const entry of await readdir(picsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === '.demo-version') continue;
    const file = path.join(entry.parentPath, entry.name);
    const k = path.normalize(file).toLowerCase();
    if (expected.has(k)) present.add(k);
    else await rm(file, { force: true });
  }

  const missing = [...expected].filter(([k]) => !present.has(k)).map(([, img]) => img);
  if (!missing.length) return;
  log(`画 ${missing.length} 张演示图…`);
  const started = Date.now();
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const img = missing[next++]!;
      await renderPicture(img, absPath(demo, img));
      if (++done % 500 === 0) log(`已画 ${done} / ${missing.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(2, availableParallelism()) }, worker));
  log(`画完了，用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒`);
}

async function renderPicture(img: ImageRow, file: string) {
  const scale = LONG_SIDE / Math.max(img.width, img.height);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const svg = placeholderSvg({ id: img.seed, width: img.width, height: img.height, hue: img.hue, outWidth: Math.max(8, Math.round(RENDER_SIDE * (width / Math.max(width, height)))) });
  const pipeline = sharp(Buffer.from(svg)).resize(width, height, { fit: 'fill' });
  const out = img.format === 'webp' ? pipeline.webp({ quality: 80 }) : pipeline.jpeg({ quality: 82 });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await out.toBuffer());
}
