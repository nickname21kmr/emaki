import type { Settings } from '@emaki/shared';
import { ArrowUpRight, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Field } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useSaveSettings } from '../hooks';
import { CommitSlider } from './CommitSlider';
import { JobAction } from './JobAction';
import { SettingsCard, SettingsSection } from './SettingsSection';

/** 汉明距离翻译成人话：数字本身对用户没有意义 */
function describe(h: number): string {
  if (h === 0) return '搜索范围最小，部分缩放、压缩副本可能遗漏';
  if (h <= 4) return '优先搜索构图非常接近的图片';
  if (h <= 10) return '适合查找常见的缩放、压缩副本';
  return '扩大候选范围，核对耗时也会增加';
}

export function DedupeSection({
  dedupe,
  groupCount,
}: {
  dedupe: Settings['dedupe'];
  groupCount?: number;
}) {
  const save = useSaveSettings();
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? Math.min(16, dedupe.hammingThreshold);

  return (
    <SettingsSection id="dedupe" description="查找相同图片和缩放、压缩副本，并核对原图的整体与局部差异。">
      <SettingsCard>
        <Field
          label="候选搜索范围"
          hint={
            <>
              范围越大，参与原图核对的候选越多。
              <span className="mt-0.5 block text-fg">{describe(shown)}</span>
            </>
          }
        >
          <CommitSlider
            label="候选搜索范围"
            value={Math.min(16, dedupe.hammingThreshold)}
            min={0}
            max={16}
            step={1}
            ends={['严格', '宽松']}
            onDraftChange={setDraft}
            onCommit={(h) => save({ dedupe: { hammingThreshold: h } })}
          />
        </Field>

        <Field
          label="重新查找"
          hint={
            groupCount ? (
              <>
                改了阈值后，重新查找才会生效。当前有{' '}
                <Link
                  to="/duplicates"
                  className="inline-flex items-center gap-0.5 font-medium text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-shu"
                >
                  {formatCount(groupCount)} 组待处理
                  <ArrowUpRight className="size-3" />
                </Link>
              </>
            ) : (
              '改了阈值后，重新查找才会生效。'
            )
          }
        >
          <JobAction kind="dedupe" icon={<ScanSearch />}>
            重新查找
          </JobAction>
        </Field>
      </SettingsCard>
    </SettingsSection>
  );
}
