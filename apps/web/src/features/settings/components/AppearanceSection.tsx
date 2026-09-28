import type { Settings } from '@emaki/shared';
import { Grid3x3, LayoutGrid } from 'lucide-react';
import { Field, Kbd, Segmented, Switch } from '@/components/ui';
import type { BlurLevel } from '@/lib/blur';
import { cn } from '@/lib/cn';
import { usePrefs } from '@/lib/stores';
import { useSaveSettings } from '../hooks';
import { PalettePicker } from './PalettePicker';
import { ThemePicker } from './ThemePicker';
import { BlockRow, SettingsCard, SettingsSection } from './SettingsSection';

type Density = Settings['ui']['density'];

// 密度落到图库的目标行高上（usePrefs.gridRowHeight），图库里的滑块还能再细调
const ROW_HEIGHT: Record<Density, number> = { comfortable: 240, compact: 176 };

export function AppearanceSection({ ui }: { ui: Settings['ui'] }) {
  const save = useSaveSettings();
  const setBlur = usePrefs((s) => s.setBlurSensitive);
  const setRowHeight = usePrefs((s) => s.setGridRowHeight);
  const prefs = usePrefs();
  const off = !ui.blurSensitive;
  const dim = cn(off && 'opacity-60');

  return (
    <SettingsSection id="appearance" description="主题和图片的显示方式。">
      <SettingsCard>
        <BlockRow label="主题" hint="跟随系统时，会随 Windows 的浅色 / 深色模式自动切换。">
          <ThemePicker value={ui.theme} onChange={(theme) => save({ ui: { theme } })} />
        </BlockRow>

        <BlockRow label="底色" hint="纸面和卡片的颜色，浅色、深色各一套；只保存在这台电脑上。">
          <PalettePicker value={prefs.palette} onChange={prefs.setPalette} />
        </BlockRow>

        <Field
          label="默认模糊敏感图片"
          hint={
            <>
              按自动识别的分级处理：全年龄和「轻微」（泳装、露肩这一类）直接显示，「较敏感」「限制级」先模糊；还没识别完的图暂按全年龄显示。随时按{' '}
              <Kbd>B</Kbd> 临时切换。下面几项只保存在这台电脑上。
            </>
          }
        >
          <Switch
            checked={ui.blurSensitive}
            onCheckedChange={(blurSensitive) => {
              // 同步到本地偏好，顶栏的眼睛按钮立刻跟着变
              setBlur(blurSensitive);
              save({ ui: { blurSensitive } });
            }}
            label="默认模糊敏感图片"
          />
        </Field>

        <Field label="模糊范围" className={dim}>
          <Segmented<BlurLevel>
            size="sm"
            disabled={off}
            value={prefs.blurLevel}
            onChange={prefs.setBlurLevel}
            options={[
              { value: 'questionable', label: '较敏感和限制级' },
              { value: 'explicit', label: '仅限制级' },
            ]}
          />
        </Field>
        <Field
          label="照片也模糊"
          hint="自动归为「照片」的相机实拍（可能有证件、真人）。个别证件图可能被分进「文字」或「截图」。"
          className={dim}
        >
          <Switch checked={prefs.blurPhoto} disabled={off} onCheckedChange={prefs.setBlurPhoto} label="照片也模糊" />
        </Field>
        <Field label="文字图也模糊" hint="文档、笔记、聊天记录这类以文字为主的图。" className={dim}>
          <Switch checked={prefs.blurText} disabled={off} onCheckedChange={prefs.setBlurText} label="文字图也模糊" />
        </Field>
        <Field
          label="悬停时显示"
          hint="鼠标在模糊的图上停约 0.35 秒会显示清晰图，移开立刻恢复；看图器里仍需点「显示」。默认关，免得旁人看到。"
          className={dim}
        >
          <Switch checked={prefs.revealOnHover} disabled={off} onCheckedChange={prefs.setRevealOnHover} label="悬停时显示" />
        </Field>

        <Field label="网格密度" hint="缩略图的大小。图库里的行高滑块可以再细调。">
          <Segmented<Density>
            value={ui.density}
            onChange={(density) => {
              setRowHeight(ROW_HEIGHT[density]);
              save({ ui: { density } });
            }}
            options={[
              { value: 'comfortable', label: '舒展', icon: <LayoutGrid /> },
              { value: 'compact', label: '紧凑', icon: <Grid3x3 /> },
            ]}
          />
        </Field>
      </SettingsCard>
    </SettingsSection>
  );
}
