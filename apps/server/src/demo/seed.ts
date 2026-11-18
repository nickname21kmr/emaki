/**
 * 把演示数据（DemoDb：fixtures.ts 的 buildDemoDb，或契约测试的 buildContractDb）灌进一个刚迁移完的空库。
 * 演示模式（demo/engine.ts）、契约测试和 scripts/seed-demo.ts 共用。
 *
 * 一个事务里按依赖顺序插入，返回演示 id → sqlite 整数 id 的映射。
 * 要在 SqliteDataSource.open 的 seed 选项里调用（迁移之后、启动修补之前）：灌进来的数据和真实图库一样，
 * 再经过启动时的合集重算、角色收拢、自动关联等步骤。
 *
 * 这里是单一写入者规则的永久例外（test/architecture/owners.ts 的 EXEMPT_DIRS）：直接写表，不经过命令。
 */
import { searchKey } from '@emaki/shared';
import type { Db } from '../db/connection.ts';
import { mockDominantColor, workColorFromHue } from '../util/color.ts';
import { CLASSIFIER_VERSION, isAnimated } from '../services/classify/rules.ts';
import { artScore, classifyTheme } from '../services/classify/theme.ts';
import { DETECTOR_VERSION } from '../domain/collections/detect.ts';
import { markSourcesCurrent } from '../services/source/backfill.ts';
import { patchSettingsInternal, type SettingsSection } from '../datasource/sqlite/settings.ts';
import type { DemoDb } from './fixtures.ts';

export interface IdMap {
  roots: Map<string, number>;
  works: Map<string, number>;
  characters: Map<string, number>;
  images: Map<string, number>;
  exclusions: Map<string, number>;
  duplicates: Map<string, number>;
  collections: Map<string, number>;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
/** 种子实体的创建时间放在很早，保证不影响「+N」计算 */
const SEED_CREATED = '2000-01-01T00:00:00.000Z';

export function seedDemoDb(db: Db, demo: DemoDb, opts: { now: number }): IdMap {
  const nowIso = new Date(opts.now).toISOString();
  const map: IdMap = {
    roots: new Map(),
    works: new Map(),
    characters: new Map(),
    images: new Map(),
    exclusions: new Map(),
    duplicates: new Map(),
    collections: new Map(),
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
    // 图库文件夹：导入时间、导入方式（漫画）、里面按漫画导入的子文件夹
    const insRoot = db.prepare(
      'INSERT INTO library_roots (path, enabled, last_scan_at, imported_at, content_mode, comic_rating) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insComicFolder = db.prepare('INSERT INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?)');
    for (const r of demo.settings.libraryRoots) {
      const id = Number(insRoot.run(r.path, r.enabled ? 1 : 0, r.lastScanAt, r.importedAt, r.mode === 'comic' ? 'comic' : 'auto', r.comicRating).lastInsertRowid);
      map.roots.set(r.id, id);
      for (const f of r.comicFolders) insComicFolder.run(id, f.relDir, f.comicRating, SEED_CREATED);
    }

    // 作品
    const insWork = db.prepare('INSERT INTO works (name, danbooru_tag, color, created_at) VALUES (?, ?, ?, ?)');
    for (const w of demo.works.values()) {
      const id = Number(insWork.run(w.name, w.danbooruTag, workColorFromHue(w.hue), SEED_CREATED).lastInsertRowid);
      map.works.set(w.id, id);
      addAliases('work', id, w.aliases);
    }

    // 角色
    const insChar = db.prepare(
      `INSERT INTO characters (name, danbooru_tag, source, pinned, cover_focus_x, cover_focus_y, name_locked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insCw = db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, ?)');
    for (const c of demo.characters.values()) {
      const id = Number(
        insChar.run(c.name, c.danbooruTag, c.source, c.pinned ? 1 : 0, c.coverFocus?.x ?? null, c.coverFocus?.y ?? null, c.nameLocked ? 1 : 0, SEED_CREATED)
          .lastInsertRowid,
      );
      map.characters.set(c.id, id);
      addAliases('character', id, c.aliases);
      c.workIds.forEach((wid, i) => insCw.run(id, need(map.works, wid, '作品'), i));
    }

    // 排除规则（image 类的 target 等图片插入后再改）
    const insEx = db.prepare('INSERT INTO exclusions (kind, target, label, created_at) VALUES (?, ?, ?, ?)');
    for (const e of demo.exclusions) {
      const target = e.kind === 'character' ? String(need(map.characters, e.target, '角色')) : e.target;
      map.exclusions.set(e.id, Number(insEx.run(e.kind, target, e.label, e.createdAt).lastInsertRowid));
    }

    // 合集（成员关系等图片插入后再写）
    const insCol = db.prepare(`INSERT INTO collections (root_id, rel_dir, kind, kind_source, kind_manual, title, title_manual, event, circle, artist,
        parody, translator, series_key, volume_no, series_manual, page_order, origin, state, evidence, detector_version, reviewed_at,
        created_at, updated_at, membership)
      VALUES (@root, @relDir, @kind, @kindSource, @kindManual, @title, @titleManual, @event, @circle, @artist, @parody, @translator,
        @seriesKey, @volumeNo, @seriesManual, @pageOrder, @origin, @state, @evidence, @detector, @reviewedAt, @createdAt, @updatedAt, @membership)`);
    for (const c of demo.collections.values()) {
      const id = Number(
        insCol.run({
          root: need(map.roots, c.rootId, '图库文件夹'),
          relDir: c.relDir,
          kind: c.kind,
          kindSource: c.kindSource,
          kindManual: c.kindManual ? 1 : 0,
          title: c.title,
          titleManual: c.titleManual ? 1 : 0,
          event: c.event,
          circle: c.circle,
          artist: c.artist,
          parody: c.parody,
          translator: c.translator,
          seriesKey: c.seriesKey,
          volumeNo: c.volumeNo,
          seriesManual: c.seriesManual ? 1 : 0,
          pageOrder: c.pageOrder,
          origin: c.origin,
          state: c.state,
          evidence: c.evidence,
          detector: DETECTOR_VERSION,
          reviewedAt: c.reviewedAt,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          membership: c.membership ?? 'folder',
        }).lastInsertRowid,
      );
      map.collections.set(c.id, id);
    }

    // 图片：观测列 + 分析结果 + 手动标记（分级、来源、原创、放下）
    const insImg = db.prepare(`INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, dominant_color,
        rating, rating_manual, favorite, source_site, source_post_id, source_artist, source_url, source_manual, added_at, modified_at, tagged_at,
        excluded_by, trashed_at, content_kind, content_kind_source, content_kind_evidence, content_kind_manual, content_kind_version, camera,
        frame_count, animated, shelved_at, original_at, collection_id, page_no, collection_detached)
      VALUES (@root, @relPath, @fileName, @width, @height, @bytes, @format, @sha256, @dominant, @rating, @ratingManual, @favorite,
        @site, @postId, @artist, @url, @sourceManual, @addedAt, @modifiedAt, @taggedAt, @excludedBy, @trashedAt,
        @kind, @kindSource, @kindEvidence, @kindManual, @kindVersion, '', @frames, @animated, @shelvedAt, @originalAt, @collectionId, @pageNo, @detached)`);
    for (const img of demo.images.values()) {
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
          ratingManual: img.ratingManual ? 1 : 0,
          favorite: img.favorite ? 1 : 0,
          site: img.source?.site ?? null,
          postId: img.source?.postId ?? null,
          artist: img.source?.artist ?? null,
          url: img.source?.url ?? null,
          sourceManual: img.sourceManual ? 1 : 0,
          addedAt: img.addedAt,
          modifiedAt: img.modifiedAt,
          taggedAt: img.tagged ? img.addedAt : null,
          excludedBy: img.excludedBy ? need(map.exclusions, img.excludedBy, '排除规则') : null,
          trashedAt: img.trashed ? nowIso : null,
          // 内容类型照演示数据导入（BI-7），版本写成当前值，启动回填不会改它
          kind: img.kind ?? 'illustration',
          kindSource: img.kindManual ? 'manual' : (img.kindSource ?? 'default'),
          kindEvidence: img.kindEvidence ?? null,
          kindManual: img.kindManual ? 1 : 0,
          kindVersion: CLASSIFIER_VERSION,
          // 是否动图按分析模块的规则算（D5），启动回填不会再改它
          frames: img.frameCount ?? null,
          animated: isAnimated({ format: img.format, frames: img.frameCount }) ? 1 : 0,
          shelvedAt: img.shelvedAt ?? null,
          originalAt: img.originalAt ?? null,
          collectionId: img.collectionId ? need(map.collections, img.collectionId, '合集') : null,
          pageNo: img.collectionId ? (img.pageNo ?? null) : null,
          detached: img.collectionDetached ? 1 : 0,
        }).lastInsertRowid,
      );
      map.images.set(img.id, id);
    }
    const fixEx = db.prepare("UPDATE exclusions SET target = ? WHERE id = ? AND kind = 'image'");
    for (const e of demo.exclusions) {
      if (e.kind === 'image') fixEx.run(String(need(map.images, e.target, '图片')), need(map.exclusions, e.id, '排除规则'));
    }

    // 合集的封面、手动加的角色和作品
    const setColCover = db.prepare('UPDATE collections SET cover_image_id = ? WHERE id = ?');
    const insColChar = db.prepare('INSERT OR IGNORE INTO collection_characters (collection_id, character_id, added_at) VALUES (?, ?, ?)');
    const insColWork = db.prepare('INSERT OR IGNORE INTO collection_works (collection_id, work_id, added_at) VALUES (?, ?, ?)');
    for (const c of demo.collections.values()) {
      const cid = map.collections.get(c.id)!;
      if (c.coverImageId) setColCover.run(need(map.images, c.coverImageId, '图片'), cid);
      for (const ch of c.manualCharacterIds) insColChar.run(cid, need(map.characters, ch, '角色'), c.updatedAt);
      for (const w of c.manualWorkIds) insColWork.run(cid, need(map.works, w, '作品'), c.updatedAt);
    }

    // 「原创」作品：有图归为原创时才建（图算不算原创作品由 original_at 派生，迁移 035）
    let originalWork: number | null = null;
    const originalWorkId = () => {
      originalWork ??=
        (db.prepare("SELECT id FROM works WHERE danbooru_tag = 'original'").pluck().get() as number | undefined) ??
        Number(db.prepare("INSERT INTO works (name, danbooru_tag, created_at) VALUES ('原创', 'original', ?)").run(SEED_CREATED).lastInsertRowid);
      return originalWork;
    };

    // 图片 ↔ 角色 / 作品 / 标签 / 建议 / 画师 / 否决
    // 演示数据的关联都当作模型自动认出的（来历 auto / tagger）
    const insIc = db.prepare(
      `INSERT OR IGNORE INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_score, added_at)
       VALUES (?, ?, 'auto', 'system:demo', 'auto-accept@1', 'tagger', 0.95, ?)`,
    );
    // 不经角色得到的作品：演示数据当作手动指定的作品（image_copyrights，迁移 035 之后只放手动指定的）
    const insIcr = db.prepare('INSERT OR IGNORE INTO image_copyrights (image_id, work_id) VALUES (?, ?)');
    const markOriginal = db.prepare("UPDATE images SET original_decision = 'manual', original_actor = 'user' WHERE id = ?");
    const insTag = db.prepare('INSERT INTO tags (name, category) VALUES (?, ?) ON CONFLICT(name) DO NOTHING');
    const findTag = db.prepare('SELECT id FROM tags WHERE name = ?').pluck();
    // 演示数据有十几万条图片标签，标签 id 记在内存里，每个标签只插一次、查一次
    const tagIds = new Map<string, number>();
    const tagId = (name: string, category: string): number => {
      let id = tagIds.get(name);
      if (id === undefined) {
        insTag.run(name, category);
        id = findTag.get(name) as number;
        tagIds.set(name, id);
      }
      return id;
    };
    const insIt = db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id, score) VALUES (?, ?, ?)');
    // 建议是派生的：演示数据的建议写成模型证据（v_character_suggestions 里还没关联的候选）
    const insSug = db.prepare("INSERT OR IGNORE INTO character_evidence (image_id, provider, tag, score) VALUES (?, 'tagger', ?, ?)");
    const setTheme = db.prepare('UPDATE images SET theme = ?, art_score = ? WHERE id = ?');
    const insArtist = db.prepare('INSERT OR IGNORE INTO image_artists (image_id, artist, score) VALUES (?, ?, ?)');
    const setArtist = db.prepare('UPDATE images SET artist_checked_at = ?, artist_manual = ? WHERE id = ?');
    const insVeto = db.prepare('INSERT OR IGNORE INTO character_vetoes (image_id, character_id, created_at) VALUES (?, ?, ?)');
    for (const img of demo.images.values()) {
      const iid = map.images.get(img.id)!;
      const viaChars = new Set<string>();
      for (const cid of img.characterIds) {
        insIc.run(iid, need(map.characters, cid, '角色'), img.addedAt);
        for (const w of demo.characters.get(cid)?.workIds ?? []) viaChars.add(w);
      }
      // 不经角色得到的作品（只有 copyright 没角色的图）
      for (const wid of img.copyrightWorkIds) if (!viaChars.has(wid)) insIcr.run(iid, need(map.works, wid, '作品'));
      if (img.originalAt) {
        originalWorkId();
        markOriginal.run(iid);
      }
      for (const t of img.tags) insIt.run(iid, tagId(t.tag, t.category), t.score);
      for (const [tag, score] of img.suggestions) insSug.run(iid, tag, score);
      for (const a of img.artists ?? []) insArtist.run(iid, a.tag, a.score);
      if (img.artists || img.artistsManual) setArtist.run(img.addedAt, img.artistsManual ? 1 : 0, iid);
      for (const cid of img.vetoedCharacterIds ?? []) insVeto.run(iid, need(map.characters, cid, '角色'), img.addedAt);
      // 主题和质量分：和识别写入时现算的一样（T27 补充第 8 条）
      if (img.tagged) {
        const general = img.tags.filter((t) => t.category === 'general').map((t) => [t.tag, t.score] as [string, number]);
        const score = artScore({ w: img.width, h: img.height, fileName: img.fileName }, general);
        setTheme.run(classifyTheme(general, score), score, iid);
      }
    }

    // 画师的手动拆开（group_tag 为 NULL）/ 合并
    const insLink = db.prepare('INSERT INTO artist_links (tag, group_tag, created_at) VALUES (?, ?, ?)');
    for (const [tag, group] of demo.artistLinks ?? []) insLink.run(tag, group, SEED_CREATED);

    // 重复组
    const insGroup = db.prepare(
      'INSERT INTO duplicate_groups (kind, similarity, suggested_keep_id, resolved_at, ignored, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    );
    const insMember = db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (?, ?)');
    for (const d of demo.duplicates) {
      const gid = Number(
        insGroup.run(d.kind, d.similarity, need(map.images, d.suggestedKeepId, '图片'), d.resolved ? nowIso : null, nowIso)
          .lastInsertRowid,
      );
      map.duplicates.set(d.id, gid);
      for (const iid of d.imageIds) insMember.run(gid, need(map.images, iid, '图片'));
    }

    // 封面 + 「+N」还原：把 last_seen_at 设在第 N+1 新的关联上
    // 种子里写明的封面默认算「用户设的」（T25.5 cover_manual），其余交给自动选图
    const setChar = db.prepare('UPDATE characters SET cover_image_id = ?, cover_manual = ?, last_seen_at = ? WHERE id = ?');
    for (const c of demo.characters.values()) {
      const counted = [...demo.images.values()]
        .filter((img) => img.characterIds.includes(c.id) && !img.excludedBy && !img.trashed)
        .map((img) => img.addedAt)
        .sort()
        .reverse();
      const n = c.newCount;
      const lastSeen = n === 0 ? nowIso : n >= counted.length ? EPOCH : counted[n]!;
      const manual = c.coverManual ?? !!c.coverImageId;
      setChar.run(c.coverImageId ? need(map.images, c.coverImageId, '图片') : null, manual ? 1 : 0, lastSeen, map.characters.get(c.id)!);
    }

    // 各节设置（hasApiKey 是读出来的，不存）
    const { libraryRoots: _roots, ...sections } = demo.settings;
    for (const [key, value] of Object.entries(sections) as [SettingsSection, Record<string, unknown>][]) {
      const { hasApiKey: _key, ...rest } = value;
      patchSettingsInternal(db, key, rest);
    }
    // 来源已经是按当前解析规则算好的：启动时不再按文件名重算（演示数据的来源带画师名，文件名里没有）
    markSourcesCurrent(db, demo.settings.tagger.pixivFilenameMode);
  })();

  return map;
}
