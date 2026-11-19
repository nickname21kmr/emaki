/**
 * 唯一的自动决定规则 decideAuto（docs/core-architecture.md 第 4.2 节，P3b；附录 #1、#2、#3，D2、D8）。
 *
 * 纯函数：同样的输入一定得到同样的输出，不读库、不看时间。只有反应 reevaluateAuto（reevaluate.ts）调用它并写入结果；
 * 首次识别、重新识别、补采纳、改类型、Pixiv 补充都经过同一个反应，结果天然一致。
 *
 * 规则：
 * 1. 加关联：图片没放下、没归原创、不在漫画区、没被排除（且可见）时，证据里分数达到这个来源自动阈值的候选
 *    （阈值按来源取自设置，见 reevaluate.ts 的 autoSettings）都关联上；用户否决过的不加；
 *    候选还没有角色时，插画、漫画上可以建档（动的也一样，D5），别的类型只在同一轮里别的图会建这个角色时复用（和先后无关，附录 #1）。
 * 2. 撤回（D2）：只在某个来源的证据刚换过时（fresh：首次识别、重新识别、Pixiv 补充、来源失效）；
 *    自动的、依据的就是这个来源的关联，新证据里没有这个候选或分数低于这个来源的自动阈值，就撤回。
 *    手动的、来历不明的（rule 是 legacy）永远不动。阈值调高不会撤回（没有新证据），补采纳只会新增。
 *    别的来源的证据仍然支持这个角色时不真撤回：同一个决定里撤回再加回，写入时只改来历。
 * 3. 原创（D8）：证据里有原创信号（Pixiv 投稿标了原创）、图片还没有原创的决定、也还没有角色时，自动标原创（auto / 信号的来源）；
 *    自动标的原创在依据的来源证据刚换过、信号不在了时撤回。手动标原创、手动取消原创都是决定，自动永远不改。
 * 4. 所在合集是否整本处理（inBook）现在不影响决定：本子的页照样按证据关联角色（角色在本子里出现的页数按页上的关联算），
 *    它只影响要不要去查 Pixiv（证据的获取，services/pixiv/sync.ts）。合集类型变了照样重新评估，规则以后要区分时不用再接线。
 * 5. 过期的证据（D1：文件内容变了、这份文件版本还没重新识别，stale）不拿来新加关联，也不算「别的来源仍然支持」；
 *    依据它的自动关联先留着，新证据到了按第 2 条处理。
 */
import type { ContentKind } from '@emaki/shared';
import type { CharacterEvidenceProvider } from '../evidence/store.ts';
import { LEGACY_RULE_PREFIX, RULES, type Decision } from './provenance.ts';

/**
 * 能自动建档的类型：插画、漫画（截图、文字、照片、表情上认出的新角色只进建议，BI-15）。
 * 是否动图不影响（D5）：动的插画和静态插画一样建档；以前类型 animated 也能建档，那些图现在按其余规则判成插画、漫画或别的类型
 */
export const AUTO_CREATE_KINDS: ReadonlySet<ContentKind> = new Set<ContentKind>(['illustration', 'comic']);

/** 图片上已有的原创决定 */
export interface OriginalFacts {
  /** 现在标着原创（original_at 有值） */
  marked: boolean;
  /** manual：用户标的或用户取消过的；auto：自动规则标的；null：还没有决定 */
  decision: Decision | null;
  rule: string | null;
  /** 自动标原创依据的证据来源 */
  provider: string | null;
}

/** 图片事实 */
export interface ImageFacts {
  id: number;
  /** 最终类型 */
  kind: ContentKind;
  shelved: boolean;
  original: OriginalFacts;
  /** 所在合集整本处理（本子、画集） */
  inBook: boolean;
  /** 在按漫画导入的范围里 */
  inComicArea: boolean;
  /** 被排除，或者不可见（文件夹停用、进了回收站、文件不在） */
  excluded: boolean;
}

/** 一个来源对这张图的证据 */
export interface Evidence {
  provider: CharacterEvidenceProvider;
  /** 这个来源的证据刚换过（或刚被去掉）：只有这时才撤回依据它的自动决定（D2） */
  fresh: boolean;
  /** 证据过期了（D1：文件内容变了，还没按新文件重新识别）：不拿来新加关联 */
  stale?: boolean;
  /** 原创信号 */
  original: boolean;
  candidates: readonly { tag: string; characterId: number | null; score: number }[];
}

/** 图上已有的一条关联和它的来历 */
export interface CurrentLink {
  characterId: number;
  decision: Decision;
  rule: string | null;
  /** 依据的证据来源；手动的、来历不明的为空 */
  provider: string | null;
  tag: string | null;
  score: number | null;
}

/** 当前决定 */
export interface Decisions {
  links: readonly CurrentLink[];
  /** 用户在这张图上否决过的角色 */
  vetoed: ReadonlySet<number>;
}

/** 设置：每个来源的自动阈值 */
export interface AutoSettings {
  threshold(provider: CharacterEvidenceProvider): number;
}

/** 编目解析 */
export interface CatalogView {
  /** 候选对应的已有角色；没有（或自建角色已经不在了）是 null */
  resolve(candidate: { tag: string; characterId: number | null }): number | null;
  /** 这个标签能建档（Danbooru 标签；自建角色的占位标签不能） */
  canCreate(tag: string): boolean;
  /** 同一轮里别的图会给这个标签建档 */
  creating(tag: string): boolean;
}

/** 一条自动关联：characterId 为空表示要先给 tag 建档 */
export interface AutoLink {
  characterId: number | null;
  tag: string | null;
  provider: CharacterEvidenceProvider;
  score: number | null;
}

export interface CharacterSeed {
  tag: string;
}

/** 原创的自动决定：标上（依据哪个来源、哪条规则）或撤回自动标的 */
export type AutoOriginal = { value: true; provider: CharacterEvidenceProvider; rule: string } | { value: false };

export interface AutoDecision {
  link: AutoLink[];
  unlink: AutoLink[];
  createCharacters: CharacterSeed[];
  original?: AutoOriginal;
}

interface Candidate {
  tag: string;
  characterId: number | null;
  provider: CharacterEvidenceProvider;
  score: number;
  accepted: boolean;
}

const byScore = (a: Candidate, b: Candidate) =>
  b.score - a.score || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);

export function decideAuto(image: ImageFacts, evidence: readonly Evidence[], current: Decisions, settings: AutoSettings, catalog: CatalogView): AutoDecision {
  const out: AutoDecision = { link: [], unlink: [], createCharacters: [] };
  const cands: Candidate[] = [];
  for (const e of evidence) {
    const threshold = settings.threshold(e.provider);
    for (const c of e.candidates) {
      const characterId = catalog.resolve(c);
      // 自建角色已经不在了（合并、删除）：这个候选作废
      if (characterId === null && c.characterId !== null) continue;
      cands.push({ tag: c.tag, characterId, provider: e.provider, score: c.score, accepted: !e.stale && c.score >= threshold });
    }
  }
  cands.sort(byScore);
  const supports = (characterId: number, provider?: string) =>
    cands.find((c) => c.accepted && c.characterId === characterId && (provider === undefined || c.provider === provider));

  // 1. 撤回（D2）
  for (const l of current.links) {
    if (l.decision !== 'auto' || l.rule === LEGACY_RULE_PREFIX || !l.provider) continue;
    if (!evidence.some((e) => e.provider === l.provider && e.fresh)) continue;
    if (supports(l.characterId, l.provider)) continue;
    out.unlink.push({ characterId: l.characterId, tag: l.tag, provider: l.provider as CharacterEvidenceProvider, score: l.score });
    const other = supports(l.characterId);
    if (other) out.link.push({ characterId: l.characterId, tag: other.tag, provider: other.provider, score: other.score });
  }

  // 2. 加关联
  const linked = new Set(current.links.map((l) => l.characterId));
  const eligible = !image.shelved && !image.original.marked && !image.inComicArea && !image.excluded;
  if (eligible) {
    const seen = new Set<string>();
    const createHere = AUTO_CREATE_KINDS.has(image.kind);
    for (const c of cands) {
      if (!c.accepted) continue;
      const key = c.characterId !== null ? `#${c.characterId}` : c.tag;
      if (seen.has(key)) continue;
      seen.add(key);
      const link = { characterId: c.characterId, tag: c.tag, provider: c.provider, score: c.score };
      if (c.characterId !== null) {
        if (!linked.has(c.characterId) && !current.vetoed.has(c.characterId)) out.link.push(link);
      } else if (catalog.canCreate(c.tag)) {
        if (createHere) {
          out.createCharacters.push({ tag: c.tag });
          out.link.push(link);
        } else if (catalog.creating(c.tag)) out.link.push(link);
      }
    }
  }

  // 3. 原创（D8）
  const o = image.original;
  if (o.decision !== 'manual') {
    const signal = evidence.find((e) => e.original);
    if (!o.marked) {
      // 已经有角色的图不自动标原创（以前 Pixiv 只处理没有角色的图）；同一份证据里一起关联上的自建原创角色不算
      if (signal && !current.links.length && !image.shelved && !image.inComicArea && !image.excluded) {
        out.original = { value: true, provider: signal.provider, rule: RULES.autoOriginal };
      }
    } else if (o.decision === 'auto' && o.rule !== LEGACY_RULE_PREFIX && o.provider) {
      const e = evidence.find((x) => x.provider === o.provider && x.fresh);
      if (e && !e.original) out.original = { value: false };
    }
  }
  return out;
}
