import type { ID, UnrecognizedItem } from '@emaki/shared';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Thumb } from '@/components/media/Thumb';
import { formatCount } from '@/lib/format';
import { EASE_OUT } from '@/lib/motion';

const EASE = EASE_OUT;
const MAX_SHOWN = 30;

/**
 * 多选时预览区换成一张「印样」：选中的图排成小网格，一眼确认要一起处理的是哪些。
 * 点某张可以把它从选择里拿掉。
 */
export function BatchPreview({ items, onToggle }: { items: UnrecognizedItem[]; onToggle: (id: ID) => void }) {
  const shown = items.slice(0, MAX_SHOWN);
  const more = items.length - shown.length;

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto rounded-[20px] bg-sunken p-7 shadow-[inset_0_0_0_1px_var(--c-line)] scrollbar-thin">
      <div className="mb-5 flex items-baseline gap-2.5">
        <span className="numeral text-[52px] text-fg">{formatCount(items.length)}</span>
        <span className="text-[13px] text-fg-muted">张已选中，将一起归类</span>
      </div>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
        <AnimatePresence initial={false}>
          {shown.map((it) => (
            <motion.li
              key={it.image.id}
              layout
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={{ duration: 0.26, ease: EASE }}
            >
              <button
                onClick={() => onToggle(it.image.id)}
                aria-label={`取消选中 ${it.image.fileName}`}
                className="group relative block aspect-[3/4] w-full overflow-hidden rounded-[12px] shadow-card ring-1 ring-line"
              >
                <Thumb
                  image={it.image}
                  width={240}
                  className="size-full"
                  imgClassName="transition-transform duration-[800ms] ease-[var(--ease-out-soft)] group-hover:scale-[1.04]"
                />
                <span className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100">
                  <X className="size-3.5" />
                </span>
              </button>
            </motion.li>
          ))}
          {more > 0 && (
            <motion.li
              key="__more"
              layout
              className="flex aspect-[3/4] items-center justify-center rounded-[12px] border border-dashed border-line-strong"
            >
              <span className="numeral text-3xl text-fg-muted">+{formatCount(more)}</span>
            </motion.li>
          )}
        </AnimatePresence>
      </ul>
    </div>
  );
}
