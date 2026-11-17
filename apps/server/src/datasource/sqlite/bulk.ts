/**
 * 批量操作（T18）。assign / unassign / exclude / restore / favorite / rating / kind / artist 可撤销；
 * trash 先只在库里标记、记一批待移（pendingTrash.ts），最近几次可撤销；挤出窗口后才真的移到系统回收站（绝不永久删除）。
 * 每个操作只写自己的事实并声明变化；套排除规则、重算合集、Pixiv 排队、画师补跑等连带处理由反应完成（P2）。
 * 角色、收藏、分级、放下、原创经归类模块的命令写（domain/curation，P3a）。
 */
import type { BulkImagesBody, MutationResult, Rating } from '@emaki/shared';
import { NotFoundError } from '../../http/errors.ts';
import { toAbs } from '../../services/fs/paths.ts';
import type { SqliteContext } from './context.ts';
import type { PendingTrash } from './pendingTrash.ts';
import { artistAutoMessage, artistEditMessage, normArtists } from '../artistEdits.ts';
import { artistGroupMap, artistNames } from './artists.ts';
import { createExclusionInTx, restoreImagesInTx } from '../../domain/visibility/exclusions.ts';
import { assertKindValue, setKindInTx, type KindDeps } from './kinds.ts';
import { iso, parseId } from './sql.ts';
import { resolveSuggestedCharacter } from './suggestions.ts';
import { link, unlinkByUser } from '../../domain/curation/links.ts';
import { setFavorite, setOriginal, setRating, setShelved } from '../../domain/curation/marks.ts';
import { resetArtists, setManualArtists } from '../../domain/curation/artists.ts';
import { ensureOriginalWork } from '../../domain/catalog/original.ts';
import { manual } from '../../domain/curation/provenance.ts';

export const RATING_LABEL: Record<Rating, string> = { general: '全年龄', sensitive: '轻微', questionable: '较敏感', explicit: '限制级' };

export class BulkOps {
  constructor(
    private readonly ctx: SqliteContext,
    /** T05 的 requireVisibleImages：任意一个不可见或不存在 → NotFoundError，不做任何改动 */
    private readonly requireVisible: (ids: string[]) => number[],
    private readonly kindDeps: KindDeps,
    private readonly pending: PendingTrash,
  ) {}

  private characterName(idStr: string): { id: number; name: string } {
    const id = parseId(idStr);
    const row = id === null ? undefined : this.ctx.stmt('SELECT id, name FROM characters WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('角色');
    return row as { id: number; name: string };
  }

  async run(body: BulkImagesBody): Promise<MutationResult> {
    const ids = this.requireVisible([...new Set(body.ids)]);
    const n = ids.length;
    const db = this.ctx.db;
    const json = JSON.stringify(ids);
    const now = iso(this.ctx.clock());
    const a = body.action;

    switch (a.type) {
      case 'assign':
      case 'assignTag': {
        return this.ctx.mutate((u) => {
          const ch = a.type === 'assign' ? this.characterName(a.characterId)
            : this.characterName(String(resolveSuggestedCharacter(this.ctx, u, this.kindDeps.catalog(), a.danbooruTag, now)));
          // 用户手动归的：已有的关联保持原来的来历；去掉过的清掉否决（D3）。按角色、按标签都一样，新关联的图由反应套排除规则（附录 #14）
          link(this.ctx, u, ids, [ch.id], manual(now));
          return { message: `已将 ${n} 张图归到「${ch.name}」` };
        });
      }
      case 'unassign': {
        const ch = this.characterName(a.characterId);
        return this.ctx.mutate((u) => {
          // 手动去掉的角色记否决：重新识别、Pixiv 补充都不再加回来
          unlinkByUser(this.ctx, u, ids, [ch.id], now);
          return { message: `已从「${ch.name}」移除 ${n} 张图` };
        });
      }
      case 'exclude':
        return this.ctx.mutate((u) => {
          const todo = db.prepare('SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND excluded_by IS NULL').pluck().all(json) as number[];
          for (const id of todo) createExclusionInTx(this.ctx, u, 'image', String(id));
          return { message: `已排除 ${n} 张图` };
        });
      case 'restore':
        return this.ctx.mutate((u) => {
          restoreImagesInTx(this.ctx, u, ids);
          return { message: `已恢复 ${n} 张图` };
        });
      case 'favorite':
        return this.ctx.mutate((u) => {
          setFavorite(this.ctx, u, ids, a.value);
          return { message: a.value ? `已收藏 ${n} 张图` : `已取消收藏 ${n} 张图` };
        });
      case 'shelve':
        return this.ctx.mutate((u) => {
          setShelved(this.ctx, u, ids, a.value ? now : null);
          return { message: a.value ? `已放下 ${n} 张图，不再出现在未识别` : `已把 ${n} 张图放回未识别` };
        });
      case 'original':
        // 手动归为原创 / 移出原创都是用户的决定（D8），之后 Pixiv 的原创信号不再改它；「原创」作品只有编目的这一种建法
        return this.ctx.mutate((u) => {
          if (a.value) ensureOriginalWork(this.kindDeps.catalog(), u, now);
          setOriginal(this.ctx, u, ids, a.value ? now : null);
          return { message: a.value ? `已把 ${n} 张图归为原创，不再出现在未识别` : `已把 ${n} 张图移出原创` };
        });
      case 'rating':
        return this.ctx.mutate((u) => {
          setRating(this.ctx, u, ids, a.value);
          return { message: `已把 ${n} 张图设为「${RATING_LABEL[a.value]}」` };
        });
      case 'kind': {
        const value = a.value;
        assertKindValue(value);
        return this.ctx.mutate((u) => {
          const message = setKindInTx(this.ctx, u, ids, value);
          return { message };
        });
      }
      case 'trash':
        return this.trash(ids, now);
      case 'artist': {
        // 手动改画师：改过的图记 artist_manual，之后识别、补跑都不再动它（归类模块）
        const tags = normArtists(a.mode, a.artists);
        const names = artistNames(db, tags);
        // 去掉时同一个人的旧名、社团名等标签一起去掉（和按画师筛图的 tagsOfArtist 是同一组）
        let list = tags;
        if (a.mode === 'remove') {
          const groups = artistGroupMap(db);
          const reps = new Set(tags.map((t) => groups.get(t) ?? t));
          list = [...new Set([...tags, ...[...groups].filter(([, g]) => reps.has(g)).map(([t]) => t)])];
        }
        return this.ctx.mutate((u) => {
          setManualArtists(this.ctx, u, ids, a.mode, list, now);
          return { message: artistEditMessage(a.mode, n, names) };
        });
      }
      case 'artist-auto':
        // 改回自动：只动手动改过的图，清掉手动改的、进度置空，「识别画师」会重新认；没改过的图不动
        return this.ctx.mutate((u) => {
          const edited = resetArtists(this.ctx, u, ids);
          return { message: artistAutoMessage(n, edited.length) };
        });
    }
  }

  private async trash(ids: number[], now: string): Promise<MutationResult> {
    const rows = this.ctx.db
      .prepare(
        `SELECT i.id, i.rel_path, r.path AS root FROM images i JOIN library_roots r ON r.id = i.root_id
         WHERE i.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as { id: number; rel_path: string; root: string }[];
    // 任一文件夹没有回收站 → 400，一张都不动（点的时候就报，不等真的移文件）
    for (const root of new Set(rows.map((r) => r.root))) await this.pending.checkRoot(root);
    let batch = 0;
    const res = this.ctx.mutate((u) => {
      u.columns('images', ['trashed_at'], ids);
      this.ctx.db.prepare('UPDATE images SET trashed_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(now, JSON.stringify(ids));
      this.ctx.changed({ type: 'image.trashed', ids });
      batch = this.pending.record(u, rows.map((r) => ({ id: r.id, abs: toAbs(r.root, r.rel_path) })));
      return { message: `已把 ${ids.length} 张图移到回收站` };
    });
    return this.pending.added(batch, res);
  }
}
