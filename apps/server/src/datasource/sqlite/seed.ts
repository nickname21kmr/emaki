/**
 * 把 mock 的假数据导入 SQLite：开发、演示和契约测试共用。
 * 一个事务里按依赖顺序插入，返回 mock id → sqlite 整数 id 的映射。
 */
import { searchKey } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { mockDominantColor, workColorFromHue } from '../../util/color.ts';
import { CLASSIFIER_VERSION } from '../../services/classify/rules.ts';
import { artScore, classifyTheme } from '../../services/classify/theme.ts';
import type { MockDb } from '../mock/fixtures.ts';

export interface IdMap {
  roots: Map<string, number>;
  works: Map<string, number>;
  characters: Map<string, number>;
  images: Map<string, number>;
  exclusions: Map<string, number>;
  duplicates: Map<string, number>;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
/** 种子实体的创建时间放在很早，保证不影响「+N」计算 */
const SEED_CREATED = '2000-01-01T00:00:00.000Z';

export function seedFromMockDb(db: Db, mock: MockDb, opts: { now: number }): IdMap {
  const nowIso = new Date(opts.now).toISOString();
  const map: IdMap = {
    roots: new Map(),
    works: new Map(),
    characters: new Map(),
    images: new Map(),
    exclusions: new Map(),
    duplicates: new Map(),
  };
  const need = (m: Map<string, number>, key: string, what: string) => {
    const v = m.get(key);
    if (v === undefined) throw new Error(`种子数据引用了不存在的${what}：${key}`);
    return v;
  };

  const insertAlias = db.prepare(
    'INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  const addAliases = (type: 'character' | 'work', id: number, aliases: string[]) =>
    aliases.forEach((a, i) => insertAlias.run(type, id, a, searchKey(a), 'user', i));

  db.transaction(() => {
    // 图库文件夹
    const insRoot = db.prepare('INSERT INTO library_roots (path, enabled, last_scan_at) VALUES (?, ?, ?)');
    for (const r of mock.settings.libraryRoots) {
      map.roots.set(r.id, Number(insRoot.run(r.path, r.enabled ? 1 : 0, r.lastScanAt).lastInsertRowid));
    }

    // 作品
    const insWork = db.prepare('INSERT INTO works (name, danbooru_tag, color, created_at) VALUES (?, ?, ?, ?)');
    for (const w of mock.works.values()) {
      const id = Number(insWork.run(w.name, w.danbooruTag, workColorFromHue(w.hue), SEED_CREATED).lastInsertRowid);
      map.works.set(w.id, id);
      addAliases('work', id, w.aliases);
    }

    // 角色
    const insChar = db.prepare(
      'INSERT INTO characters (name, danbooru_tag, source, pinned, cover_focus_x, cover_focus_y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insCw = db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, ?)');
    for (const c of mock.characters.values()) {
      const id = Number(
        insChar.run(c.name, c.danbooruTag, c.source, c.pinned ? 1 : 0, c.coverFocus?.x ?? null, c.coverFocus?.y ?? null, SEED_CREATED)
          .lastInsertRowid,
      );
      map.characters.set(c.id, id);
      addAliases('character', id, c.aliases);
      c.workIds.forEach((wid, i) => insCw.run(id, need(map.works, wid, '作品'), i));
    }

    // 排除规则（image 类的 target 等图片插入后再改）
    const insEx = db.prepare('INSERT INTO exclusions (kind, target, label, created_at) VALUES (?, ?, ?, ?)');
    for (const e of mock.exclusions) {
      const target = e.kind === 'character' ? String(need(map.characters, e.target, '角色')) : e.target;
      map.exclusions.set(e.id, Number(insEx.run(e.kind, target, e.label, e.createdAt).lastInsertRowid));
    }

    // 图片
    const insImg = db.prepare(`INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, dominant_color,
        rating, favorite, source_site, source_post_id, source_artist, source_url, added_at, modified_at, tagged_at, excluded_by, trashed_at,
        content_kind, content_kind_source, content_kind_evidence, content_kind_manual, content_kind_version, camera, shelved_at)
      VALUES (@root, @relPath, @fileName, @width, @height, @bytes, @format, @sha256, @dominant, @rating, @favorite,
        @site, @postId, @artist, @url, @addedAt, @modifiedAt, @taggedAt, @excludedBy, @trashedAt,
        @kind, @kindSource, @kindEvidence, @kindManual, @kindVersion, '', @shelvedAt)`);
    for (const img of mock.images.values()) {
      const id = Number(
        insImg.run({
          root: need(map.roots, img.libraryRootId, '图库文件夹'),
          relPath: img.relPath,
          fileName: img.fileName,
          width: img.width,
          height: img.height,
          bytes: img.bytes,
          format: img.format,
          sha256: `seed:${img.id}`,
          dominant: mockDominantColor(img.hue, img.id),
          rating: img.rating,
          favorite: img.favorite ? 1 : 0,
          site: img.source?.site ?? null,
          postId: img.source?.postId ?? null,
          artist: img.source?.artist ?? null,
          url: img.source?.url ?? null,
          addedAt: img.addedAt,
          modifiedAt: img.modifiedAt,
          taggedAt: img.tagged ? img.addedAt : null,
          excludedBy: img.excludedBy ? need(map.exclusions, img.excludedBy, '排除规则') : null,
          trashedAt: img.trashed ? nowIso : null,
          // 内容类型照 mock 导入（BI-7），版本写成当前值，启动回填不会改它
          kind: img.kind ?? 'illustration',
          kindSource: img.kindManual ? 'manual' : (img.kindSource ?? 'default'),
          kindEvidence: img.kindEvidence ?? null,
          kindManual: img.kindManual ? 1 : 0,
          kindVersion: CLASSIFIER_VERSION,
          shelvedAt: img.shelvedAt ?? null,
        }).lastInsertRowid,
      );
      map.images.set(img.id, id);
    }
    const fixEx = db.prepare("UPDATE exclusions SET target = ? WHERE id = ? AND kind = 'image'");
    for (const e of mock.exclusions) {
      if (e.kind === 'image') fixEx.run(String(need(map.images, e.target, '图片')), need(map.exclusions, e.id, '排除规则'));
    }

    // 图片 ↔ 角色 / 作品 / 标签 / 建议
    const insIc = db.prepare(
      "INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', 0.95, ?)",
    );
    const insIcr = db.prepare('INSERT OR IGNORE INTO image_copyrights (image_id, work_id, score) VALUES (?, ?, NULL)');
    const insTag = db.prepare('INSERT INTO tags (name, category) VALUES (?, ?) ON CONFLICT(name) DO NOTHING');
    const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').pluck();
    const insIt = db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id, score) VALUES (?, ?, ?)');
    const insSug = db.prepare('INSERT OR IGNORE INTO character_suggestions (image_id, danbooru_tag, score) VALUES (?, ?, ?)');
    const setTheme = db.prepare('UPDATE images SET theme = ?, art_score = ? WHERE id = ?');
    const insArtist = db.prepare('INSERT OR IGNORE INTO image_artists (image_id, artist, score) VALUES (?, ?, ?)');
    const setArtist = db.prepare('UPDATE images SET artist_checked_at = ?, artist_manual = ? WHERE id = ?');
    for (const img of mock.images.values()) {
      const iid = map.images.get(img.id)!;
      const viaChars = new Set<string>();
      for (const cid of img.characterIds) {
        insIc.run(iid, need(map.characters, cid, '角色'), img.addedAt);
        for (const w of mock.characters.get(cid)?.workIds ?? []) viaChars.add(w);
      }
      // 不经角色得到的作品（只有 copyright 没角色的图）
      for (const wid of img.copyrightWorkIds) if (!viaChars.has(wid)) insIcr.run(iid, need(map.works, wid, '作品'));
      for (const t of img.tags) {
        insTag.run(t.tag, t.category);
        insIt.run(iid, tagId.get(t.tag), t.score);
      }
      for (const [tag, score] of img.suggestions) insSug.run(iid, tag, score);
      for (const a of img.artists ?? []) insArtist.run(iid, a.tag, a.score);
      if (img.artists || img.artistsManual) setArtist.run(img.addedAt, img.artistsManual ? 1 : 0, iid);
      // 主题和质量分：与 mock 现算一致（T27 补充第 8 条）
      if (img.tagged) {
        const general = img.tags.filter((t) => t.category === 'general').map((t) => [t.tag, t.score] as [string, number]);
        const score = artScore({ w: img.width, h: img.height, fileName: img.fileName }, general);
        setTheme.run(classifyTheme(general, score), score, iid);
      }
    }

    // 重复组
    const insGroup = db.prepare(
      'INSERT INTO duplicate_groups (kind, similarity, suggested_keep_id, resolved_at, ignored, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    );
    const insMember = db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (?, ?)');
    for (const d of mock.duplicates) {
      const gid = Number(
        insGroup.run(d.kind, d.similarity, need(map.images, d.suggestedKeepId, '图片'), d.resolved ? nowIso : null, nowIso)
          .lastInsertRowid,
      );
      map.duplicates.set(d.id, gid);
      for (const iid of d.imageIds) insMember.run(gid, need(map.images, iid, '图片'));
    }

    // 封面 + 「+N」还原：把 last_seen_at 设在第 N+1 新的关联上
    // 种子里写明的封面都是「用户设的」（T25.5 cover_manual），其余交给自动选图
    const setChar = db.prepare('UPDATE characters SET cover_image_id = ?, cover_manual = ?, last_seen_at = ? WHERE id = ?');
    for (const c of mock.characters.values()) {
      const counted = [...mock.images.values()]
        .filter((img) => img.characterIds.includes(c.id) && !img.excludedBy && !img.trashed)
        .map((img) => img.addedAt)
        .sort()
        .reverse();
      const n = c.newCount;
      const lastSeen = n === 0 ? nowIso : n >= counted.length ? EPOCH : counted[n]!;
      setChar.run(c.coverImageId ? need(map.images, c.coverImageId, '图片') : null, c.coverImageId ? 1 : 0, lastSeen, map.characters.get(c.id)!);
    }
  })();

  return map;
}
