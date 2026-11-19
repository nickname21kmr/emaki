import type { CharacterLinkProvenance, CharacterSuggestion, ID } from '@emaki/shared';
import { Plus, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Progress, Skeleton, Tooltip } from '@/components/ui';
import { CharacterAvatar, CharacterPicker } from '@/features/gallery/CharacterPicker';
import { formatConfidence, suggestionEvidence } from '@/lib/format';
import { useCharacter } from '@/lib/queries';
import { Section } from './PanelParts';
import type { ImageActions } from './useImageActions';

/**
 * 角色：已关联的 chip（可移除、点名字进详情）+「添加」弹出搜索 + tagger 建议（一键采纳）。
 * 规则自动关联的（识别模型、Pixiv）在名字后面标一个不显眼的「自动」，悬停说明依据；用户归的、采纳的不标。
 */
export function PanelCharacters({
  characterIds,
  links,
  suggestions,
  actions,
  onNavigate,
}: {
  characterIds: ID[];
  /** 已关联角色的来历（服务端的；刚加上、还没刷新的没有，按手动处理） */
  links: CharacterLinkProvenance[];
  suggestions: CharacterSuggestion[];
  actions: ImageActions;
  /** 点进角色详情前关掉看图器 */
  onNavigate: () => void;
}) {
  const pending = suggestions.filter((s) => !s.characterId || !characterIds.includes(s.characterId));
  const linkOf = new Map(links.map((l) => [l.characterId, l]));

  return (
    <Section title="角色" meta={characterIds.length ? `${characterIds.length} 位` : undefined}>
      <div className="flex flex-wrap gap-1.5">
        {characterIds.map((cid) => (
          <CharacterChip key={cid} id={cid} link={linkOf.get(cid)} onRemove={() => actions.removeCharacter(cid)} onNavigate={onNavigate} />
        ))}
        <CharacterPicker
          side="left"
          align="start"
          title="添加角色"
          selectedIds={characterIds}
          onPick={(c) => actions.addCharacter(c.id)}
          onCandidate={actions.addCandidate}
        >
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-line-strong px-3 text-[12.5px] text-fg-muted transition-colors hover:border-fg-subtle hover:bg-hover hover:text-fg data-[state=open]:border-fg-subtle data-[state=open]:text-fg"
          >
            <Plus className="size-3.5" />
            {characterIds.length ? '添加' : '添加角色'}
          </button>
        </CharacterPicker>
      </div>

      {characterIds.length === 0 && pending.length === 0 && (
        <p className="mt-2.5 text-xs leading-relaxed text-fg-subtle">这张还没有归到任何角色。</p>
      )}

      {pending.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-fg-subtle">
            <Sparkles className="size-3" />
            识别建议
          </div>
          <ul>
            {pending.map((s) => (
              <SuggestionRow
                key={s.danbooruTag}
                suggestion={s}
                busy={actions.busy.accept === s.danbooruTag}
                disabled={!!actions.busy.accept}
                onAccept={() => actions.acceptSuggestion(s.danbooruTag)}
              />
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** 「自动」标识的说明：依据哪个来源 */
function autoHint(link: CharacterLinkProvenance): string {
  if (link.source === 'pixiv') return '自动关联 · 依据 Pixiv 投稿标签';
  if (link.source === 'tagger') return link.score != null ? `自动关联 · 识别模型 ${formatConfidence(link.score)}` : '自动关联 · 识别模型';
  return '自动关联';
}

function CharacterChip({ id, link, onRemove, onNavigate }: { id: ID; link?: CharacterLinkProvenance; onRemove: () => void; onNavigate: () => void }) {
  const { data, isPending } = useCharacter(id);
  if (isPending) return <Skeleton className="h-8 w-24 rounded-full" />;
  const c = data?.character;
  if (!c) return null;
  return (
    <span className="group/chip inline-flex h-8 max-w-full animate-fade-in items-center rounded-full bg-raised pr-1 shadow-[0_0_0_1px_var(--c-line)] transition-shadow hover:shadow-[0_0_0_1px_var(--c-line-strong)]">
      <Link to={`/characters/${c.id}`} onClick={onNavigate} className="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-1">
        <CharacterAvatar character={c} size={24} shape="circle" />
        <span className="truncate text-[12.5px] font-medium">{c.name}</span>
        {link?.decision === 'auto' && (
          <Tooltip content={autoHint(link)} side="top">
            <span className="shrink-0 text-[10px] text-fg-subtle">自动</span>
          </Tooltip>
        )}
      </Link>
      <button
        type="button"
        aria-label={`移除「${c.name}」`}
        onClick={onRemove}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle opacity-60 transition-[opacity,background-color,color] group-hover/chip:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function SuggestionRow({
  suggestion: s,
  busy,
  disabled,
  onAccept,
}: {
  suggestion: CharacterSuggestion;
  busy: boolean;
  disabled: boolean;
  onAccept: () => void;
}) {
  return (
    <li className="-mx-2.5 flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[13px] font-medium">{s.name}</span>
          {s.workName && <span className="truncate text-[11px] text-fg-subtle">{s.workName}</span>}
          {/* 库里还没有这个角色，采纳时会自动新建 */}
          {!s.characterId && (
            <span className="shrink-0 rounded-full bg-sunken px-1.5 py-px text-[10px] font-medium text-fg-muted">
              新角色
            </span>
          )}
        </div>
        {s.source === 'pixiv' ? <p className="mt-1 text-[11px] text-fg-subtle">Pixiv 标签 · {suggestionEvidence(s).value}</p> : s.score > 0 && <div className="mt-1.5 flex items-center gap-2">
          <Progress value={s.score} tone="shu" />
          <span className="shrink-0 text-right text-[11px] text-fg-muted tabular" title="识别模型的置信度">{formatConfidence(s.score)}</span>
        </div>}
      </div>
      <Button size="sm" variant="secondary" loading={busy} disabled={disabled && !busy} onClick={onAccept}>
        采纳
      </Button>
    </li>
  );
}
