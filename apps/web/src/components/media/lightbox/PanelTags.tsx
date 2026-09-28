import type { TagCategory, TagScore } from '@emaki/shared';
import { useMemo, useState } from 'react';
import { Section } from './PanelParts';

const CATEGORY_ORDER: TagCategory[] = ['character', 'copyright', 'artist', 'general', 'meta'];
const CATEGORY_LABEL: Record<TagCategory, string> = {
  character: '角色',
  copyright: '作品',
  artist: '画师',
  general: '通用',
  meta: '元信息',
};
/** 通用标签往往几十个，默认只露出分数最高的这些 */
const GENERAL_PREVIEW = 10;

/**
 * 标签：按类别分组，每个标签右侧一根细条表示 tagger 置信度。
 * 点标签 → 去图库搜这个标签。
 */
export function PanelTags({ tags, onTagClick }: { tags: TagScore[]; onTagClick: (tag: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        cat,
        tags: tags.filter((t) => t.category === cat).sort((a, b) => b.score - a.score),
      })).filter((g) => g.tags.length > 0),
    [tags],
  );

  return (
    <Section title="标签" meta={tags.length ? `${tags.length} 个` : undefined}>
      {groups.length === 0 ? (
        <p className="text-xs leading-relaxed text-fg-subtle">还没有标签。运行识别后，tagger 给出的标签会出现在这里。</p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const collapsible = g.cat === 'general' && g.tags.length > GENERAL_PREVIEW + 2;
            const visible = collapsible && !expanded ? g.tags.slice(0, GENERAL_PREVIEW) : g.tags;
            return (
              <div key={g.cat}>
                <div className="mb-1 text-[11px] text-fg-subtle">{CATEGORY_LABEL[g.cat]}</div>
                <ul>
                  {visible.map((t) => (
                    <li key={t.tag}>
                      <TagRow tag={t} onClick={() => onTagClick(t.tag)} />
                    </li>
                  ))}
                </ul>
                {collapsible && (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="mt-1 text-xs font-medium text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
                  >
                    {expanded ? '收起' : `展开其余 ${g.tags.length - GENERAL_PREVIEW} 个`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function TagRow({ tag: t, onClick }: { tag: TagScore; onClick: () => void }) {
  const pct = Math.round(t.score * 100);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`在图库中搜索 ${t.tag}`}
      className="group/tag -mx-2 flex h-7 w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-hover"
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90 group-hover/tag:text-fg">
        {t.tag.replaceAll('_', ' ')}
      </span>
      <span className="h-[3px] w-12 shrink-0 overflow-hidden rounded-full bg-line">
        <span
          className="block h-full rounded-full bg-fg-subtle transition-colors group-hover/tag:bg-fg-muted"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-6 shrink-0 text-right text-[11px] text-fg-subtle tabular">{pct}</span>
    </button>
  );
}
