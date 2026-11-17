/**
 * 自动关联的「判断」（P3a）：三个入口——识别写入、补采纳、Pixiv 补充——各自现有的判断原样搬到这里，作为 judgeAutoLink 一个函数供各入口调用；
 * 达标的再由各入口交给 links.ts 的 link（带 auto 来历）写入。
 *
 * 现在三个入口的判断还不一样（附录 #1：识别写入能不能建档取决于批次里的先后；补采纳按整批收集新标签；Pixiv 有自己的 automatic），
 * 这是 P3b 的事：P3b 把 judgeAutoLink 换成唯一的纯函数 decideAuto（docs/core-architecture.md 第 4.2 节），由反应 reevaluateAuto 调用，
 * 各入口只产出证据。到时只换这个文件，写入一侧（link 和来历）不用动。
 */
import type { ContentKind } from '@emaki/shared';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { insertDanbooruCharacter } from '../../datasource/sqlite/characters.ts';
import { iso, UNRECOGNIZED } from '../../datasource/sqlite/sql.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { dropSuggestions } from '../evidence/suggestions.ts';
import { linkEach, vetoChecker, type LinkItem } from './links.ts';
import { auto, RULES } from './provenance.ts';

/** 达标时可复用已有角色；插画、漫画和动图也可建立角色（以前的 services/tagger/characterAcceptance.ts） */
export function canAutoAcceptCharacter(kind: ContentKind, characterId: number | string | null): boolean {
  return characterId !== null || kind === 'illustration' || kind === 'comic' || kind === 'animated';
}

/** 一个自动关联的候选：哪个入口、哪张图、哪个角色（还没有就是 null） */
export type AutoCandidate =
  /** 识别写入：分数已经到了自动采纳阈值；allowed = 图没放下、没归原创 */
  | { entry: 'recognize'; kind: ContentKind; allowed: boolean; characterId: number | null }
  /** 补采纳：留着的建议分数到了当前阈值；batchNewTags = 这一批里能建档的新标签（同批别的图能建档，这张也复用） */
  | { entry: 'promote'; kind: ContentKind; characterId: number | null; tag: string; batchNewTags: ReadonlySet<string> }
  /** Pixiv 补充：匹配器说能自动关联（投稿标签明确对上了角色） */
  | { entry: 'pixiv'; automatic: boolean };

/**
 * 能不能自动关联（现有的三套判断，原样）。否决、已有关联由 link 处理，这里不管。
 * P3b 换成 decideAuto
 */
export function judgeAutoLink(c: AutoCandidate): boolean {
  switch (c.entry) {
    case 'recognize':
      return c.allowed && canAutoAcceptCharacter(c.kind, c.characterId);
    case 'promote':
      return canAutoAcceptCharacter(c.kind, c.characterId) || c.batchNewTags.has(c.tag);
    case 'pixiv':
      return c.automatic;
  }
}

/** 补采纳要用的：角色目录（标签 → 角色）、当前的自动采纳阈值 */
export interface PromoteDeps {
  catalog: () => CharacterCatalog;
  autoAcceptThreshold: () => number;
}

interface Candidate {
  imageId: number;
  tag: string;
  score: number;
  kind: ContentKind;
}

/** 预览和执行共用一份计划。同批能建档的角色也可以被其他图片复用。 */
function planPromotions(ctx: SqliteContext, ids: number[] | null, deps: PromoteDeps, kind?: ContentKind) {
  const rows = ctx.stmt(`SELECT cs.image_id AS imageId, cs.danbooru_tag AS tag, cs.score, i.content_kind AS kind
    FROM character_suggestions cs JOIN v_counted_images i ON i.id = cs.image_id
    WHERE cs.source = 'tagger' AND cs.score >= @threshold AND cs.danbooru_tag NOT LIKE 'emaki:%'
      AND i.shelved_at IS NULL AND i.original_at IS NULL AND NOT ${IN_COMIC('i')}
      AND (@ids IS NULL OR i.id IN (SELECT value FROM json_each(@ids)))
      AND (@kind IS NULL OR (i.content_kind = @kind AND ${UNRECOGNIZED}))
    ORDER BY cs.score DESC, cs.image_id, cs.danbooru_tag`)
    .all({ ids: ids === null ? null : JSON.stringify(ids), threshold: deps.autoAcceptThreshold(), kind: kind ?? null }) as Candidate[];
  const catalog = deps.catalog();
  const linked = ctx.stmt('SELECT 1 FROM image_characters WHERE image_id = ? AND character_id = ?');
  const vetoed = vetoChecker(ctx.db);
  const candidates = rows.map(row => ({ ...row, characterId: catalog.resolveCharacterId(row.tag), normalized: catalog.normalizeTag(row.tag) }));
  const batchNewTags = new Set(candidates.filter(row => row.characterId === null && canAutoAcceptCharacter(row.kind, null)).map(row => row.normalized));
  const additions: typeof candidates = [];
  const remove: Candidate[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    const { imageId, characterId, normalized } = row;
    if (!judgeAutoLink({ entry: 'promote', kind: row.kind, characterId, tag: normalized, batchNewTags })) continue;
    remove.push(row);
    if (characterId !== null && (linked.get(imageId, characterId) || vetoed(imageId, characterId))) continue;
    const key = JSON.stringify([imageId, characterId ?? normalized]);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(row);
  }
  return { catalog, additions, remove };
}

export function countPromotable(ctx: SqliteContext, deps: PromoteDeps, kind?: ContentKind): { images: number; suggestions: number } {
  const { additions } = planPromotions(ctx, null, deps, kind);
  return { images: new Set(additions.map(row => row.imageId)).size, suggestions: additions.length };
}

/**
 * 按当前阈值补采纳留着的模型建议（设置页的按钮；手动改类型之后也跑一遍）：复用保存过的分数，在调用方的可撤销事务里写关联，
 * 来历是 auto / promote@1，证据是那条建议。返回新关联了角色的图
 */
export function promoteSuggestions(ctx: SqliteContext, u: UndoRecorder, ids: number[] | null, deps: PromoteDeps, kind?: ContentKind): number[] {
  const { catalog, additions, remove } = planPromotions(ctx, ids, deps, kind);
  if (!remove.length) return [];
  const now = iso(ctx.clock());
  const items: LinkItem[] = additions.map((row) => ({
    imageId: row.imageId,
    characterId: row.characterId ?? insertDanbooruCharacter(u, catalog, row.normalized, { now }).id,
    provenance: auto(RULES.promote, now, { provider: 'tagger', tag: row.normalized, score: row.score }),
  }));
  const { linked } = linkEach(ctx, u, items);
  // 评估过的建议都去掉（包括已经关联、被否决的）
  dropSuggestions(ctx.db, u, remove.map((r) => ({ imageId: r.imageId, tag: r.tag })));
  return [...new Set(linked.map((x) => x.imageId))];
}
