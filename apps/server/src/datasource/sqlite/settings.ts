/**
 * 设置的默认值、读写和图库路径工具。其他任务直接 import 这里的模块级函数（第一个参数是 db）。
 */
import type { CustomTheme, Settings } from '@emaki/shared';
import path from 'node:path';
import type { Db } from '../../db/connection.ts';
import { BadRequestError } from '../../http/errors.ts';

export const SETTINGS_KEYS = {
  tagger: 'tagger',
  danbooru: 'danbooru',
  dedupe: 'dedupe',
  ui: 'ui',
  browse: 'browse',
  danbooruApiKey: 'secret.danbooruApiKey',
} as const;

export type SettingsSection = 'tagger' | 'danbooru' | 'dedupe' | 'ui' | 'browse';

export const DEFAULT_SETTINGS = {
  tagger: {
    model: 'A1yCE/pixai-tagger-v1.0-onnx-fp16',
    device: 'dml',
    generalThreshold: 0.35,
    characterThreshold: 0.35,
    autoAcceptThreshold: 0.85,
    batchSize: 8,
    legacyModel: 'SmilingWolf/wd-eva02-large-tagger-v3' as string | null,
    legacyBefore: '2024-03-01' as string | null,
    skipCameraPhotos: true,
    retryOld: false,
    keepAwake: true,
    artists: false,
  },
  // 不存 hasApiKey；默认不联网，T21 的引导里让用户选
  danbooru: { enabled: false, username: '', lastSyncAt: null as string | null },
  dedupe: { hammingThreshold: 8, lastRunAt: null as string | null },
  ui: { theme: 'system', blurSensitive: true, density: 'comfortable' },
  browse: { customThemes: [] as CustomTheme[] },
} as const;

const SECTIONS: SettingsSection[] = ['tagger', 'danbooru', 'dedupe', 'ui', 'browse'];

function readRaw(db: Db): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

function parseSection(key: SettingsSection, raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    console.warn(`设置 ${key} 的 JSON 损坏，使用默认值`);
    return {};
  }
}

/** 读全部设置（不含 libraryRoots）；新增字段自动有默认值 */
export function readSettings(db: Db): Omit<Settings, 'libraryRoots'> {
  const raw = readRaw(db);
  const merged = Object.fromEntries(
    SECTIONS.map((k) => [k, { ...DEFAULT_SETTINGS[k], ...parseSection(k, raw.get(SETTINGS_KEYS[k])) }]),
  ) as unknown as Omit<Settings, 'libraryRoots'>;
  merged.danbooru = { ...merged.danbooru, hasApiKey: raw.has(SETTINGS_KEYS.danbooruApiKey) };
  return merged;
}

function writeSection(db: Db, key: SettingsSection, value: Record<string, unknown>): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    SETTINGS_KEYS[key],
    JSON.stringify(value),
  );
}

/** 用户改设置：按段浅合并；danbooru 的 hasApiKey / lastSyncAt、dedupe 的 lastRunAt 只允许后端写 */
export function applySettingsPatch(
  db: Db,
  body: Partial<Record<SettingsSection, Record<string, unknown>>> & { danbooruApiKey?: string },
): void {
  const current = readSettings(db) as unknown as Record<SettingsSection, Record<string, unknown>>;
  db.transaction(() => {
    for (const k of SECTIONS) {
      const patch = body[k];
      if (!patch) continue;
      const merged: Record<string, unknown> = { ...current[k], ...patch };
      if (k === 'danbooru') {
        delete merged.hasApiKey;
        merged.lastSyncAt = current.danbooru.lastSyncAt ?? null;
      }
      if (k === 'dedupe') merged.lastRunAt = current.dedupe.lastRunAt ?? null;
      writeSection(db, k, merged);
    }
    const key = body.danbooruApiKey;
    if (key !== undefined) {
      if (key.trim() === '') db.prepare('DELETE FROM settings WHERE key = ?').run(SETTINGS_KEYS.danbooruApiKey);
      else
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
          SETTINGS_KEYS.danbooruApiKey,
          JSON.stringify(key.trim()),
        );
    }
  })();
}

/** 后端内部改设置（例如 T11 写 danbooru.lastSyncAt），不触发 touch */
export function patchSettingsInternal(db: Db, key: SettingsSection, patch: Record<string, unknown>): void {
  const current = readSettings(db) as unknown as Record<SettingsSection, Record<string, unknown>>;
  const merged = { ...current[key], ...patch };
  if (key === 'danbooru') delete merged.hasApiKey;
  writeSection(db, key, merged);
}

export function getDanbooruApiKey(db: Db): string | null {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(SETTINGS_KEYS.danbooruApiKey) as
    | string
    | undefined;
  if (raw === undefined) return null;
  try {
    return String(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 路径工具（T03 / T08 / T17 复用）

export function normalizeRootPath(input: string): string {
  let p = input.trim().replace(/^"(.*)"$/, '$1'); // 资源管理器「复制为路径」会带引号
  if (!p) throw new BadRequestError('路径不能为空');
  if (/^[a-zA-Z]:$/.test(p)) p += '/'; // 裸盘符「D:」按盘符根处理（path.isAbsolute('D:') 是 false）
  if (!path.isAbsolute(p)) throw new BadRequestError('请填写完整路径，例如 D:/Pictures/插画');
  p = path.resolve(p).split(path.win32.sep).join('/');
  if (/^[a-zA-Z]:[/]?$/.test(p)) return `${p[0]!.toUpperCase()}:/`; // 盘符根目录保留斜杠
  p = p.replace(/[/]+$/, '');
  return /^[a-z]:/.test(p) ? p[0]!.toUpperCase() + p.slice(1) : p;
}

/** Windows 路径不区分大小写 */
export const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const isInside = (child: string, parent: string) =>
  child.toLowerCase().startsWith(parent.toLowerCase().replace(/[/]$/, '') + '/');
