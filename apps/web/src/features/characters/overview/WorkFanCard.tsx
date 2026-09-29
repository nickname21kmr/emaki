import type { ID, Work } from '@emaki/shared';
import { Link } from 'react-router';
import { CoverFan } from '@/components/media/CoverFan';
import { Seal, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';

/** 扇形盒子：列宽的 96%，上限 400px（第二轮反馈：76% 偏小、作品之间空太多）（CoverFan 几何全是百分比，跟着缩放） */
const FAN_BOX = 'mx-auto w-[96%] max-w-[400px]';

/**
 * 作品扇形卡（OV-2，参考图的作品卡）：3 张封面扇形叠放，悬停 / 键盘聚焦时微微展开；
 * 下方居中写作品名，再一行「N 位 · N 张 · +N」（+N 是近 30 天新图，用 ok 色）。
 * 点击切到这部作品（Ctrl / 中键照常在新标签打开）。
 */
export function WorkFanCard({ work, index, onPick }: { work: Work; index: number; onPick: (id: ID) => void }) {
  return (
    <Link
      to={{ search: `?work=${work.id}` }}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onPick(work.id);
      }}
      aria-label={`${work.name}：${work.characterCount} 位角色，${work.imageCount} 张`}
      className="group/fan block animate-rise rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-shu focus-visible:ring-offset-4 focus-visible:ring-offset-sheet"
      style={{ animationDelay: `${Math.min(index, 11) * 30}ms` }}
    >
      <div className={FAN_BOX}>
        <CoverFan covers={work.covers} tint={work.color} label={work.name} />
      </div>
      {work.danbooruTag === 'original' ? (
        // 「原创」是你自己归的图，和别的作品不一样：盖一枚印、标题用朱色，一眼能找到
        <div className="mt-2.5 flex items-center justify-center gap-1.5 px-2 text-[15px] font-semibold tracking-tight text-shu">
          <Seal glyph="原" size={20} />
          <span className="truncate">{work.name}</span>
        </div>
      ) : (
        <div className="mt-2.5 truncate px-2 text-center text-[15px] font-semibold tracking-tight">{work.name}</div>
      )}
      <span aria-hidden className="mx-auto mt-[7px] block h-px w-4 bg-rule" />
      <div className="mt-1.5 text-center text-[12px] text-fg-muted tabular">
        {formatCount(work.characterCount)} 位 · {formatCount(work.imageCount)} 张
        {work.recentImageCount > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-ok">+{formatCount(work.recentImageCount)}</span>
          </>
        )}
      </div>
    </Link>
  );
}

export function WorkFanSkeleton() {
  return (
    <div aria-hidden>
      <div className={cn('relative aspect-[6/5]', FAN_BOX)}>
        <Skeleton className="absolute top-[6%] left-[23%] aspect-[3/4] w-[54%] rounded-[var(--radius-plate)]" />
      </div>
      <Skeleton className="mx-auto mt-3 h-4 w-24" />
      <Skeleton className="mx-auto mt-2 h-3 w-32" />
    </div>
  );
}
