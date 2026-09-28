import { Chip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';

export interface IndexEntry {
  key: string;
  label: string;
  hint: string;
  count: number;
}

/** 目次（T34b）：衬线组名、点线、编号；宽屏在左栏，窄屏换成 chip 行 */
export function ThemeIndex({ entries, active, onPick }: { entries: IndexEntry[]; active: string | undefined; onPick: (key: string) => void }) {
  return (
    <nav aria-label="目次" className="hidden w-[216px] shrink-0 flex-col xl:flex">
      <div className="kicker px-2.5 pb-2">目　次</div>
      <ol className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 scrollbar-thin">
        {entries.map((e, i) => {
          const on = e.key === active;
          return (
            <li key={e.key}>
              <button
                type="button"
                aria-current={on || undefined}
                onClick={() => onPick(e.key)}
                className={cn(
                  'group block w-full rounded-[10px] px-2.5 py-[7px] text-left transition-[background-color,box-shadow] duration-200',
                  on ? 'bg-raised shadow-card' : 'hover:bg-hover',
                  e.count === 0 && 'pointer-events-none opacity-40',
                )}
              >
                <span className="flex items-baseline gap-2">
                  <span className={cn('numeral w-[22px] shrink-0 text-[16px] tabular', on ? 'text-shu' : 'text-fg-subtle')}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    className={cn(
                      'font-serif-cjk text-[15px] font-semibold tracking-[.06em] whitespace-nowrap',
                      on ? 'text-fg' : 'text-fg-muted group-hover:text-fg',
                    )}
                  >
                    {e.label}
                  </span>
                  <span aria-hidden className="h-px min-w-3 flex-1 -translate-y-1 border-b border-dotted border-line-strong" />
                  <span className="text-[12px] text-fg-subtle tabular">{formatCount(e.count)}</span>
                </span>
                <span className="mt-0.5 block truncate pl-[30px] text-[11px] text-fg-subtle">{e.hint}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** 窄屏（< 1280）时的目次：一行 chip */
export function ChipRow({ entries, active, onPick }: { entries: IndexEntry[]; active: string | undefined; onPick: (key: string) => void }) {
  return (
    <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none xl:hidden">
      {entries.map((e) => (
        <Chip key={e.key} size="sm" selected={e.key === active} count={e.count} disabled={e.count === 0} onClick={() => onPick(e.key)}>
          {e.label}
        </Chip>
      ))}
    </div>
  );
}
