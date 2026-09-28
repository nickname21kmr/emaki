import type { Exclusion } from '@emaki/shared';
import { RotateCcw } from 'lucide-react';
import { motion } from 'motion/react';
import { forwardRef } from 'react';
import { Button } from '@/components/ui';
import { formatCount, formatDateTime, formatRelative } from '@/lib/format';
import { KIND_META, ruleDetail, ruleTitle } from '../utils';
import { PhotoStack } from './PhotoStack';

/** 一条排除规则：预览照片堆（带类型徽章）· 标题 / 说明 · 影响张数 · 恢复 */
export const RuleRow = forwardRef<HTMLLIElement, { rule: Exclusion; busy: boolean; onRestore: () => void }>(
  function RuleRow({ rule, busy, onRestore }, ref) {
    const meta = KIND_META[rule.kind];
    const Icon = meta.icon;
    const detail = ruleDetail(rule);
    return (
      <motion.li
        ref={ref}
        layout="position"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: 24, transition: { duration: 0.22 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 40 }}
        className="group/rule flex items-center gap-5 rounded-[16px] bg-raised py-3.5 pr-4 pl-4 ring-1 ring-line transition-shadow duration-300 hover:shadow-card hover:ring-line-strong"
      >
        {/* 照片堆在最左（TR-9），规则类型成了它左下角的小徽章 */}
        <div className="relative hidden shrink-0 md:block">
          <PhotoStack ids={rule.previewImageIds} />
          <span className="absolute -bottom-1 -left-1 z-10 flex size-6 items-center justify-center rounded-full bg-raised text-fg-muted shadow-card ring-1 ring-line">
            <Icon className="size-3.5" strokeWidth={1.9} />
          </span>
        </div>
        <span className="flex size-11 shrink-0 items-center justify-center rounded-[12px] bg-sunken text-fg-muted md:hidden">
          <Icon className="size-[18px]" strokeWidth={1.75} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-tight">{ruleTitle(rule)}</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-fg-subtle">
            <span className="shrink-0">{meta.label}</span>
            {detail && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate font-mono text-[11.5px]" title={detail}>
                  {detail}
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            <span className="shrink-0" title={formatDateTime(rule.createdAt)}>
              {formatRelative(rule.createdAt)}添加
            </span>
          </div>
        </div>

        <div className="min-w-20 shrink-0 text-right">
          <span className="numeral text-[34px] text-fg tabular">{formatCount(rule.imageCount)}</span>
          <span className="ml-1 text-[12px] text-fg-muted">张</span>
        </div>

        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCcw className="size-3.5" />}
          loading={busy}
          onClick={onRestore}
          aria-label={`恢复：${ruleTitle(rule)}`}
          className="opacity-70 transition-opacity group-hover/rule:opacity-100"
        >
          恢复
        </Button>
      </motion.li>
    );
  },
);
