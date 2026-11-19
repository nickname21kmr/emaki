/**
 * 单张图片：详情、修改（类型、来源、角色、分级、收藏，一起撤销）、缩略图和原图文件、在资源管理器里显示。
 * 从 SqliteDataSource 拆出来；它只负责把请求转过来。
 */
import type { ID, ImageDetail, ImageFormat, MutationResult, ThumbWidth, UpdateImageBody } from '@emaki/shared';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError } from '../../http/errors.ts';
import type { CollectionService, CollectionsHook } from '../../services/collections/CollectionService.ts';
import { sha256Buffer } from '../../services/fs/hash.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { revealInFileManager } from '../../services/fs/reveal.ts';
import { htmlAnimationCache, readHtmlAnimation } from '../../services/image/htmlAnimation.ts';
import type { ThumbnailService, ThumbRow } from '../../services/image/ThumbnailService.ts';
import { editedSource } from '../../services/source/editSource.ts';
import type { FileResponse } from '../DataSource.ts';
import { imageArtists } from './artists.ts';
import type { SqliteContext } from './context.ts';
import { requireCharacterId, requireVisibleImages } from './guards.ts';
import { describeKindReason, hydrateImages, IMAGE_COLS, type ImageRow } from './hydrate.ts';
import { assertKindValue, KIND_LABEL, setKindInTx, type KindDeps } from './kinds.ts';
import { dismissPixivCharacterChecks } from './pixivChecks.ts';
import type { MakeCatalog } from './settingsOps.ts';
import { readSettings } from './settings.ts';
import { iso, MIME, parseId, toId, VISIBLE } from './sql.ts';
import { loadSuggestions } from './suggestions.ts';
import { vetoRemovedCharacter } from './vetoes.ts';

export class ImageOps {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly thumbs: ThumbnailService,
    private readonly kindDeps: KindDeps,
    private readonly collectionsHook: CollectionsHook,
    /** 改来源后按同一投稿重算组图 */
    private readonly collections: CollectionService,
    private readonly getMakeCatalog: () => MakeCatalog,
    private readonly waitForFile?: (absPath: string) => Promise<void>,
  ) {}

  private makeCatalog() {
    return this.getMakeCatalog()();
  }

  async getImage(id: ID): Promise<ImageDetail | null> {
    const n = parseId(id);
    if (n === null) return null;
    const row = this.ctx
      .stmt(`SELECT ${IMAGE_COLS}, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ? AND ${VISIBLE}`)
      .get(n) as (ImageRow & { root_path: string }) | undefined;
    if (!row) return null;
    const [item] = hydrateImages(this.ctx.db, [row]);
    const tags = this.ctx
      .stmt(
        'SELECT t.name AS tag, t.category, it.score FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? ORDER BY it.score DESC',
      )
      .all(n) as ImageDetail['tags'];
    return {
      ...item!,
      // 反斜杠的原生路径，方便用户复制
      absPath: path.normalize(toAbs(row.root_path, row.rel_path)),
      tags,
      characterSuggestions: loadSuggestions(this.ctx, [n], this.makeCatalog().catalog).get(n) ?? [],
      kindSource: row.content_kind_manual ? 'manual' : row.content_kind_source,
      kindReason: row.content_kind_manual ? null : describeKindReason(row.content_kind_source, row.content_kind_evidence),
      collection: this.imageCollection(n),
      artists: imageArtists(this.ctx.db, n),
      sourceManual: !!this.ctx.stmt('SELECT source_manual FROM images WHERE id = ?').pluck().get(n),
      artistsManual: !!this.ctx.stmt('SELECT artist_manual FROM images WHERE id = ?').pluck().get(n),
    };
  }

  /** 看图器「收录于」：pageNo 是可见页里的序号（RV-C-8） */
  private imageCollection(imageId: number): ImageDetail['collection'] {
    const r = this.ctx
      .stmt(
        `SELECT c.id, c.kind, c.title, c.volume_no, c.rel_dir,
           (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id AND x.page_no <= i.page_no) AS ord,
           (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id) AS n
         FROM images i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.state = 'active'`,
      )
      .get(imageId) as
      | { id: number; kind: 'doujin' | 'artbook' | 'group'; title: string | null; volume_no: number | null; rel_dir: string; ord: number; n: number }
      | undefined;
    if (!r) return null;
    return {
      id: toId(r.id),
      kind: r.kind,
      title: r.title,
      pageNo: Math.max(1, r.ord),
      pageCount: r.n,
      volumeNo: r.volume_no,
      folderName: r.rel_dir.slice(r.rel_dir.lastIndexOf('/') + 1),
    };
  }

  async updateImage(id: ID, body: UpdateImageBody): Promise<MutationResult> {
    const iid = requireVisibleImages(this.ctx, [id])[0]!;
    if (body.kind !== undefined) assertKindValue(body.kind);
    const charIds = body.characterIds ? [...new Set(body.characterIds)].map((c) => requireCharacterId(this.ctx, c)) : null;
    const now = iso(this.ctx.clock());
    const sourceEdit = body.source === undefined ? undefined : editedSource(body.source, this.ctx.stmt('SELECT rel_path FROM images WHERE id = ?').pluck().get(iid) as string,
      readSettings(this.ctx.db).tagger.pixivFilenameMode);
    // 类型、收藏、分级、角色放进同一次 mutate：一起传时一个 token 撤销全部
    return this.ctx.mutate((u) => {
      // 提示文案：收藏 > 分级 > 角色 > 类型，只报一条
      let message = '';
      if (sourceEdit) {
        const newKey = sourceEdit.source?.postId ? sourceEdit.source.site + ':' + sourceEdit.source.postId : null;
        const oldKey = this.ctx.db.prepare("SELECT source_site || ':' || source_post_id FROM images WHERE id = ?").pluck().get(iid) as string | null;
        const affected = this.ctx.db.prepare(`SELECT id FROM images WHERE id = @iid OR source_site || ':' || source_post_id IN (@old, @next)
          OR collection_id = (SELECT collection_id FROM images WHERE id = @iid)`).pluck().all({ iid, old: oldKey, next: newKey }) as number[];
        u.columns('images', ['collection_id', 'page_no', 'collection_detached'], affected);
        const existingGroups = new Set(this.ctx.db.prepare('SELECT id FROM collections').pluck().all() as number[]);
        u.columns('images', ['source_site', 'source_post_id', 'source_artist', 'source_url', 'source_manual'], [iid]);
        const src = sourceEdit.source;
        this.ctx.stmt('UPDATE images SET source_site=?, source_post_id=?, source_artist=?, source_url=?, source_manual=? WHERE id=?')
          .run(src?.site ?? null, src?.postId ?? null, src?.artist ?? null, src?.url ?? null, sourceEdit.manual ? 1 : 0, iid);
        this.collections.refreshSources([iid]);
        for (const id of this.ctx.db.prepare('SELECT id FROM collections').pluck().all() as number[]) if (!existingGroups.has(id)) u.inserted('collections', id);
        message = sourceEdit.manual ? (src ? '已确认来源' : '已清除来源') : '已恢复自动来源';
      }
      if (body.kind !== undefined) {
        const value = body.kind;
        setKindInTx(this.ctx, u, [iid], value, this.kindDeps);
        this.collectionsHook(u, [iid]);
        message = value === 'auto' ? '已恢复自动判断' : `已标为「${KIND_LABEL[value]}」`;
      }
      const cols = [
        ...(body.rating ? ['rating', 'rating_manual'] : []),
        ...(body.favorite !== undefined ? ['favorite'] : []),
      ];
      u.columns('images', cols, [iid]);
      if (charIds) {
        u.set('image_characters', 'image_id = ?', [iid]);
        const ids = JSON.stringify(charIds);
        const removed = this.ctx.stmt('SELECT 1 FROM image_characters WHERE image_id = ? AND character_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1').get(iid,ids);
        if (removed) dismissPixivCharacterChecks(this.ctx.db,u,[iid],now);
        // 去掉的角色记下来，重新识别时不再加回（撤销时一起去掉）
        const gone = this.ctx.stmt('SELECT character_id FROM image_characters WHERE image_id = ? AND character_id NOT IN (SELECT value FROM json_each(?))').pluck().all(iid, ids) as number[];
        for (const cid of gone) vetoRemovedCharacter(this.ctx.db, u, cid, [iid], now);
        this.ctx.stmt('DELETE FROM image_characters WHERE image_id = @iid AND character_id NOT IN (SELECT value FROM json_each(@ids))').run({ iid, ids });
        this.ctx
          .stmt(
            `INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at)
             SELECT @iid, value, 'manual', NULL, @now FROM json_each(@ids)`,
          )
          .run({ iid, ids, now });
        message = '已更新角色';
      }
      // 手动改分级要记下来：T10 重打标签时不覆盖
      if (body.rating) {
        this.ctx.stmt('UPDATE images SET rating = ?, rating_manual = 1 WHERE id = ?').run(body.rating, iid);
        message = '已修改分级';
      }
      if (body.favorite !== undefined) {
        this.ctx.stmt('UPDATE images SET favorite = ? WHERE id = ?').run(body.favorite ? 1 : 0, iid);
        message = body.favorite ? '已收藏' : '已取消收藏';
      }
      return { message: message || '已更新' };
    });
  }
  async getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null> {
    const n = parseId(id);
    if (n === null) return null;
    // 不要求「可见」：排除页和已处理的重复组都要显示被排除或已删除图片的缩略图
    const row = this.ctx
      .stmt('SELECT i.id, i.sha256, i.format, i.rel_path, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
      .get(n) as ThumbRow | undefined;
    if (!row) return null;
    const file = await this.thumbs.ensure(row, width);
    if (!file) return null;
    // 图片 id 稳定（内容变了 id 不变），所以不能用 immutable，按内容 sha 做 ETag
    return {
      kind: 'path',
      contentType: 'image/webp',
      filePath: file,
      etag: `"${row.sha256.slice(0, 20)}-${width}"`,
      cacheControl: 'private, no-cache',
    };
  }

  /** 不要求可见；文件不在了返回 null → 404 */
  async getOriginal(id: ID): Promise<FileResponse | null> {
    const n = parseId(id);
    if (n === null) return null;
    const row = this.ctx
      .stmt('SELECT i.sha256, i.format, i.rel_path, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
      .get(n) as { sha256: string; format: ImageFormat; rel_path: string; root_path: string } | undefined;
    if (!row) return null;
    const abs = toAbs(row.root_path, row.rel_path);
    await this.waitForFile?.(abs);
    try {
      await access(abs);
    } catch {
      return null;
    }
    const html = row.format === 'html' ? await readHtmlAnimation(abs) : null;
    const sha = html ? sha256Buffer(html) : row.sha256;
    const filePath = html ? await htmlAnimationCache(html,this.ctx.dataDir,sha) : abs;
    return { kind: 'path', contentType: MIME[row.format], filePath, etag: `"${sha.slice(0, 20)}"`, cacheControl: 'private, no-cache' };
  }

  async revealImage(id: ID): Promise<void> {
    const n = requireVisibleImages(this.ctx, [id])[0]!;
    const row = this.ctx
      .stmt('SELECT i.rel_path, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
      .get(n) as { rel_path: string; root_path: string };
    const abs = toAbs(row.root_path, row.rel_path);
    try {
      await access(abs);
    } catch {
      throw new NotFoundError('文件（可能已被移动或删除）');
    }
    await revealInFileManager(abs);
  }
}
