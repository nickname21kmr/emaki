import type { ID, Work } from '@emaki/shared';
import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Chip, ChipAvatar, SearchInput, Skeleton } from '@/components/ui';
import { useWorks } from '@/lib/queries';

/**
 * 所属作品多选：上面是已选（第一个是主作品），下面是可搜索的候选。
 * 作品可能有几百部，所以不全部铺开，只显示最常用的几个 + 搜索结果。
 */
export function WorkPicker({ value, onChange }: { value: ID[]; onChange: (v: ID[]) => void }) {
  const { data: works = [], isPending } = useWorks({ sort: 'imageCount' });
  const [q, setQ] = useState('');

  const byId = useMemo(() => new Map(works.map((w) => [w.id, w])), [works]);
  const selected = value.flatMap((id) => {
    const w = byId.get(id);
    return w ? [w] : [];
  });

  const needle = q.trim().toLowerCase();
  const candidates = works
    .filter((w) => !value.includes(w.id))
    .filter(
      (w) =>
        !needle ||
        w.name.toLowerCase().includes(needle) ||
        (w.danbooruTag ?? '').includes(needle) ||
        w.aliases.some((a) => a.toLowerCase().includes(needle)),
    )
    .slice(0, needle ? 12 : 8);

  if (isPending) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-lg p-3 ring-1 ring-line">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((w, i) => (
            <Chip
              key={w.id}
              selected
              leading={<WorkAvatar work={w} />}
              onClick={() => onChange(value.filter((id) => id !== w.id))}
              aria-label={`移除作品 ${w.name}`}
            >
              <span className="inline-flex items-center gap-1.5">
                {w.name}
                {i === 0 && selected.length > 1 && <span className="text-[10.5px] text-fg-inverse/55">主</span>}
                <X className="size-3 text-fg-inverse/55" />
              </span>
            </Chip>
          ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-fg-subtle">还没选作品，自建角色也可以不属于任何作品。</p>
      )}

      <div className="my-3 h-px bg-line" />

      <SearchInput
        size="sm"
        placeholder="搜索作品（名字、别名、Danbooru 标签）"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onClear={() => setQ('')}
        onKeyDown={(e) => {
          // 回车直接选中第一个结果，不提交整个表单
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const first = candidates[0];
            if (first) {
              onChange([...value, first.id]);
              setQ('');
            }
          }
        }}
      />
      <div className="mt-2.5 flex min-h-8 flex-wrap gap-1.5">
        {candidates.length ? (
          candidates.map((w) => (
            <Chip
              key={w.id}
              size="sm"
              leading={<WorkAvatar work={w} small />}
              onClick={() => {
                onChange([...value, w.id]);
                setQ('');
              }}
            >
              <span className="inline-flex items-center gap-1">
                {w.name}
                <Plus className="size-3 text-fg-subtle" />
              </span>
            </Chip>
          ))
        ) : (
          <p className="py-1.5 text-[12.5px] text-fg-subtle">{needle ? `没有叫「${q.trim()}」的作品` : '没有更多作品了'}</p>
        )}
      </div>
    </div>
  );
}

function WorkAvatar({ work, small }: { work: Work; small?: boolean }) {
  const avatar = (
    <ChipAvatar
      image={work.coverImageId ? { id: work.coverImageId, rating: work.coverRating, color: work.coverColor } : null}
      color={work.color}
      label={work.name}
    />
  );
  // sm 号 chip 里头像缩小一点
  return small ? <span className="inline-flex scale-[0.84]">{avatar}</span> : avatar;
}
