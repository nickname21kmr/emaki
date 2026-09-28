import { ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';
import { EASE_OUT } from '@/lib/motion';

export interface Crumb {
  label: string;
  to: string;
}

/**
 * 详情页的吸顶头部：面包屑（角色 › 蔚蓝档案 › 圣园未花）+ 全局操作。
 * Hero 滚出视野后，当前项前面淡入一个小头像，让人始终知道自己在看谁。
 */
export function DetailHeader({
  crumbs,
  current,
  avatar,
  showAvatar,
  actions,
}: {
  crumbs: Crumb[];
  current: ReactNode;
  avatar?: ReactNode;
  showAvatar?: boolean;
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      chapter={false}
      sticky
      actions={actions}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          {crumbs.map((c) => (
            <Fragment key={c.to}>
              <Link
                to={c.to}
                className="shrink-0 text-fg-subtle transition-colors duration-200 hover:text-fg"
              >
                {c.label}
              </Link>
              <ChevronRight className="size-4 shrink-0 text-fg-subtle/70" aria-hidden />
            </Fragment>
          ))}
          <AnimatePresence initial={false}>
            {showAvatar && avatar && (
              <motion.span
                key="avatar"
                initial={{ opacity: 0, width: 0, scale: 0.7 }}
                animate={{ opacity: 1, width: 'auto', scale: 1 }}
                exit={{ opacity: 0, width: 0, scale: 0.7 }}
                transition={{ duration: 0.3, ease: EASE_OUT }}
                className="flex shrink-0 items-center overflow-hidden"
              >
                <span className="mr-1 block">{avatar}</span>
              </motion.span>
            )}
          </AnimatePresence>
          <span className="truncate">{current}</span>
        </span>
      }
    />
  );
}
