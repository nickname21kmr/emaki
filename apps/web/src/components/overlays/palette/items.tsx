import type { FocusPoint, ID, Rating, Work } from '@emaki/shared';
import { Command, useCommandState } from 'cmdk';
import { Hash, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Fragment, type ReactNode } from 'react';
import { Kbd, Skeleton } from '@/components/ui';
import { Thumb } from '@/components/media/Thumb';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import type { KeyCombo } from '../shortcuts';

/**
 * 命令面板的一行。所有行同高（48px），这样选中底座在行之间滑动时不会被拉伸变形。
 */
export function PaletteItem({
  value,
  onSelect,
  leading,
  title,
  subtitle,
  trailing,
}: {
  value: string;
  onSelect: () => void;
  leading: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}) {
  const active = useCommandState((s) => s.value === value);
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      // 点击时别把焦点从输入框抢走，否则继续打字会落空
      onMouseDown={(e) => e.preventDefault()}
      className="group relative flex h-12 cursor-default items-center gap-3 rounded-[11px] px-3 outline-none select-none"
    >
      {active && (
        <motion.span
          layoutId="palette-active"
          aria-hidden
          className="absolute inset-0 rounded-[11px] bg-hover"
          transition={{ type: 'spring', stiffness: 700, damping: 48, mass: 0.6 }}
        >
          {/* 朱色书签线，和侧边栏当前项同一个语言 */}
          <span className="absolute top-1/2 left-0 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-shu" />
        </motion.span>
      )}
      <span className="relative flex shrink-0">{leading}</span>
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-[14px] leading-5 font-medium text-fg">{title}</span>
        {subtitle && <span className="block truncate text-[12px] leading-4 text-fg-muted">{subtitle}</span>}
      </span>
      {trailing && (
        <span className="relative flex shrink-0 items-center gap-2.5 text-[12px] text-fg-subtle tabular">{trailing}</span>
      )}
    </Command.Item>
  );
}

export function GroupHeading({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1.5 text-[11.5px] font-medium tracking-wide text-fg-subtle">
      <span>{title}</span>
      {extra && <span className="tabular">{extra}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- 行首

const TILE = 'size-[34px] shrink-0';

/** 角色：圆形头像，按封面焦点裁到脸 */
export function CharacterAvatar({
  name,
  coverImageId,
  coverFocus,
  coverRating,
}: {
  name: string;
  coverImageId: ID | null;
  coverFocus: FocusPoint | null;
  /** 最近访问的快照里可能没有（旧数据），按 general 处理 */
  coverRating?: Rating;
}) {
  if (!coverImageId) {
    return (
      <span className={cn(TILE, 'flex items-center justify-center rounded-full bg-sunken font-display text-[17px] text-fg-muted')}>
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    <Thumb
      image={{ id: coverImageId, dominantColor: 'var(--c-sunken)', rating: coverRating ?? 'general' }}
      width={240}
      focus={coverFocus}
      className={cn(TILE, 'rounded-full ring-1 ring-line')}
    />
  );
}

/** 作品：圆角方形封面，右下角一颗作品主题色的小点 */
export function WorkTile({ work }: { work: Pick<Work, 'name' | 'coverImageId' | 'color' | 'coverRating'> }) {
  return (
    <span className={cn(TILE, 'relative')}>
      {work.coverImageId ? (
        <Thumb
          image={{ id: work.coverImageId, dominantColor: work.color, rating: work.coverRating }}
          width={240}
          className="size-full rounded-[10px] ring-1 ring-line"
        />
      ) : (
        <span
          className="flex size-full items-center justify-center rounded-[10px] text-[15px] font-semibold text-white"
          style={{ background: work.color }}
        >
          {work.name.slice(0, 1)}
        </span>
      )}
      <span
        className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-raised"
        style={{ background: work.color }}
      />
    </span>
  );
}

export function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      className={cn(
        TILE,
        'flex items-center justify-center rounded-[10px] bg-sunken text-fg-muted transition-colors duration-150',
        'group-data-[selected=true]:text-fg',
      )}
    >
      <Icon className="size-[17px]" strokeWidth={1.8} />
    </span>
  );
}

export function TagTile() {
  return <IconTile icon={Hash} />;
}

// ---------------------------------------------------------------- 行尾

export function CountMeta({ count, unit = '张', newCount }: { count: number; unit?: string; newCount?: number }) {
  return (
    <>
      {!!newCount && (
        <span className="flex items-center gap-1 text-fg-muted">
          <span className="size-1.5 rounded-full bg-shu" />+{formatCount(newCount)}
        </span>
      )}
      <span>
        {formatCount(count)} {unit}
      </span>
    </>
  );
}

export function KeyHint({ keys }: { keys: KeyCombo }) {
  return (
    <span className="flex items-center gap-0.5">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- 文本

/** 把命中搜索词的那一段加一道朱色下划线（不整段染色，保持克制） */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent text-inherit underline decoration-shu decoration-[1.5px] underline-offset-[3px]">
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** 用 · 连接若干段，自动跳过空的 */
export function Dotted({ parts }: { parts: ReactNode[] }) {
  const list = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== '');
  return (
    <>
      {list.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="px-1 text-fg-subtle">·</span>}
          {p}
        </Fragment>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- 骨架

/** 和真实行同尺寸的骨架；延迟一点再淡入，快速返回时就不会闪一下 */
export function PaletteSkeleton({ rows = 4, heading = true }: { rows?: number; heading?: boolean }) {
  return (
    <div aria-hidden className="animate-fade-in" style={{ animationDelay: '140ms' }}>
      {heading && (
        <div className="px-3 pt-3 pb-2">
          <Skeleton className="h-2.5 w-10" />
        </div>
      )}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-12 items-center gap-3 px-3">
          <Skeleton className="size-[34px] shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3" style={{ width: `${34 + ((i * 23) % 28)}%` }} />
            <Skeleton className="h-2.5" style={{ width: `${18 + ((i * 11) % 14)}%` }} />
          </div>
          <Skeleton className="h-2.5 w-12" />
        </div>
      ))}
    </div>
  );
}
