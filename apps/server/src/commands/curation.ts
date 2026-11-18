/**
 * 归类的命令（docs/core-architecture.md 第 2.4、4.1 节，附录 #33）：一件事一个命令。
 *
 * - 图 ↔ 角色只有 curation.link / curation.unlink / curation.replace。以前的几条路——PATCH 整组替换、批量 assign / unassign / assignTag、
 *   采纳建议——都只是把参数转成这三个命令的 HTTP 地址（http/compat.ts）。
 * - 收藏、分级、类型、放下、原创、画师单张和批量是同一个命令（ids 只有一张就是单张）；排除 / 恢复单张图同理。
 * 写入都经归类模块（domain/curation/）；命令层开事务、记撤销（tx）。
 */
import { KIND_LABEL, RATING_LABEL, type ID } from '@emaki/shared';
import {
  ImageIds,
  ImagesInput,
  LinkInput,
  PromoteInput,
  ReplaceCharactersInput,
  SetArtistsInput,
  SetFavoriteInput,
  SetKindInput,
  SetOriginalInput,
  SetRatingInput,
  SetShelvedInput,
  SetSourceInput,
} from '@emaki/shared/schemas';
import { z } from 'zod';
import { setManualSource } from '../domain/curation/source.ts';
import { insertDanbooruCharacter, CharacterCatalog } from '../domain/catalog/characterCatalog.ts';
import { ensureOriginalWork } from '../domain/catalog/original.ts';
import { resetArtists, setManualArtists } from '../domain/curation/artists.ts';
import { link, linkEach, replaceCharacters, unlinkByUser, type LinkItem } from '../domain/curation/links.ts';
import { setFavorite, setOriginal, setRating, setShelved } from '../domain/curation/marks.ts';
import { manual } from '../domain/curation/provenance.ts';
import { countLinks, evaluateAuto, promotionScope } from '../domain/curation/reevaluate.ts';
import { createExclusionInTx, restoreImagesInTx } from '../domain/visibility/exclusions.ts';
import { acceptMessage } from '../datasource/acceptMessage.ts';
import { artistAutoMessage, artistEditMessage, normArtists } from '../datasource/artistEdits.ts';
import { artistGroupMap, artistNames } from '../datasource/sqlite/artists.ts';
import { setKindInTx } from '../datasource/sqlite/kinds.ts';
import { iso, parseId } from '../datasource/sqlite/sql.ts';
import { resolveSuggestedCharacter } from '../datasource/sqlite/suggestions.ts';
import type { UndoRecorder } from '../datasource/sqlite/undo.ts';
import { ConflictError, NotFoundError } from '../http/errors.ts';
import { editedSource } from '../services/source/editSource.ts';
import { readSettings } from '../datasource/sqlite/settings.ts';
import { byId, byIds, defineCommand, type Engine } from './registry.ts';

const unique = (ids: readonly ID[]) => [...new Set(ids)];
const now = (e: Engine) => iso(e.ctx.clock());

function characterName(e: Engine, idStr: string): { id: number; name: string } {
  const id = parseId(idStr);
  const row = id === null ? undefined : e.ctx.stmt('SELECT id, name FROM characters WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('角色');
  return row as { id: number; name: string };
}

/** 采纳这张图的建议：按这张图的证据记来历（手动，带证据，附录 #5）；还没有角色的按标签建档，撤销时一并删除 */
function acceptSuggestions(e: Engine, u: UndoRecorder, imageId: number, rawTags: string[], at: string): { message: string } {
  const tags = [...new Set(rawTags.map((t) => t.trim()))];
  const rows = tags.map((tag) => {
    const row = e.ctx
      .stmt('SELECT score, character_id, provider AS source FROM character_evidence WHERE image_id = ? AND tag = ? ORDER BY score DESC LIMIT 1')
      .get(imageId, tag) as { score: number; character_id: number | null; source: 'tagger' | 'pixiv' } | undefined;
    // 自建角色的建议只认 character_id：角色合并 / 删除后这行已级联删掉，不能按编号再找（编号可能给了别的角色）
    if (CharacterCatalog.isCustomTag(tag) && row?.character_id == null) throw new ConflictError('这条建议已失效，请刷新');
    return { tag, score: row?.score ?? null, characterId: row?.character_id ?? null, source: row?.source ?? ('tagger' as const) };
  });
  const catalog = e.makeCatalog().catalog;
  const names: string[] = [];
  let created = 0;
  const items: LinkItem[] = [];
  for (const r of rows) {
    let characterId = r.characterId ?? catalog.resolveCharacterId(r.tag);
    if (characterId === null) {
      // 新建角色（封面由 derived 自动选）；和自动采纳一样按作品挂好（必要时新建作品），撤销时一并删除
      const c = insertDanbooruCharacter(u, catalog, r.tag, { now: at });
      characterId = c.id;
      if (c.created) created++;
    }
    items.push({ imageId, characterId, provenance: manual(at, { provider: r.source, tag: r.tag, score: r.source === 'pixiv' ? null : r.score }) });
    names.push(e.ctx.db.prepare('SELECT name FROM characters WHERE id = ?').pluck().get(characterId) as string);
  }
  // 归类模块写关联、清掉否决、声明变化（新角色命中「角色」排除规则由反应处理）；关联上了的候选自然不再是建议
  linkEach(e.ctx, u, items);
  return { message: acceptMessage(names, created) };
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const curationCommands = [
  defineCommand({
    name: 'curation.link',
    summary: '把角色关联到这些图（手动）：characterId 是已有角色；tags 按标签找角色、找不到时按建议建档；accept 是采纳这张图的建议（按证据记来历）',
    input: LinkInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      const at = now(e);
      if (input.accept) return acceptSuggestions(e, u, ids[0]!, input.tags!, at);
      const chars =
        input.characterId !== undefined
          ? [characterName(e, input.characterId)]
          : input.tags!.map((tag) => characterName(e, String(resolveSuggestedCharacter(e.ctx, u, e.catalogNow(), tag, at))));
      // 用户手动归的：已有的关联保持原来的来历；去掉过的清掉否决（D3）。新关联的图由反应套排除规则（附录 #14）
      link(e.ctx, u, ids, [...new Set(chars.map((c) => c.id))], manual(at));
      return { message: `已将 ${ids.length} 张图归到${[...new Set(chars.map((c) => c.name))].map((n) => `「${n}」`).join('')}` };
    },
  }),
  defineCommand({
    name: 'curation.unlink',
    summary: '从这些图上去掉一个角色（记否决：重新识别、Pixiv 补充都不再加回来）',
    input: z.object({ ids: ImageIds, characterId: z.string() }),
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      const ch = characterName(e, input.characterId);
      unlinkByUser(e.ctx, u, ids, [ch.id], now(e));
      return { message: `已从「${ch.name}」移除 ${ids.length} 张图` };
    },
  }),
  defineCommand({
    name: 'curation.replace',
    summary: '整组替换一张图的角色：去掉的记否决，新加的是手动的，本来就有的保持原来的来历',
    input: ReplaceCharactersInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byId,
    tx(e, input, u) {
      const id = e.requireVisibleImages([input.id])[0]!;
      const chars = unique(input.characterIds).map((c) => e.requireCharacterId(c));
      // 新角色命中「角色」排除规则时由反应排除（附录 #14）
      replaceCharacters(e.ctx, u, id, chars, manual(now(e)));
      return { message: '已更新角色' };
    },
  }),
  defineCommand({
    name: 'curation.setFavorite',
    summary: '收藏 / 取消收藏',
    input: SetFavoriteInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      setFavorite(e.ctx, u, ids, input.value);
      const n = ids.length;
      return { message: input.value ? count(n, '已收藏', `已收藏 ${n} 张图`) : count(n, '已取消收藏', `已取消收藏 ${n} 张图`) };
    },
  }),
  defineCommand({
    name: 'curation.setRating',
    summary: '手动改分级（之后重新识别不覆盖）',
    input: SetRatingInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      setRating(e.ctx, u, ids, input.value);
      return { message: count(ids.length, '已修改分级', `已把 ${ids.length} 张图设为「${RATING_LABEL[input.value]}」`) };
    },
  }),
  defineCommand({
    name: 'curation.setKind',
    summary: '手动改内容类型；auto 清掉手动设置、按规则重判。是否动图不是类型，不能改',
    input: SetKindInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      const message = setKindInTx(e.ctx, u, ids, input.value);
      if (ids.length > 1) return { message };
      return { message: input.value === 'auto' ? '已恢复自动判断' : `已标为「${KIND_LABEL[input.value]}」` };
    },
  }),
  defineCommand({
    name: 'curation.setShelved',
    summary: '放下（不找角色了，不再出现在未识别）/ 放回',
    input: SetShelvedInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      setShelved(e.ctx, u, ids, input.value ? now(e) : null);
      const n = ids.length;
      return { message: input.value ? `已放下 ${n} 张图，不再出现在未识别` : `已把 ${n} 张图放回未识别` };
    },
  }),
  defineCommand({
    name: 'curation.setOriginal',
    summary: '归为原创 / 移出原创（手动的决定，之后 Pixiv 的原创信号不再改它）',
    input: SetOriginalInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      const at = now(e);
      // 「原创」作品只有编目的这一种建法
      if (input.value) ensureOriginalWork(e.catalogNow(), u, at);
      setOriginal(e.ctx, u, ids, input.value ? at : null);
      const n = ids.length;
      return { message: input.value ? `已把 ${n} 张图归为原创，不再出现在未识别` : `已把 ${n} 张图移出原创` };
    },
  }),
  defineCommand({
    name: 'curation.setArtists',
    summary: '手动改画师：add 加上、remove 去掉、set 换成这几位（空 = 没有画师）；改过的图之后识别不再动它',
    input: SetArtistsInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      const db = e.ctx.db;
      const tags = normArtists(input.mode, input.artists);
      const names = artistNames(db, tags);
      // 去掉时同一个人的旧名、社团名等标签一起去掉（和按画师筛图的 tagsOfArtist 是同一组）
      let list = tags;
      if (input.mode === 'remove') {
        const groups = artistGroupMap(db);
        const reps = new Set(tags.map((t) => groups.get(t) ?? t));
        list = [...new Set([...tags, ...[...groups].filter(([, g]) => reps.has(g)).map(([t]) => t)])];
      }
      setManualArtists(e.ctx, u, ids, input.mode, list, now(e));
      return { message: artistEditMessage(input.mode, ids.length, names) };
    },
  }),
  defineCommand({
    name: 'curation.resetArtists',
    summary: '画师改回自动识别：只动手动改过的图，「识别画师」会重新认',
    input: ImagesInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      // 改回自动后马上重新认这几张：由反应 queueArtists 做（撤销手动改画师时也一样）
      const edited = resetArtists(e.ctx, u, ids);
      return { message: artistAutoMessage(ids.length, edited.length) };
    },
  }),
  defineCommand({
    name: 'curation.setSource',
    summary: '确认或修改一张图的来源：{url, artist?} 人工确认（优先于扫描）；null 清除并锁定为空；auto 解除锁定、按文件名重算',
    input: SetSourceInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byId,
    tx(e, input, u) {
      const id = e.requireVisibleImages([input.id])[0]!;
      const db = e.ctx.db;
      const edit = editedSource(input.source, e.ctx.stmt('SELECT rel_path FROM images WHERE id = ?').pluck().get(id) as string, readSettings(db).tagger.pixivFilenameMode);
      // 同投稿组的成员和页码要在改来源之前记下（撤销时放回原来的组）
      const oldKey = db.prepare("SELECT source_site || ':' || source_post_id FROM images WHERE id = ?").pluck().get(id) as string | null;
      if (oldKey) u.columns('images', ['collection_id', 'page_no', 'collection_detached'], db.prepare("SELECT id FROM images WHERE source_site || ':' || source_post_id = ?").pluck().all(oldKey) as number[]);
      const before = db.prepare("SELECT COALESCE(source_site, '') || '|' || COALESCE(source_post_id, '') || '|' || COALESCE(source_artist, '') || '|' || COALESCE(source_url, '') FROM images WHERE id = ?").pluck();
      const was = before.get(id);
      // 手动确认 / 清除 / 恢复自动：归类模块记决定（source_manual），来源的值由证据模块写
      setManualSource(e.ctx, u, id, edit.source, edit.manual);
      // 刷新同投稿组、清过期的 Pixiv 建议、重新登记补充：和其他改来源的路径一样由反应做（附录 #13）
      if (before.get(id) !== was) e.ctx.changed({ type: 'image.sourceChanged', ids: [id] });
      return { message: edit.manual ? (edit.source ? '已确认来源' : '已清除来源') : '已恢复自动来源' };
    },
  }),
  defineCommand({
    name: 'visibility.excludeImages',
    summary: '排除这些图（单张的排除规则）',
    input: ImagesInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      const todo = e.ctx.db.prepare('SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND excluded_by IS NULL').pluck().all(JSON.stringify(ids)) as number[];
      for (const id of todo) createExclusionInTx(e.ctx, u, 'image', String(id));
      return { message: `已排除 ${ids.length} 张图` };
    },
  }),
  defineCommand({
    name: 'visibility.restoreImages',
    summary: '恢复被排除的这些图（记成排除例外）',
    input: ImagesInput,
    scope: 'curate',
    undoable: true,
    idempotent: true,
    images: byIds,
    tx(e, input, u) {
      const ids = e.requireVisibleImages(unique(input.ids));
      restoreImagesInTx(e.ctx, u, ids);
      return { message: `已恢复 ${ids.length} 张图` };
    },
  }),
  defineCommand({
    name: 'curation.promote',
    summary: '按当前阈值补采纳：对达标建议所在的图按自动决定规则重新评估（只新增），可撤销',
    input: PromoteInput,
    scope: 'rules',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/tagger/promote' }],
    tx(e, input) {
      // 「按当前阈值补采纳」：声明 curation.autoRequested，决定只由反应 reevaluateAuto 写，作为一次可撤销的操作。没有新证据，所以只会新增（D2）
      const db = e.ctx.db;
      const ids = promotionScope(db, input.kind);
      const { images } = countLinks(evaluateAuto(db, ids, new Map(), e.catalogNow()));
      if (images) e.ctx.changed({ type: 'curation.autoRequested', ids });
      return { message: images ? `已把 ${images} 张图按达标的建议归到角色` : '没有达标的建议了' };
    },
  }),
];
