import type { Work } from '@emaki/shared';
import { motion } from 'motion/react';
import type { CSSProperties, Ref } from 'react';
import { CoverFan } from '@/components/media/CoverFan';
import { Thumb } from '@/components/media/Thumb';
import { Badge, Skeleton } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { CopyTag } from '@/features/characters/detail/HeroControls';
import { EASE_OUT } from '@/lib/motion';

const EASE = EASE_OUT;

const rise = (i: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: EASE, delay: 0.06 + i * 0.05 },
});

/**
 * 作品 Hero：和角色详情同一套语言，但更轻——
 * 不用暗化的模糊大图，而是作品主题色调出来的一张「染色纸」，封面从右侧淡入纸里。
 * 主题色和 --c-sheet 混合，暗色模式下自然变成深色染纸。
 */
export function WorkHero({ work, heroRef }: { work: Work; heroRef?: Ref<HTMLElement> }) {
  const mix = (pct: number) => `color-mix(in oklab, ${work.color} ${pct}%, var(--c-sheet))`;
  const paper: CSSProperties = {
    background: `linear-gradient(115deg, ${mix(24)} 0%, ${mix(10)} 52%, ${mix(18)} 100%)`,
  };
  // 封面向左渐隐进纸面，给左侧文字留出干净的底
  const fade = 'linear-gradient(to left, rgb(0 0 0) 42%, transparent 92%)';

  return (
    <section
      ref={heroRef}
      aria-label={`${work.name} 的概况`}
      className="group/fan relative isolate h-[300px] overflow-hidden rounded-[22px] ring-1 ring-line"
      style={paper}
    >
      {/* 右侧：作品前三位角色的封面扇形（CR-13）；不足两张时退回单张封面淡入 */}
      {work.covers.length >= 2 ? (
        <motion.div
          aria-hidden
          className="absolute top-1/2 right-16 w-[300px] -translate-y-1/2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
        >
          <CoverFan covers={work.covers} tint={work.color} label={work.name} />
        </motion.div>
      ) : work.coverImageId && (
        <motion.div
          aria-hidden
          className="absolute inset-y-0 right-0 w-[60%]"
          style={{ maskImage: fade, WebkitMaskImage: fade }}
          initial={{ opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 1.1, ease: EASE }}
        >
          <Thumb
            image={{ id: work.coverImageId, dominantColor: 'transparent', rating: work.coverRating }}
            width={960}
            focus={{ x: 0.5, y: 0.3 }}
            eager
            className="size-full"
          />
        </motion.div>
      )}

      <div className="relative flex h-full max-w-[min(560px,56%)] flex-col justify-between p-9">
        <div className="min-w-0">
          <motion.div {...rise(0)} className="mb-4 flex items-center gap-3">
            <Seal glyph={work.name.slice(0, 1)} />
            <span className="text-[11.5px] font-medium tracking-[0.24em] text-fg-muted">作品</span>
            {work.danbooruTag ? <CopyTag tag={work.danbooruTag} /> : <Badge>自建</Badge>}
          </motion.div>
          <motion.h2 {...rise(1)} className="truncate text-[34px] leading-tight font-semibold tracking-tight">
            {work.name}
          </motion.h2>
          {work.aliases.length > 0 && (
            <motion.p {...rise(2)} className="mt-1 truncate text-[13px] text-fg-muted">
              {work.aliases.join(' · ')}
            </motion.p>
          )}
        </div>

        <motion.dl {...rise(3)} className="flex items-end gap-9">
          <Stat value={work.characterCount} label="位角色" />
          <Stat value={work.imageCount} label={work.otherCount > 0 ? `张插画 · 另有 ${formatCount(work.otherCount)} 张漫画等` : '张插画'} />
          <Stat value={work.recentImageCount} label="最近 30 天" fresh={work.recentImageCount > 0} />
        </motion.dl>
      </div>
    </section>
  );
}

/** 朱色小印：作品名的第一个字，像盖在画卷角上的印章 */
function Seal({ glyph }: { glyph: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-8 rotate-[-5deg] items-center justify-center rounded-[7px] border-[1.5px] border-shu font-display text-[17px] leading-none text-shu"
    >
      {glyph}
    </span>
  );
}

function Stat({ value, label, fresh }: { value: number; label: string; fresh?: boolean }) {
  return (
    // DOM 里 dt 在前（语义正确），视觉上用 col-reverse 把数字放上面
    <div className="flex flex-col-reverse">
      <dt className="mt-1.5 flex items-center gap-1.5 text-[12px] text-fg-muted">
        {fresh && <span className="size-1.5 rounded-full bg-shu" />}
        {label}
      </dt>
      <dd className="numeral text-[44px] text-fg">
        {fresh ? '+' : ''}
        {formatCount(value)}
      </dd>
    </div>
  );
}

export function WorkHeroSkeleton() {
  return (
    <div className="relative h-[300px] overflow-hidden rounded-[22px] bg-sunken/50">
      <div className="flex h-full flex-col justify-between p-9">
        <div>
          <div className="mb-4 flex items-center gap-3">
            <Skeleton className="size-8 rounded-[7px]" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-7 w-32 rounded-full" />
          </div>
          <Skeleton className="h-10 w-72" />
          <Skeleton className="mt-2 h-3.5 w-56" />
        </div>
        <div className="flex items-end gap-9">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-10 w-20" />
              <Skeleton className="mt-2 h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
