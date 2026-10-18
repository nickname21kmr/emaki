/** Increment this profile when model, prompt, preprocessing or decoding changes. */
export const VLM_PROFILE = 'qwen3.5-4b-q4km-e87f176-v1';
export const VLM_KINDS = ['illustration', 'photo', 'screenshot', 'text', 'meme', 'comic', 'uncertain'] as const;
export type VlmKind = typeof VLM_KINDS[number];
export const VLM_SCHEMA = {
  type: 'object', properties: { kind: { type: 'string', enum: VLM_KINDS } },
  required: ['kind'], additionalProperties: false,
};
export interface VlmDecision {
  version: 2;
  profile: typeof VLM_PROFILE;
  sha256: string;
  kind: VlmKind;
  status: 'ok' | 'error';
  at: string;
  error?: string;
}
export function parseVlmResponse(value: unknown): VlmKind {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分类响应不是对象');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 1 || !VLM_KINDS.includes(r.kind as VlmKind)) throw new Error('分类响应不符合枚举约束');
  return r.kind as VlmKind;
}
export function readVlmDecision(raw: string | null | undefined, sha: string | undefined): VlmDecision | null {
  if (!raw || !sha) return null;
  try {
    const r = JSON.parse(raw) as VlmDecision;
    return r && r.version === 2 && r.profile === VLM_PROFILE && r.sha256 === sha &&
      VLM_KINDS.includes(r.kind) && (r.status === 'ok' || r.status === 'error') &&
      typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r : null;
  } catch { return null; }
}
export interface VlmFiles { server: string; model: string; projector: string }
export const VLM_FILE_HASHES = {
  model: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
  projector: '302b92d565080b9cc0281186979ae75a7429ec23d14f6f7607a035539b21f3a6',
};
