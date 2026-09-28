import type { Settings } from '@emaki/shared';
import { Cpu, ScanFace, Zap } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Segmented, Switch } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useSaveSettings } from '../hooks';
import { CommitSlider } from './CommitSlider';
import { JobAction } from './JobAction';
import { ModelPicker } from './ModelPicker';
import { SettingsCard, SettingsSection } from './SettingsSection';
import { ThresholdMap } from './ThresholdMap';

const f2 = (v: number) => v.toFixed(2);

// 批大小给常用的 2 的幂；当前值不在其中（手改过配置）时也放进去，免得没有选中项
const BATCH_PRESETS = [1, 2, 4, 8, 16, 32];

// 默认方案：主模型 PixAI，旧图用 WD EVA02，WD 没认出的旧图不重跑（和后端 DEFAULT_SETTINGS 一致）
const DEFAULT_MODEL = 'A1yCE/pixai-tagger-v1.0-onnx-fp16';
const LEGACY_MODEL = 'SmilingWolf/wd-eva02-large-tagger-v3';

export function TaggerSection({
  tagger,
  unrecognizedCount,
}: {
  tagger: Settings['tagger'];
  unrecognizedCount?: number;
}) {
  const save = useSaveSettings();
  // 两个角色阈值拖动中的实时值，让下面的分段条跟着动
  const [live, setLive] = useState<{ character: number | null; auto: number | null }>({
    character: null,
    auto: null,
  });
  const character = live.character ?? tagger.characterThreshold;
  const auto = live.auto ?? tagger.autoAcceptThreshold;

  const legacyAvailable = tagger.model !== LEGACY_MODEL;
  const legacyOn = legacyAvailable && tagger.legacyModel !== null && tagger.legacyBefore !== null;
  const before = tagger.legacyBefore ?? '2024-03-01';
  const isDefaultPlan = tagger.model === DEFAULT_MODEL && tagger.legacyModel === LEGACY_MODEL && !tagger.retryOld;

  const batches = [...new Set([...BATCH_PRESETS, tagger.batchSize])].sort((a, b) => a - b);

  return (
    <SettingsSection id="tagger" description="用本机的 tagger 模型给图片打标签、认出角色。分数越高越确定。">
      <SettingsCard>
        <Field
          label="识别模型"
          hint={
            <>
              在这台电脑上本地运行，图片不会上传。
              {!isDefaultPlan && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-1 h-auto px-1 py-0 text-[12.5px] text-shu-fg"
                  onClick={() => save({ tagger: { model: DEFAULT_MODEL, legacyModel: LEGACY_MODEL, retryOld: false } })}
                >
                  恢复默认方案
                </Button>
              )}
            </>
          }
        >
          <ModelPicker value={tagger.model} onChange={(model) => save({ tagger: { model } })} />
        </Field>

        <Field
          label="旧图用 WD EVA02 识别"
          hint={
            legacyAvailable
              ? `文件时间早于 ${before} 的图先用 WD EVA02 认，它对老图更稳，也更快。关掉就全部用上面的主模型。`
              : '主模型已经是 WD EVA02，不需要再分新旧。'
          }
        >
          <Switch
            checked={legacyOn}
            disabled={!legacyAvailable}
            onCheckedChange={(v) => save({ tagger: { legacyModel: v ? LEGACY_MODEL : null } })}
            label="旧图用 WD EVA02 识别"
          />
        </Field>

        <Field
          label="WD 没认出的旧图，用主模型再认一遍"
          hint="WD 认不出的老图（比如新角色的同人图）再交给主模型试一次。会多花一些时间。"
        >
          <Switch
            checked={tagger.retryOld}
            disabled={!legacyOn}
            onCheckedChange={(v) => save({ tagger: { retryOld: v } })}
            label="WD 没认出的旧图，用主模型再认一遍"
          />
        </Field>

        <Field label="运行设备" hint="有显卡就选 GPU，NVIDIA、AMD、Intel 都可以：PixAI 走 WebGPU，WD 走 DirectML。显卡用不了时会自动改用 CPU。">
          <Segmented
            value={tagger.device}
            onChange={(device) => save({ tagger: { device } })}
            options={[
              { value: 'cpu', label: 'CPU', icon: <Cpu /> },
              { value: 'dml', label: 'GPU', icon: <Zap /> },
            ]}
          />
        </Field>

        <Field label="角色阈值" hint="角色标签的分数高于它，才算认出了这个角色。">
          <CommitSlider
            label="角色阈值"
            value={tagger.characterThreshold}
            min={0}
            max={1}
            step={0.01}
            format={f2}
            onDraftChange={(v) => setLive((s) => ({ ...s, character: v }))}
            onCommit={(v) => save({ tagger: { characterThreshold: v } })}
          />
        </Field>

        <Field label="自动采纳阈值" hint="达到它直接归到角色；介于两者之间的交给你在「未识别」里确认。调低后，已有建议里达标的会在保存时立即归入。">
          <CommitSlider
            label="自动采纳阈值"
            value={tagger.autoAcceptThreshold}
            min={0}
            max={1}
            step={0.01}
            format={f2}
            onDraftChange={(v) => setLive((s) => ({ ...s, auto: v }))}
            onCommit={(v) => save({ tagger: { autoAcceptThreshold: v } })}
          />
        </Field>

        <div className="py-5">
          <ThresholdMap character={character} auto={auto} />
        </div>

        <Field label="通用标签阈值" hint="发色、服装、构图这类普通标签，低于它的不保存。">
          <CommitSlider
            label="通用标签阈值"
            value={tagger.generalThreshold}
            min={0}
            max={1}
            step={0.01}
            format={f2}
            onCommit={(v) => save({ tagger: { generalThreshold: v } })}
          />
        </Field>

        <Field label="批大小" hint="一次送进模型的图片张数。显存不够、识别报错时调小。">
          <Segmented
            size="sm"
            value={String(tagger.batchSize)}
            onChange={(v) => save({ tagger: { batchSize: Number(v) } })}
            options={batches.map((n) => ({ value: String(n), label: <span className="tabular">{n}</span> }))}
          />
        </Field>

        <Field label="运行时防止电脑休眠" hint="扫描、识别等后台任务在跑时不让电脑进入睡眠，全部结束 1 分钟后恢复；屏幕照常可以关。整夜识别时建议打开。">
          <Switch
            checked={tagger.keepAwake}
            onCheckedChange={(v) => save({ tagger: { keepAwake: v } })}
            label="运行时防止电脑休眠"
          />
        </Field>

        <Field
          label="对全部未识别图片运行识别"
          hint={
            unrecognizedCount === undefined
              ? '识别在后台进行，可以继续做别的事。'
              : unrecognizedCount > 0
                ? `还有 ${formatCount(unrecognizedCount)} 张没有归到角色。识别在后台进行，可以继续做别的事。`
                : '目前没有未识别的图片。'
          }
        >
          <JobAction kind="tag" icon={<ScanFace />} disabled={unrecognizedCount === 0}>
            运行识别
          </JobAction>
        </Field>
      </SettingsCard>
    </SettingsSection>
  );
}
