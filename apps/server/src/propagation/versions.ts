/**
 * 派生数据的版本（P4a，附录 #23；docs/core-architecture.md 第 2.1 节「派生：带版本号，版本变了就重算」）。
 *
 * 每种能整体重算的派生数据有一个名字和一个版本：
 * - 'source'：文件名解析出的来源（SOURCE_PARSER_VERSION + Pixiv 投稿号的识别方式）；
 * - 'classification'：自动类型、主题、画质分（CLASSIFIER_VERSION；每行另有 content_kind_version，只重算过期的行）；
 * - 'collections'：按文件夹成册的判定（DETECTOR_VERSION）。
 * 库里（derived_versions 表，迁移 037）记下每种「上次整体重算用的版本」。启动时逐个对一遍（refreshDerived）：
 * 对不上（包括从没记过）就整体重算一次，再记下现在的版本。改了规则只要把版本号加一，不用再写迁移。
 * 以前来源记在 settings 的两个键里、合集判定的版本存了从不检查，各管各的。
 */
import type { Db } from '../db/connection.ts';
import type { UndoRecorder } from '../datasource/sqlite/undo.ts';

export type DerivedName = 'source' | 'classification' | 'collections';

/** 一种派生数据：现在的版本、版本对不上时怎么整体重算 */
export interface DerivedSet {
  name: DerivedName;
  version(db: Db): string;
  /** 整体重算。调用方开事务、声明变化（重算本身可以分批开自己的事务） */
  rebuild(): void;
}

/** 上次整体重算用的版本；没记过是 null */
export function recordedVersion(db: Db, name: DerivedName): string | null {
  return (db.prepare('SELECT version FROM derived_versions WHERE name = ?').pluck().get(name) as string | undefined) ?? null;
}

export function markVersion(db: Db, name: DerivedName, version: string, at: string): void {
  db.prepare(
    'INSERT INTO derived_versions (name, version, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at',
  ).run(name, version, at);
}

/** 版本对不上（或者从没记过） */
export function isStale(db: Db, set: Pick<DerivedSet, 'name' | 'version'>): boolean {
  return recordedVersion(db, set.name) !== set.version(db);
}

/** 撤销用：记下这一种的版本记录（改识别方式这种连带改了版本记录的操作，撤销时放回去） */
export function snapshotVersion(u: UndoRecorder, name: DerivedName): void {
  u.set('derived_versions', 'name = ?', [name]);
}

/** 版本对不上的整体重算一次并记下新版本；返回重算了哪些 */
export function refreshDerived(db: Db, sets: readonly DerivedSet[], at: string): DerivedName[] {
  const out: DerivedName[] = [];
  for (const s of sets) {
    const v = s.version(db);
    if (recordedVersion(db, s.name) === v) continue;
    s.rebuild();
    markVersion(db, s.name, v, at);
    out.push(s.name);
  }
  return out;
}
