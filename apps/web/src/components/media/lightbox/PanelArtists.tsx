import type { ImageArtist } from '@emaki/shared';
import { Plus, X } from 'lucide-react';
import { Link } from 'react-router';
import { ArtistPicker } from '@/features/gallery/ArtistPicker';
import { Section } from './PanelParts';
import type { ImageActions } from './useImageActions';

/**
 * 画师：识别出的（或手动改的）画师 chip，点名字看这位画师的图，× 去掉；「添加」从认出过的画师里挑，或者直接输入名字。
 * 改过的图之后识别不再动它，可以改回自动识别。
 */
export function PanelArtists({
  artists,
  manual,
  actions,
  onNavigate,
}: {
  artists: ImageArtist[];
  manual: boolean;
  actions: ImageActions;
  /** 点进图库前关掉看图器 */
  onNavigate: () => void;
}) {
  const busy = actions.busy.artist;
  return (
    <Section title="画师" meta={artists.length > 1 ? `${artists.length} 位` : undefined}>
      <div className="flex flex-wrap gap-1.5">
        {artists.map((a) => (
          <span
            key={a.tag}
            className="group/chip inline-flex h-8 max-w-full animate-fade-in items-center rounded-full bg-raised pr-1 shadow-[0_0_0_1px_var(--c-line)] transition-shadow hover:shadow-[0_0_0_1px_var(--c-line-strong)]"
          >
            <Link
              to={`/gallery?artist=${encodeURIComponent(a.tag)}`}
              onClick={onNavigate}
              title={a.name !== a.tag.replace(/_/g, ' ') ? a.tag : undefined}
              className="min-w-0 truncate py-1 pr-1 pl-3 text-[12.5px] font-medium"
            >
              {a.name}
            </Link>
            <button
              type="button"
              aria-label={`去掉画师「${a.name}」`}
              disabled={busy}
              onClick={() => actions.removeArtist(a.tags)}
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle opacity-60 transition-[opacity,background-color,color] group-hover/chip:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 disabled:opacity-30"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <ArtistPicker
          side="left"
          align="start"
          title="添加画师"
          selectedTags={artists.flatMap((a) => a.tags)}
          onPick={(tag) => actions.addArtist(tag)}
          actions={
            artists.length
              ? [{ key: 'none', label: '没有画师 / 不知道是谁', hint: '去掉认出的画师，以后也不再自动认', onSelect: actions.clearArtists }]
              : undefined
          }
        >
          <button
            type="button"
            disabled={busy}
            className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-line-strong px-3 text-[12.5px] text-fg-muted transition-colors hover:border-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-50 data-[state=open]:border-fg-subtle data-[state=open]:text-fg"
          >
            <Plus className="size-3.5" />
            {artists.length ? '添加' : '添加画师'}
          </button>
        </ArtistPicker>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
        {manual ? (
          <>
            你手动改的，识别不会再动它 ·{' '}
            <button
              type="button"
              disabled={busy}
              onClick={actions.artistsAuto}
              className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            >
              改回自动识别
            </button>
          </>
        ) : artists.length ? (
          '自动识别 · 认错了就去掉或添加，改过的不会再被识别覆盖'
        ) : (
          '没认出画师'
        )}
      </p>
    </Section>
  );
}
