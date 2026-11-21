import { Component, lazy, Suspense, type ReactNode } from 'react';
import { SettingsCard, SettingsSection } from '@/features/settings/components/SettingsSection';
import { usePoseClassesShown, usePoseEnabled } from './client';
import type { PoseWearEntryProps } from './posewear';
import type { PoseEntryProps } from './ui';

/**
 * 主包里的薄壳：姿势检索的界面在单独的包里，设置里打开后才下载（设置那一节例外：开关得一直在）。
 * 下载失败（断网、部署后旧 chunk 没了）先再试一次。
 */
const loadUi = () => import('./ui');
const retry = <T,>(load: () => Promise<T>) => () => load().catch(load);
const Entry = lazy(retry(() => loadUi().then((m) => ({ default: m.PoseEntry }))));
const InfoRow = lazy(retry(() => loadUi().then((m) => ({ default: m.PoseInfoRow }))));
const loadWear = () => import('./posewear');
const WearEntry = lazy(retry(() => loadWear().then((m) => ({ default: m.PoseWearEntry }))));
const WearRow = lazy(retry(() => loadWear().then((m) => ({ default: m.PoseWearInfoRow }))));
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

/** 图库工具条里的「按姿势」（PoseWear 姿势库） */
export function PoseWearEntryLazy(props: PoseWearEntryProps) {
  return usePoseEnabled() ? wrap(<WearEntry {...props} />) : null;
}

/** 51 类的「按人偶挑」：设置里另开（默认藏起来） */
export function PoseEntryLazy(props: PoseEntryProps) {
  return usePoseClassesShown() ? wrap(<Entry {...props} />) : null;
}

/** 看图器信息里的「姿势」一行（PoseWear）；开着 51 类时下面再有一行「姿势类」 */
export function PoseInfoRowLazy({ imageId, onNavigate }: { imageId: string; onNavigate: () => void }) {
  const on = usePoseEnabled();
  const classes = usePoseClassesShown();
  if (!on) return null;
  return (
    <>
      {wrap(<WearRow imageId={imageId} onNavigate={onNavigate} />)}
      {classes && wrap(<InfoRow imageId={imageId} onNavigate={onNavigate} />)}
    </>
  );
}

/**
 * 按姿势找图时，低置信那张格子左下角的小签「低」：标签弱、主要靠骨架匹配上的。
 * 和动图标记同一种半透明底，但更淡、更小，只是提个醒。
 */
export function PoseLowMark() {
  return (
    <span
      title="低置信：标签对不太上，主要靠骨架匹配到这个姿势"
      className="flex h-4 items-center rounded-full bg-black/30 px-[5px] text-[10px] leading-none font-medium text-white/80"
    >
      低
    </span>
  );
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
