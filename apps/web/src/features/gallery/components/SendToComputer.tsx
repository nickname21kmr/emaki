/**
 * 「传到电脑」（docs/mobile.md 5.4、5.5）：只在安卓 App 里、而且这台设备有上传权限时显示，是图库页头的一个图标，
 * 和右边的模糊、撤销、帮助一样不抢眼（以前是两个描边按钮，比页头别的东西亮）。
 * - App 0.3.0 起：点开「传到电脑」面板：上面「选图片上传」（系统的选图界面，选完在后台传，通知栏显示进度），
 *   下面「同步相册」（AlbumSyncPanel：哪些相册在同步、放到电脑上的哪里）；
 * - App 0.2.0（只有 pickImages）：直接打开系统的选图界面。
 * 不做悬浮按钮：图库主要是看图，打开同步相册以后手动传图很少用，悬浮按钮会一直挡着图和底部的多选栏。
 *
 * 第一次用的引导（SendToComputerTip）：只在 App 里、还没有在同步的相册、也没关掉过时，图库里一条提示（和「只显示插画」那条一样），
 * 页头图标上一个小点；点「去看看」或者打开过面板、关掉提示，就都不再出现。不做多步的引导：会打断，大多被跳过。
 * 传上来的图入库后图库自己会刷新（SSE）。浏览器里（没有 App）不显示。
 */
import type { AlbumSyncInfo } from '@emaki/shared';
import { ArrowRight, ImagePlus, MonitorUp, X } from 'lucide-react';
import { create } from 'zustand';
import { Button, Dialog, IconButton } from '@/components/ui';
import { AlbumSyncPanel } from '@/features/access/AlbumSync';
import { useCan } from '@/lib/capabilities';
import { appBridge } from '@/lib/deviceAuth';
import { useAlbumSync } from '@/lib/queries';
import { usePrefs } from '@/lib/stores';

/** 面板开没开：页头的图标和图库里的提示都能打开它 */
const usePanel = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** 要不要引导：在 App 里（0.3.0 起）、有上传权限、没关掉过提示、还没有在同步的相册 */
export function showIntro(app: boolean, seen: boolean, info: Pick<AlbumSyncInfo, 'albums'> | undefined): boolean {
  return app && !seen && !!info && !info.albums.some((a) => a.sync);
}

function useIntro(): boolean {
  const can = useCan('upload');
  const bridge = appBridge();
  const seen = usePrefs((s) => s.sendTipSeen);
  const app = can && typeof bridge?.syncAlbums === 'function';
  const { data } = useAlbumSync(undefined, { enabled: app && !seen });
  return showIntro(app, seen, data);
}

/** 图库里第一次的提示：「传到电脑」在哪、能做什么 */
export function SendToComputerTip() {
  const intro = useIntro();
  const dismiss = usePrefs((s) => s.dismissSendTip);
  const setOpen = usePanel((s) => s.setOpen);
  if (!intro) return null;
  return (
    <div className="mt-3 flex animate-fade-in items-center gap-3 rounded-[10px] bg-sunken/70 px-3.5 py-2 text-[12.5px] text-fg-muted">
      <MonitorUp className="size-4 shrink-0 text-shu-fg" />
      <span className="flex-1">
        在这台设备上下载、保存的图可以自动传到电脑：点右上角的「传到电脑」，盘点一下相册，按建议打开同步，以后打开 App 就会同步。
      </span>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          dismiss();
        }}
        className="inline-flex shrink-0 items-center gap-1 font-medium text-fg touch-hit hover:underline"
      >
        去看看 <ArrowRight className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="知道了"
        className="shrink-0 rounded-full p-1 touch-hit hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function SendToComputerButton() {
  const can = useCan('upload');
  const bridge = appBridge();
  const open = usePanel((s) => s.open);
  const setPanel = usePanel((s) => s.setOpen);
  const dismiss = usePrefs((s) => s.dismissSendTip);
  const intro = useIntro();
  if (!can || typeof bridge?.pickImages !== 'function') return null;
  const panel = typeof bridge.syncAlbums === 'function';
  const setOpen = (v: boolean) => {
    setPanel(v);
    // 打开过面板就算知道了：提示条和小点都不再出现
    if (v) dismiss();
  };
  const pick = () => {
    setOpen(false);
    bridge.pickImages?.();
  };
  return (
    <>
      <IconButton label="传到电脑" className="relative" onClick={() => (panel ? setOpen(true) : pick())}>
        <MonitorUp />
        {intro && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-shu ring-2 ring-sheet" />}
      </IconButton>
      {panel && (
        <Dialog open={open} onOpenChange={setOpen} title="传到电脑" width={720}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl bg-sunken px-4 py-3.5">
            <div className="min-w-0 flex-1 basis-60">
              <div className="text-sm font-medium">选图片上传</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">在系统的选图界面挑几张，马上在后台传，进度在通知栏。</div>
            </div>
            <Button variant="primary" size="sm" icon={<ImagePlus />} onClick={pick}>
              选图片
            </Button>
          </div>
          <h3 className="mt-6 mb-3 text-[15px] font-semibold tracking-tight">同步相册</h3>
          {open && <AlbumSyncPanel />}
        </Dialog>
      )}
    </>
  );
}
