/**
 * 来历（docs/core-architecture.md 第 2.2 节）：每条「图 ↔ 角色」的决定都记下是手动还是自动、谁做的、按哪条规则、依据什么证据、什么时候。
 * 存在 image_characters 的 decision、actor、rule、evidence_provider、evidence_tag、evidence_score、added_at（迁移 034）。
 *
 * - 手动（manual）：用户点的。单张采纳建议也是手动，只是带着那条建议的证据。
 * - 自动（auto）：规则做的，rule 写规则名和版本。自动的永远不覆盖手动的，也不越过用户的否决。
 */
import { currentActor } from '../../propagation/actor.ts';

export type Decision = 'manual' | 'auto';
/** 证据来源（模型、Pixiv；以后的插件来源也记在这里） */
export type EvidenceProvider = 'tagger' | 'pixiv';

export interface Evidence {
  provider: EvidenceProvider;
  /** 证据里的候选：规范化后的标签（Pixiv 给自建角色的是占位标签） */
  tag?: string | null;
  /** 分数；Pixiv 没有分数 */
  score?: number | null;
}

export interface Provenance {
  decision: Decision;
  /** user / assistant / job:<任务> / system:<步骤> */
  actor: string;
  /** 自动决定的规则和版本；手动为 null */
  rule: string | null;
  evidence: Evidence | null;
  /** 决定的时间（image_characters.added_at） */
  at: string;
}

/**
 * 自动决定的规则（名字@版本）。判断本身在 auto.ts；P3b 统一成 decideAuto 之后这里换成它的版本号。
 * 迁移 034 转过来的旧关联是 legacy:*（见迁移文件的说明）。
 */
export const RULES = {
  /** 识别写入：分数到了自动采纳阈值 */
  autoAccept: 'auto-accept@1',
  /** 按当前阈值补采纳留着的建议（设置页的按钮；手动改类型之后也会跑一遍） */
  promote: 'promote@1',
  /** Pixiv 补充：投稿标签明确对上了角色 */
  pixiv: 'pixiv@1',
  /** 查重合并：副本上的自动关联搬到保留的图上（证据照搬副本的） */
  dedupeMerge: 'dedupe-merge@1',
} as const;

/** 迁移 034 转过来、来源对不上的旧自动关联 */
export const LEGACY_RULE_PREFIX = 'legacy';

export function manual(at: string, evidence: Evidence | null = null, actor: string = currentActor()): Provenance {
  return { decision: 'manual', actor, rule: null, evidence, at };
}

export function auto(rule: string, at: string, evidence: Evidence | null, actor: string = currentActor()): Provenance {
  return { decision: 'auto', actor, rule, evidence, at };
}

/** image_characters 的一行（SELECT * 的形状） */
export interface LinkRow {
  image_id: number;
  character_id: number;
  decision: Decision;
  actor: string;
  rule: string | null;
  evidence_provider: EvidenceProvider | null;
  evidence_tag: string | null;
  evidence_score: number | null;
  added_at: string;
}

/** 行 → 来历 */
export function fromRow(r: Pick<LinkRow, 'decision' | 'actor' | 'rule' | 'evidence_provider' | 'evidence_tag' | 'evidence_score' | 'added_at'>): Provenance {
  return {
    decision: r.decision,
    actor: r.actor,
    rule: r.rule,
    evidence: r.evidence_provider ? { provider: r.evidence_provider, tag: r.evidence_tag, score: r.evidence_score } : null,
    at: r.added_at,
  };
}

const missingRule = (): never => {
  throw new Error('自动关联必须写明规则（rule）');
};

/** 来历 → 写进 image_characters 的列（命名参数） */
export function toColumns(p: Provenance) {
  return {
    decision: p.decision,
    actor: p.actor,
    rule: p.decision === 'manual' ? null : (p.rule ?? missingRule()),
    evidence_provider: p.evidence?.provider ?? null,
    evidence_tag: p.evidence?.tag ?? null,
    evidence_score: p.evidence?.score ?? null,
    added_at: p.at,
  };
}

/**
 * 迁移 034 之前记下的关联快照（change_log 里「移动」的 charSnap：origin / score / added_at）→ 来历。
 * 和迁移的规则一致：manual 还是手动；tagger 是自动，有分数的是模型的，没有分数的来源不明
 */
export function fromLegacySnapshot(r: { origin?: string; score?: number | null; added_at: string }): Provenance {
  if (r.origin === 'manual') return manual(r.added_at, r.score != null ? { provider: r.score === 0 ? 'pixiv' : 'tagger', score: r.score } : null, 'user');
  return r.score != null
    ? auto(`${LEGACY_RULE_PREFIX}:tagger`, r.added_at, { provider: 'tagger', score: r.score }, 'system:migration')
    : auto(LEGACY_RULE_PREFIX, r.added_at, null, 'system:migration');
}
