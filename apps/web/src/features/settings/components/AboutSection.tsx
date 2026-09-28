import { Emblem } from '@/components/ui/Emblem';
import type { LibraryStats } from '@emaki/shared';
import { Keyboard, ShieldCheck } from 'lucide-react';
import { Badge, Button, Field, Kbd } from '@/components/ui';
import { formatBytes, formatCount, formatDateTime, formatRelative } from '@/lib/format';
import { useHealth } from '@/lib/queries';
import { useOverlays } from '@/lib/stores';
import { SettingsCard, SettingsSection } from './SettingsSection';

export function AboutSection({ stats }: { stats?: LibraryStats }) {
  const setHelpOpen = useOverlays((s) => s.setHelpOpen);
  const health = useHealth().data;

  return (
    <SettingsSection id="about">
      <SettingsCard>
        <div className="flex items-center gap-5 py-6">
          <Seal />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2.5">
              <span className="text-lg font-semibold tracking-tight">Emaki</span>
              <span className="font-display text-xl text-fg-muted">絵巻</span>
              {health && <Badge className="self-center">v{health.version}</Badge>}
              {health?.dataSource === 'mock' && (
                <Badge tone="warn" className="self-center">
                  演示数据
                </Badge>
              )}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              本地的二次元插画收藏管理器：按角色和作品整理，自动识别，查找重复。
            </p>
          </div>
        </div>

        <Field
          label="数据目录"
          hint="数据库、缩略图缓存和模型文件都在这里。启动前设置环境变量 EMAKI_DATA_DIR 可以换到别的位置。"
        >
          <code className="rounded-md bg-sunken px-2.5 py-1.5 font-mono text-xs text-fg-muted">{health?.dataDir ?? '…'}</code>
        </Field>

        {stats && (
          <Field
            label="图库"
            hint={
              stats.lastScanAt ? (
                <span title={formatDateTime(stats.lastScanAt)}>最近一次扫描 {formatRelative(stats.lastScanAt)}</span>
              ) : (
                '还没有扫描过'
              )
            }
          >
            <span className="text-[13px] text-fg-muted tabular">
              {formatCount(stats.imageCount)} 张 · {formatCount(stats.characterCount)} 位角色 ·{' '}
              {formatBytes(stats.totalBytes)}
            </span>
          </Field>
        )}

        <Field label="快捷键" hint="大部分操作都可以用键盘完成，在任何页面按 ? 打开。">
          <Button size="sm" icon={<Keyboard />} trailing={<Kbd>?</Kbd>} onClick={() => setHelpOpen(true)}>
            查看快捷键
          </Button>
        </Field>
      </SettingsCard>

      <p className="mt-4 flex items-center gap-1.5 pl-1 text-xs text-fg-subtle">
        <ShieldCheck className="size-3.5" />
        Emaki 是本地应用，图片不会上传到任何地方。
      </p>
    </SettingsSection>
  );
}

/** 和侧边栏同一枚徽记，放大一号 */
function Seal() {
  return (
    <span className="group">
      <Emblem size={56} spin />
    </span>
  );
}
