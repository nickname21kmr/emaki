import { motion } from 'motion/react';
import { Spinner } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { EASE_OUT } from '@/lib/motion';

/**
 * 网格底部：还在加载 →「正在展开…」；全部加载完 → 一枚小小的「终」字朱印，
 * 像画卷的卷尾（絵巻的「卷終」），告诉用户已经到底了。
 */
export function GridFooter({ loadingMore, done, total }: { loadingMore: boolean; done: boolean; total: number }) {
  if (loadingMore) {
    return (
      <div className="flex h-24 items-center justify-center gap-2 text-xs text-fg-subtle">
        <Spinner className="size-3.5" />
        正在展开…
      </div>
    );
  }
  if (!done) return <div className="h-24" />;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, ease: EASE_OUT }}
      className="flex flex-col items-center gap-3 pt-14 pb-6"
    >
      <div className="flex items-center gap-4">
        <span className="h-px w-16 bg-linear-to-r from-transparent to-line-strong" />
        <span className="flex size-7 rotate-[-6deg] items-center justify-center rounded-[7px] bg-shu font-display text-[15px] leading-none text-white shadow-[0_6px_16px_-8px_var(--c-shu)]">
          终
        </span>
        <span className="h-px w-16 bg-linear-to-l from-transparent to-line-strong" />
      </div>
      <div className="text-xs text-fg-subtle tabular">卷终 · 共 {formatCount(total)} 张</div>
    </motion.div>
  );
}
