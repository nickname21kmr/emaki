/**
 * 「传到电脑」（docs/mobile.md 5.4、5.5）：只在安卓 App 里、而且这台设备有上传权限时显示，是图库页头的一个图标，
 * 和右边的模糊、撤销、帮助一样不抢眼（以前是两个描边按钮，比页头别的东西亮）。
 * - App 0.3.0 起：点开「传到电脑」面板：上面「选图片上传」（系统的选图界面，选完在后台传，通知栏显示进度），
 *   下面「同步相册」（AlbumSyncPanel：哪些相册在同步、放到电脑上的哪里）；
 * - App 0.2.0（只有 pickImages）：直接打开系统的选图界面。
 * 不做悬浮按钮：图库主要是看图，打开同步相册以后手动传图很少用，悬浮按钮会一直挡着图和底部的多选栏。
 * 传上来的图入库后图库自己会刷新（SSE）。浏览器里（没有 App）不显示。
 */
import { ImagePlus, MonitorUp } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, IconButton } from '@/components/ui';
import { AlbumSyncPanel } from '@/features/access/AlbumSync';
import { useCan } from '@/lib/capabilities';
import { appBridge } from '@/lib/deviceAuth';

export function SendToComputerButton() {
  const can = useCan('upload');
  const bridge = appBridge();
  const [open, setOpen] = useState(false);
  if (!can || typeof bridge?.pickImages !== 'function') return null;
  const panel = typeof bridge.syncAlbums === 'function';
  const pick = () => {
    setOpen(false);
    bridge.pickImages?.();
  };
  return (
    <>
      <IconButton label="传到电脑" onClick={() => (panel ? setOpen(true) : pick())}>
        <MonitorUp />
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
