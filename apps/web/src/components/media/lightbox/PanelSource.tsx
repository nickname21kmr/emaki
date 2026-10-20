import type { ImageDetail, ImageSource, UpdateImageBody } from '@emaki/shared';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';

const SITE_LABEL: Record<ImageSource['site'], string> = {
  pixiv: 'Pixiv', twitter: 'X / Twitter', danbooru: 'Danbooru', fanbox: 'FANBOX', other: '其他',
};
const control = 'rounded-md border border-line bg-transparent px-2 py-1.5 disabled:opacity-40';

export function PanelSource({ detail }: { detail: ImageDetail }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [artist, setArtist] = useState('');
  const change = useMutate((source: UpdateImageBody['source']) => api.updateImage(detail.id, { source }), {
    onSuccess: () => setEditing(false),
  });
  const source = detail.source;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {source ? (
            <>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 hover:text-shu-fg hover:underline">
                  <span className="truncate">{SITE_LABEL[source.site]}{source.postId && ` #${source.postId}`}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : SITE_LABEL[source.site]}
              {source.artist && <div className="mt-0.5 break-words text-fg-muted">作者 {source.artist}</div>}
            </>
          ) : <span className="text-fg-subtle">{detail.sourceManual ? '已清除' : '未知'}</span>}
          <div className="mt-1 text-[11px] text-fg-subtle" title={detail.sourceManual ? '扫描时保留此设置，可通过「编辑来源」修改' : undefined}>{detail.sourceManual ? '手动设置' : '自动解析'}</div>
        </div>
        {!editing && <button type="button" className="shrink-0 text-fg-muted hover:text-fg" onClick={() => {
          setUrl(source?.url ?? ''); setArtist(source?.artist ?? ''); setEditing(true);
        }}>编辑来源</button>}
      </div>
      {editing && (
        <form
          className="space-y-2"
          onSubmit={e => { e.preventDefault(); change.mutate({ url: url.trim(), artist: artist.trim() }); }}
          // Esc 只取消编辑；看图器那边已经不会因为这个 Esc 关掉（见 Lightbox 的 onEscapeKeyDown）
          onKeyDown={e => { if (e.key === 'Escape' && !change.isPending) setEditing(false); }}
        >
          <fieldset disabled={change.isPending} className="min-w-0 space-y-2">
            <label className="block space-y-1">
              <span className="text-fg-muted">原作链接</span>
              <input type="url" required maxLength={4000} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" className={`${control} w-full min-w-0`} />
            </label>
            <label className="block space-y-1">
              <span className="text-fg-muted">来源作者（可选）</span>
              <input maxLength={200} value={artist} onChange={e => setArtist(e.target.value)} className={`${control} w-full min-w-0`} />
            </label>
            <p className="text-[11px] leading-relaxed text-fg-subtle">保存的来源会在扫描时保留。此处填写来源页上的作者；图库画师归类在「画师」中编辑。</p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={`${control} text-shu-fg`}>保存来源</button>
              <button type="button" className={control} onClick={() => setEditing(false)}>取消</button>
              <button type="button" className={control} onClick={() => change.mutate(null)}>清除来源</button>
              {/* 自动来源按当前文件名重算（和扫描、backfill 一致）。改名前带过来的来源不会回来，只能撤销手动编辑找回 */}
              {detail.sourceManual && (
                <button type="button" className={control} title="按当前文件名重新解析，改名前的来源不会恢复（可按 Ctrl+Z 撤销）" onClick={() => change.mutate('auto')}>
                  恢复自动解析
                </button>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}
