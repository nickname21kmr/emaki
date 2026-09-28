import { Check } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { SECTIONS, sectionNumber, type SectionId } from '../sections';

/**
 * 左侧小目录（吸顶）。当前节左边一道朱色竖线，和侧边栏的「书签」同一个语言。
 */
export function SettingsToc({ active, onJump }: { active: SectionId; onJump: (id: SectionId) => void }) {
  return (
    <nav aria-label="设置目录" className="sticky top-8 hidden w-44 shrink-0 self-start lg:block">
      <ol className="border-l border-line">
        {SECTIONS.map((s, i) => {
          const on = s.id === active;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onJump(s.id)}
                aria-current={on ? 'location' : undefined}
                className={cn(
                  'group relative flex w-full items-baseline gap-3 py-[7px] pl-4 text-left text-[13px] transition-colors duration-200',
                  on ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {on && (
                  <motion.span
                    layoutId="settings-toc-mark"
                    className="absolute top-1.5 bottom-1.5 -left-px w-0.5 rounded-full bg-shu"
                    transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                  />
                )}
                <span
                  className={cn(
                    'numeral w-5 shrink-0 text-[15px] tabular transition-colors duration-200',
                    on ? 'text-fg' : 'text-fg-subtle group-hover:text-fg-muted',
                  )}
                >
                  {sectionNumber(i)}
                </span>
                <span className="truncate">{s.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-6 flex items-center gap-1.5 pl-4 text-xs text-fg-subtle">
        <Check className="size-3.5" />
        修改会即时保存
      </p>
    </nav>
  );
}
