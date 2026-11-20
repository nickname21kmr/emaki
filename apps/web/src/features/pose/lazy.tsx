import { Component, lazy, Suspense, type ReactNode } from 'react';
import { SettingsCard, SettingsSection } from '@/features/settings/components/SettingsSection';
import { usePoseEnabled } from './client';
import type { PoseEntryProps } from './ui';

/**
 * 主包里的薄壳：姿势检索的界面在单独的包里，设置里打开后才下载（设置那一节例外：开关得一直在）。
 * 下载失败（断网、部署后旧 chunk 没了）先再试一次。
 */
const loadUi = () => import('./ui');
const retry = <T,>(load: () => Promise<T>) => () => load().catch(load);
const Entry = lazy(retry(() => loadUi().then((m) => ({ default: m.PoseEntry }))));
const InfoRow = lazy(retry(() => loadUi().then((m) => ({ default: m.PoseInfoRow }))));
const Settings = lazy(retry(() => import('./PoseSettingsSection').then((m) => ({ default: m.PoseSettingsSection }))));

/** 这一包没加载出来或渲染出错：只丢掉姿势的部分 */
class PoseBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

const wrap = (node: ReactNode, fallback: ReactNode = null) => (
  <PoseBoundary>
    <Suspense fallback={fallback}>{node}</Suspense>
  </PoseBoundary>
);

/** 图库工具条里的「按姿势」 */
export function PoseEntryLazy(props: PoseEntryProps) {
  return usePoseEnabled() ? wrap(<Entry {...props} />) : null;
}

/** 看图器信息里的「姿势」一行 */
export function PoseInfoRowLazy({ imageId, onNavigate }: { imageId: string; onNavigate: () => void }) {
  return usePoseEnabled() ? wrap(<InfoRow imageId={imageId} onNavigate={onNavigate} />) : null;
}

/** 设置 → 姿势检索 · 实验；加载时先占一张空卡片，目录跳转找得到这一节 */
export function PoseSettingsSectionLazy() {
  return wrap(
    <Settings />,
    <SettingsSection id="pose">
      <SettingsCard>
        <div className="h-[60px]" />
      </SettingsCard>
    </SettingsSection>,
  );
}
