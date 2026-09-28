import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/cn';

/** 小节右上角的「查看全部 →」 */
export function SeeAllLink({ to, children = '查看全部' }: { to: string; children?: ReactNode }) {
  return (
    <Link
      to={to}
      className="group/see -mr-2 inline-flex h-7 items-center gap-1 rounded-full pr-2 pl-2.5 text-[12.5px] font-medium text-fg-muted transition-colors duration-200 hover:bg-hover hover:text-fg"
    >
      {children}
      <ArrowRight className="size-3.5 transition-transform duration-300 ease-[var(--ease-out-soft)] group-hover/see:translate-x-0.5" />
    </Link>
  );
}

/** 小节内的轻量空状态：一行字 + 虚线框，不喧宾夺主 */
export function QuietNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-[14px] border border-dashed border-line-strong px-6 text-center text-[13px] text-fg-subtle',
        className,
      )}
    >
      {children}
    </div>
  );
}
