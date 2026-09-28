import type { ContentKind, Rating } from '@emaki/shared';
import { AvatarTile } from '@/components/media/AvatarTile';
import { CharacterCover } from '@/components/media/CharacterCover';
import { CoverFan } from '@/components/media/CoverFan';
import { RecentStrip } from '@/components/media/RecentStrip';
import { Thumb } from '@/components/media/Thumb';
import { blurReason } from '@/lib/blur';
import { useImagesInfinite, useTopCharacters, useWorks } from '@/lib/queries';
import { useBlurPrefs } from '@/lib/stores';

/**
 * 开发用：M5 共用件并排展示（只在 import.meta.env.DEV 时注册路由 /dev/ui）。
 * 验收截图、调参数都在这里看，不影响正式页面。
 */
export function DevUiPage() {
  const works = useWorks({ sort: 'imageCount' }).data ?? [];
  const top = useTopCharacters({ limit: 12 }).data ?? [];
  const images = useImagesInfinite({ limit: 60 }).data?.pages.flatMap((p) => p.items) ?? [];
  const ratings: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];
  const fanWork = works.find((w) => w.covers.length >= 3) ?? works[0];
  const prefs = useBlurPrefs();
  const blurCases: [Rating, ContentKind][] = [
    ['general', 'illustration'],
    ['sensitive', 'photo'],
    ['general', 'photo'],
    ['general', 'text'],
    ['questionable', 'text'],
    ['explicit', 'illustration'],
  ];

  return (
    <div className="space-y-12 px-8 py-8">
      <h1 className="text-2xl font-semibold">共用件（/dev/ui）</h1>

      {images[0] && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-fg-muted">模糊策略（D6）：同一张图换分级和类型</h2>
          <div className="grid grid-cols-3 gap-4">
            {blurCases.map(([rating, kind]) => (
              <div key={rating + kind}>
                <Thumb image={{ id: images[0]!.id, dominantColor: images[0]!.dominantColor, rating, kind }} width={480} className="h-[200px] rounded-[var(--radius-plate)]" />
                <div className="mt-1 text-xs text-fg-muted">
                  {rating} · {kind} → {blurReason({ rating, kind }, prefs) ?? '不模糊'}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-4 text-sm font-semibold text-fg-muted">CoverFan：0 / 1 / 2 / 3 张封面，悬停展开</h2>
        <div className="grid grid-cols-4 gap-8">
          {[0, 1, 2, 3].map((n) => (
            <button key={n} type="button" className="group/fan block rounded-[18px] text-left">
              <CoverFan covers={(fanWork?.covers ?? []).slice(0, n)} tint={fanWork?.color} label={fanWork?.name} />
              <div className="mt-2.5 text-center text-[15px] font-semibold tracking-tight">{fanWork?.name}</div>
              <div className="mt-1 text-center text-[12.5px] text-fg-muted tabular">
                {n} 张封面 · <span className="font-semibold text-ok">+7</span>
              </div>
            </button>
          ))}
        </div>
        <div className="mt-10 max-w-[420px]">
          <h2 className="mb-4 text-sm font-semibold text-fg-muted">CoverFan count=5</h2>
          <button type="button" className="group/fan block w-full">
            <CoverFan
              count={5}
              covers={images.slice(0, 5).map((i) => ({ imageId: i.id, rating: i.rating, color: i.dominantColor }))}
            />
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold text-fg-muted">CharacterCover：overlay / plate</h2>
        <div className="grid grid-cols-6 gap-4">
          {top.slice(0, 3).map((c) => (
            <CharacterCover key={c.id} character={c} workName="作品名" className="h-[260px]" showNew={false} />
          ))}
          {top.slice(3, 6).map((c) => (
            <CharacterCover key={c.id} character={c} workName="作品名" variant="plate" />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold text-fg-muted">Thumb：四种分级 × 三种模糊标记</h2>
        <div className="grid grid-cols-4 gap-4">
          {ratings.map((r) => {
            const img = images[0];
            if (!img) return null;
            return (
              <div key={r} className="space-y-2">
                <div className="text-xs text-fg-subtle">{r}</div>
                <Thumb image={{ ...img, rating: r }} className="h-[200px] rounded-[var(--radius-plate)]" />
                <div className="flex gap-2">
                  <Thumb image={{ ...img, rating: r }} blurBadge="corner" width={240} className="size-20 rounded-[var(--radius-plate-sm)]" />
                  <Thumb image={{ ...img, rating: r }} blurBadge="center" width={240} className="size-16 rounded-full" />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold text-fg-muted">AvatarTile / RecentStrip</h2>
        <div className="mb-6 flex gap-4">
          {top.slice(0, 2).map((c) => (
            <AvatarTile key={c.id} character={c} workName="作品名" size="lg" />
          ))}
        </div>
        <RecentStrip characters={top} workNameOf={() => '作品名'} />
      </section>
    </div>
  );
}
