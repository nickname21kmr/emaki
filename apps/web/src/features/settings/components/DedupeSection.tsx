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
  if (h === 0) return '只找几乎逐像素相同的图';
  if (h <= 4) return '找出同一张图的缩放、转码版本';
  if (h <= 10) return '还包括轻微裁剪、加水印、调色的版本';
  return '很宽松，构图相近的不同图也可能被算进来';
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
  const shown = draft ?? dedupe.hammingThreshold;

  return (
    <SettingsSection id="dedupe" description="用感知哈希比较图片，缩放、转码、轻微裁剪后的同一张图也能找出来。">
      <SettingsCard>
        <Field
          label="相似度阈值"
          hint={
            <>
              两张图哈希的汉明距离，越小越严格。
              <span className="mt-0.5 block text-fg">{describe(shown)}</span>
            </>
          }
        >
          <CommitSlider
            label="相似度阈值"
            value={dedupe.hammingThreshold}
            min={0}
            // 规格给 0–16；服务端允许到 64，已存了更大的值时放宽上限，免得被截断
            max={Math.max(16, dedupe.hammingThreshold)}
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
