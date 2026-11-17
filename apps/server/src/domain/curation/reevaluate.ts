/**
 * 反应 reevaluateAuto（docs/core-architecture.md 第 4.2 节，P3b）：唯一调用 decideAuto 并写入自动决定的地方。
 *
 * 订阅：证据变化（首次识别、重新识别、Pixiv 补充、来源失效、插件来源）、最终类型变化、放下或原创变化、否决变化、
 * 合集类型或成员变化、漫画区变化、编目的合并或绑定变化，以及「按当前阈值补采纳」命令（curation.autoRequested）。
 * 首次识别、补采纳、改类型、Pixiv 补充四条路因此是同一个函数，结果天然一致（附录 #1、#3）。
 *
 * 一轮评估：读这些图的事实、全部证据、当前决定 → 每张图跑两遍 decideAuto（第一遍收集这一轮要建档的标签，
 * 第二遍让同一轮里不能建档的图复用它们，结果和图在批次里的先后无关）→ 建档、撤回、关联、原创一次写完。
 * 撤回（D2）记进 change_log（auto-retract，重启后也能撤回）；有撤销记录器（用户、助手的操作）时同时记撤销。
 * 撤销重放时不评估：撤销已经把自动决定按记录还原了，再评估一遍会把用户刚撤销的自动决定又做一遍；
 * 只声明这些图的角色、原创可能变了，让排除结果、合集这些派生数据按还原后的事实重算。
 */
import type { ContentKind, Settings } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { insertDanbooruCharacter } from '../catalog/characterCatalog.ts';
import { recordChange, type RetractPayload } from '../../datasource/sqlite/changeLog.ts';
import { DEFAULT_SETTINGS, readSettings } from '../../datasource/sqlite/settings.ts';
import { iso, NOT_IN_BOOK, UNRECOGNIZED } from '../../datasource/sqlite/sql.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { isInteractive, type Actor } from '../../propagation/actor.ts';
import type { ChangeSet, ChangeType } from '../../propagation/changes.ts';
import type { Reaction } from '../../propagation/registry.ts';
import { CharacterCatalog } from '../catalog/characterCatalog.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { ensureOriginalWork } from '../catalog/original.ts';
import { imagesWithCandidates, loadEvidence, type CharacterEvidenceProvider } from '../evidence/store.ts';
import { stmt, type DomainTx } from '../tx.ts';
import { decideAuto, type AutoDecision, type AutoSettings, type CurrentLink, type Evidence, type ImageFacts } from './auto.ts';
import { linkEach, rebaseLinks, unlinkEach, type LinkItem } from './links.ts';
import { clearAutoOriginal, setAutoOriginal, type OriginalRow } from './marks.ts';
import { auto, RULES, type LinkRow } from './provenance.ts';

export interface AutoDeps {
  /** 角色目录（标签 → 角色、建档）；每次评估新建一个，缓存只在这一轮里有效 */
  catalog(): CharacterCatalog;
}

/** 来源的自动阈值：设置里按来源配的（tagger.autoAcceptBySource），没有就用 autoAcceptThreshold（Pixiv 不再写死 0.8，附录 #2） */
export function autoSettings(tagger: Pick<Settings['tagger'], 'autoAcceptThreshold' | 'autoAcceptBySource'>): AutoSettings {
  return { threshold: (provider) => tagger.autoAcceptBySource?.[provider] ?? tagger.autoAcceptThreshold };
}

/** 设置里的自动阈值（只读 tagger 这一节，每批识别都要读一次） */
function taggerThresholds(db: Db): Pick<Settings['tagger'], 'autoAcceptThreshold' | 'autoAcceptBySource'> {
  const raw = stmt(db, "SELECT value FROM settings WHERE key = 'tagger'").pluck().get() as string | undefined;
  let t: Partial<Settings['tagger']> = {};
  try {
    t = raw ? (JSON.parse(raw) as Partial<Settings['tagger']>) : {};
  } catch {
    /* 坏了按默认 */
  }
  return {
    autoAcceptThreshold: typeof t.autoAcceptThreshold === 'number' ? t.autoAcceptThreshold : DEFAULT_SETTINGS.tagger.autoAcceptThreshold,
    autoAcceptBySource: t.autoAcceptBySource ?? {},
  };
}

/** 一轮评估的结果（还没写） */
export interface AutoPlan {
  decisions: Map<number, AutoDecision>;
  /** 这一轮要建档的标签 */
  seeds: string[];
}

interface FactRow {
  id: number;
  kind: ContentKind;
  shelved: number;
  marked: number;
  original_decision: 'manual' | 'auto' | null;
  original_rule: string | null;
  original_evidence_provider: string | null;
  in_book: number;
  in_comic: number;
  excluded: number;
}

const FACTS = `SELECT i.id, i.content_kind AS kind, i.shelved_at IS NOT NULL AS shelved, i.original_at IS NOT NULL AS marked,
    i.original_decision, i.original_rule, i.original_evidence_provider,
    (NOT ${NOT_IN_BOOK}) AS in_book, ${IN_COMIC('i')} AS in_comic,
    (i.excluded_by IS NOT NULL OR i.trashed_at IS NOT NULL OR i.missing = 1
      OR i.root_id NOT IN (SELECT id FROM library_roots WHERE enabled = 1 AND removed_at IS NULL)) AS excluded
  FROM images i WHERE i.id IN (SELECT value FROM json_each(?))`;

/**
 * 评估这些图的自动决定（只读）。fresh：这一轮里证据刚换过（或刚被去掉）的来源，按图
 */
export function evaluateAuto(db: Db, ids: number[], fresh: ReadonlyMap<number, ReadonlySet<string>>, catalog: CharacterCatalog): AutoPlan {
  const plan: AutoPlan = { decisions: new Map(), seeds: [] };
  if (!ids.length) return plan;
  const json = JSON.stringify(ids);
  const facts = stmt(db, FACTS).all(json) as FactRow[];
  if (!facts.length) return plan;
  const evidence = loadEvidence(db, ids);
  const links = new Map<number, CurrentLink[]>();
  for (const r of stmt(
    db,
    `SELECT image_id, character_id, decision, rule, evidence_provider, evidence_tag, evidence_score FROM image_characters
     WHERE image_id IN (SELECT value FROM json_each(?)) ORDER BY image_id, added_at, character_id`,
  ).all(json) as { image_id: number; character_id: number; decision: 'manual' | 'auto'; rule: string | null; evidence_provider: string | null; evidence_tag: string | null; evidence_score: number | null }[]) {
    const list = links.get(r.image_id) ?? [];
    list.push({ characterId: r.character_id, decision: r.decision, rule: r.rule, provider: r.evidence_provider, tag: r.evidence_tag, score: r.evidence_score });
    links.set(r.image_id, list);
  }
  const vetoes = new Map<number, Set<number>>();
  for (const [img, ch] of stmt(db, 'SELECT image_id, character_id FROM character_vetoes WHERE image_id IN (SELECT value FROM json_each(?))').raw().all(json) as [number, number][]) {
    const set = vetoes.get(img) ?? new Set<number>();
    set.add(ch);
    vetoes.set(img, set);
  }
  const settings = autoSettings(taggerThresholds(db));
  // 自建角色的候选按 character_id 认（编号还在才算）；其余按标签找角色（规范化、合并重定向、核验过的变体）
  const customIds = new Set<number>();
  for (const list of evidence.values()) for (const e of list) for (const c of e.candidates) if (c.characterId !== null) customIds.add(c.characterId);
  const alive = new Set(
    customIds.size
      ? (stmt(db, 'SELECT id FROM characters WHERE id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify([...customIds])) as number[])
      : [],
  );
  // 证据里的标签已经规范化过：先一条语句按标签找角色（角色自己的标签、合并重定向），找不到的再交给角色目录（规范化、核验过的变体）。
  // 识别任务每批都要评估一次，逐个走角色目录的规范化要慢上一截
  const resolved = new Map<string, number | null>();
  const tags = new Set<string>();
  for (const list of evidence.values()) for (const e of list) for (const c of e.candidates) if (c.characterId === null) tags.add(c.tag);
  if (tags.size) {
    for (const [tag, id] of stmt(
      db,
      `SELECT j.value, COALESCE((SELECT c.id FROM characters c WHERE c.danbooru_tag = j.value),
         (SELECT r.character_id FROM danbooru_tag_redirects r WHERE r.tag = j.value)) FROM json_each(?) j`,
    )
      .raw()
      .all(JSON.stringify([...tags])) as [string, number | null][]) {
      if (id !== null) resolved.set(tag, id);
    }
  }
  const resolve = (c: { tag: string; characterId: number | null }) => {
    if (c.characterId !== null) return alive.has(c.characterId) ? c.characterId : null;
    if (!resolved.has(c.tag)) resolved.set(c.tag, catalog.resolveCharacterId(c.tag));
    return resolved.get(c.tag)!;
  };
  const inputs = facts.map((f) => {
    const image: ImageFacts = {
      id: f.id,
      kind: f.kind,
      shelved: !!f.shelved,
      original: { marked: !!f.marked, decision: f.original_decision, rule: f.original_rule, provider: f.original_evidence_provider },
      inBook: !!f.in_book,
      inComicArea: !!f.in_comic,
      excluded: !!f.excluded,
    };
    const stale = fresh.get(f.id) ?? new Set<string>();
    const ev: Evidence[] = (evidence.get(f.id) ?? []).map((e) => ({ provider: e.provider, fresh: stale.has(e.provider), original: e.original, candidates: e.candidates }));
    // 证据刚被整份去掉的来源（来源失效）：当作一份空的新证据
    for (const p of stale) if (!ev.some((e) => e.provider === p)) ev.push({ provider: p as CharacterEvidenceProvider, fresh: true, original: false, candidates: [] });
    return { image, ev, current: { links: links.get(f.id) ?? [], vetoed: vetoes.get(f.id) ?? new Set<number>() } };
  });
  const view = (creating: ReadonlySet<string>) => ({ resolve, canCreate: (tag: string) => !CharacterCatalog.isCustomTag(tag), creating: (tag: string) => creating.has(tag) });
  // 第一遍：这一轮要建档的标签
  const seeds = new Set<string>();
  for (const x of inputs) for (const s of decideAuto(x.image, x.ev, x.current, settings, view(new Set())).createCharacters) seeds.add(s.tag);
  // 第二遍：同一轮建的角色大家都能用
  for (const x of inputs) plan.decisions.set(x.image.id, decideAuto(x.image, x.ev, x.current, settings, view(seeds)));
  plan.seeds = [...seeds].sort();
  return plan;
}

/** 写入的结果 */
export interface AutoApplied {
  linked: LinkItem[];
  /** 撤回的自动关联（撤回之前的样子） */
  retracted: LinkRow[];
  /** 自动标了原创的图 */
  originals: number[];
  /** 撤回的自动原创（撤回之前的样子） */
  clearedOriginals: OriginalRow[];
}

/** 把一轮评估写进库：建档 → 撤回 → 改来历 → 关联 → 原创。u 不为空时记撤销 */
export function applyAutoPlan(tx: DomainTx, u: UndoRecorder | null, plan: AutoPlan, catalog: CharacterCatalog, now: string): AutoApplied {
  const out: AutoApplied = { linked: [], retracted: [], originals: [], clearedOriginals: [] };
  const used = new Set<string>();
  for (const d of plan.decisions.values()) for (const l of d.link) if (l.characterId === null && l.tag) used.add(l.tag);
  const created = new Map<string, number>();
  for (const tag of plan.seeds) {
    if (!used.has(tag)) continue;
    created.set(tag, u ? insertDanbooruCharacter(u, catalog, tag, { now }).id : catalog.ensureCharacter(tag, now).id);
  }
  const unlinkPairs: { imageId: number; characterId: number }[] = [];
  const unlinkProvider = new Map<string, string>();
  const rebase: LinkItem[] = [];
  const items: LinkItem[] = [];
  for (const [imageId, d] of plan.decisions) {
    const dropped = new Set(d.unlink.map((x) => x.characterId!));
    for (const x of d.unlink) {
      // 同一个决定里撤回又加回（别的来源仍然支持）：只改来历
      if (d.link.some((l) => l.characterId === x.characterId)) continue;
      unlinkPairs.push({ imageId, characterId: x.characterId! });
      unlinkProvider.set(`${imageId}:${x.characterId}`, x.provider);
    }
    for (const l of d.link) {
      const characterId = l.characterId ?? created.get(l.tag!);
      if (characterId === undefined) continue;
      const item = { imageId, characterId, provenance: auto(RULES.auto, now, { provider: l.provider, tag: l.tag, score: l.score }) };
      (dropped.has(characterId) ? rebase : items).push(item);
    }
  }
  if (unlinkPairs.length) {
    // 规则去掉的不记否决：证据回来了还可以再加
    out.retracted = unlinkEach(tx, u, unlinkPairs, {
      veto: false,
      only: (row) => row.decision === 'auto' && row.evidence_provider === unlinkProvider.get(`${row.image_id}:${row.character_id}`),
    });
  }
  if (rebase.length) rebaseLinks(tx, u, rebase);
  if (items.length) out.linked = linkEach(tx, u, items).linked;
  const mark: { imageId: number; provider: string; rule: string }[] = [];
  const clear: number[] = [];
  for (const [imageId, d] of plan.decisions) {
    if (d.original?.value === true) mark.push({ imageId, provider: d.original.provider, rule: d.original.rule });
    else if (d.original?.value === false) clear.push(imageId);
  }
  if (mark.length) {
    // 图算不算「原创」作品由 original_at 派生，作品本身要先有
    ensureOriginalWork(catalog, u, now);
    out.originals = setAutoOriginal(tx, u, mark, now);
  }
  if (clear.length) out.clearedOriginals = clearAutoOriginal(tx, u, clear);
  return out;
}

/** reevaluateAuto 订阅的变化 */
const ON: ChangeType[] = [
  'evidence.changed',
  'image.kindChanged',
  'curation.shelvedChanged',
  'curation.originalChanged',
  'curation.vetoesChanged',
  'curation.autoRequested',
  'collections.changed',
  'root.modeChanged',
  'catalog.merged',
  'catalog.bindingChanged',
];

/** 这次要重新评估的图 */
function scope(db: Db, changes: ChangeSet): number[] {
  const ids = new Set(changes.ids(...ON.filter((t) => !t.startsWith('catalog.') && t !== 'collections.changed')));
  for (const c of changes.of('collections.changed')) {
    for (const id of c.ids) ids.add(id);
    if (c.collectionIds.length) {
      for (const id of stmt(db, 'SELECT id FROM images WHERE collection_id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(c.collectionIds)) as number[]) ids.add(id);
    }
  }
  // 编目变了：证据里提到这些角色（现在的标签、指向它们的重定向、自建角色）的图
  const characterIds = [...new Set([...changes.of('catalog.merged'), ...changes.of('catalog.bindingChanged')].flatMap((c) => c.characterIds))];
  if (characterIds.length) {
    const cj = JSON.stringify(characterIds);
    const tags = stmt(
      db,
      `SELECT danbooru_tag FROM characters WHERE id IN (SELECT value FROM json_each(?)) AND danbooru_tag IS NOT NULL
       UNION SELECT tag FROM danbooru_tag_redirects WHERE character_id IN (SELECT value FROM json_each(?))`,
    )
      .pluck()
      .all(cj, cj) as string[];
    for (const id of imagesWithCandidates(db, tags, characterIds)) ids.add(id);
  }
  return [...ids];
}

/**
 * 只有这些图的自动决定可能变：证据刚换过的（可能要撤回），或者有达到最低自动阈值、还没关联也没被否决的候选（可能要加），
 * 或者证据里有原创信号（可能要标原创）。别的图评估了也是什么都不做——批量改类型、批量移出角色这类一千张的操作不用逐张评估
 */
function worthEvaluating(db: Db, ids: number[], fresh: ReadonlyMap<number, ReadonlySet<string>>): number[] {
  const rest = ids.filter((id) => !fresh.has(id));
  if (!rest.length) return ids;
  const t = taggerThresholds(db);
  const min = Math.min(t.autoAcceptThreshold, ...Object.values(t.autoAcceptBySource ?? {}).filter((x): x is number => typeof x === 'number'));
  const keep = new Set(
    stmt(
      db,
      `SELECT j.value FROM json_each(@ids) j
       WHERE EXISTS (SELECT 1 FROM v_character_suggestions s WHERE s.image_id = j.value AND s.score >= @min)
          OR EXISTS (SELECT 1 FROM image_evidence e WHERE e.image_id = j.value AND e.original = 1)`,
    )
      .pluck()
      .all({ ids: JSON.stringify(rest), min }) as number[],
  );
  return ids.filter((id) => fresh.has(id) || keep.has(id));
}

/** 证据刚换过的来源（按图）；画师的证据不是角色证据 */
function freshProviders(changes: ChangeSet): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const c of changes.of('evidence.changed')) {
    if (c.provider === 'artists') continue;
    for (const id of c.ids) {
      const set = out.get(id) ?? new Set<string>();
      set.add(c.provider);
      out.set(id, set);
    }
  }
  return out;
}

export function reevaluateAutoReaction(deps: AutoDeps): Reaction {
  return {
    name: 'reevaluateAuto',
    on: ON,
    phase: 'tx',
    emits: ['curation.charactersChanged', 'curation.autoOriginalChanged'],
    run({ ctx, changes, emit, undo, replay, actor }) {
      const fresh = freshProviders(changes);
      const ids = worthEvaluating(ctx.db, scope(ctx.db, changes), fresh);
      if (!ids.length) return;
      // 撤销重放：决定已经按撤销记录还原了，不再评估（否则会把刚撤销的自动决定又做一遍）；
      // 只把这些图「角色、原创可能变了」交给后面的反应，按还原后的事实重算排除结果、合集等
      if (replay) {
        emit({ type: 'curation.charactersChanged', ids });
        emit({ type: 'curation.autoOriginalChanged', ids });
        return;
      }
      const catalog = deps.catalog();
      const plan = evaluateAuto(ctx.db, ids, fresh, catalog);
      const now = iso(ctx.clock());
      const res = applyAutoPlan({ db: ctx.db, changed: emit }, undo, plan, catalog, now);
      if (res.retracted.length || res.clearedOriginals.length) recordRetraction(ctx, undo, res, actor);
    },
  };
}

/** 证据不再支持而撤回的自动决定记一条 auto-retract（D2）：重启后也能在「最近的自动改动」里撤回 */
function recordRetraction(ctx: SqliteContext, u: UndoRecorder | null, res: AutoApplied, actor: Actor): void {
  const images = new Set([...res.retracted.map((r) => r.image_id), ...res.clearedOriginals.map((r) => r.id)]).size;
  const chars = [...new Set(res.retracted.map((r) => r.character_id))];
  const names = ctx.db
    .prepare('SELECT name FROM characters WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name LIMIT 3')
    .pluck()
    .all(JSON.stringify(chars)) as string[];
  const parts = [
    res.retracted.length && `去掉了 ${res.retracted.length} 个自动关联（${names.join('、')}${chars.length > 3 ? ` 等 ${chars.length} 个角色` : ''}）`,
    res.clearedOriginals.length && `${res.clearedOriginals.length} 张不再自动标原创`,
  ].filter(Boolean);
  const payload: RetractPayload = { links: res.retracted, originals: res.clearedOriginals };
  recordChange(
    ctx,
    'auto-retract',
    `证据不再支持：${parts.join('，')}`,
    payload,
    isInteractive(actor) ? undefined : { count: images, hint: `把这些关联和原创标记加回来（${images} 张图，加回来的记成手动）。` },
    u,
  );
}

/**
 * 「按当前阈值补采纳」的范围：有建议达到最低的自动阈值、能自动关联的图（可见、没排除、没放下、没归原创、不在漫画区）；
 * 给了类型时只看未识别里这一类的图
 */
export function promotionScope(db: Db, kind?: ContentKind): number[] {
  const t = readSettings(db).tagger;
  const min = Math.min(t.autoAcceptThreshold, ...Object.values(t.autoAcceptBySource ?? {}).filter((x): x is number => typeof x === 'number'));
  return stmt(
    db,
    `SELECT DISTINCT s.image_id FROM v_character_suggestions s JOIN v_counted_images i ON i.id = s.image_id
     WHERE s.score >= @min AND i.shelved_at IS NULL AND i.original_at IS NULL AND NOT ${IN_COMIC('i')}
       AND (@kind IS NULL OR (i.content_kind = @kind AND ${UNRECOGNIZED}))
     ORDER BY s.image_id`,
  )
    .pluck()
    .all({ min, kind: kind ?? null }) as number[];
}

/** 一轮评估会新加多少：有新关联的图、新关联的条数（补采纳的预览和提示） */
export function countLinks(plan: AutoPlan): { images: number; suggestions: number } {
  let images = 0;
  let suggestions = 0;
  for (const d of plan.decisions.values()) {
    const n = d.link.filter((l) => !d.unlink.some((x) => x.characterId === l.characterId)).length;
    if (n) images++;
    suggestions += n;
  }
  return { images, suggestions };
}
