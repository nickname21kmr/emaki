import { Layers } from 'lucide-react';
import { motion } from 'motion/react';
import { forwardRef, type ReactNode } from 'react';

/**
 * 「可能是同一套」：同一文件夹、尺寸相同、代表图两两相近的几组（差分 CG、连拍）放在一个框里。
 * 只是放在一起看，里面每组照常各自处理；框本身没有「只留一张」这种操作。
 * forwardRef 是给外层 AnimatePresence 的 popLayout 用的。
 */
export const DuplicateSetFrame = forwardRef<HTMLDivElement, { count: number; children: ReactNode }>(function DuplicateSetFrame(
  { count, children },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      className="rounded-[22px] border border-dashed border-line-strong p-2.5"
    >
      <div className="flex items-baseline gap-2 px-2.5 pt-1 pb-3">
        <Layers className="size-3.5 translate-y-0.5 text-fg-subtle" />
        <span className="text-[13px] font-medium">可能是同一套 · {count} 组</span>
        <span className="text-[12px] text-fg-subtle">同一文件夹、尺寸相同、画面相近，多半是差分或连拍。通常是有意留的，请逐组确认。</span>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </motion.div>
  );
});
