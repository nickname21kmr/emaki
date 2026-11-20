/**
 * 「从手机添加」：只在安卓 App 里、而且这台设备有上传权限时显示。
 * - 选图片（B1，docs/mobile.md 5.4，App 0.2.0 起）：App 打开系统的选图界面，选完在后台传给电脑，通知栏显示进度；
 * - 同步相册（B2，5.5，App 0.3.0 起）：有它时按钮变成菜单，多一项「同步相册」，打开这台设备自己的同步相册。
 * 传上来的图入库后图库自己会刷新（SSE）。浏览器里（没有 App）暂时不显示。
 */
import { FolderSync, ImagePlus } from 'lucide-react';
import { useState } from 'react';
import { Button, Menu, MenuItem } from '@/components/ui';
import { AlbumSyncDialog } from '@/features/access/AlbumSync';
import { useCan } from '@/lib/capabilities';
import { appBridge } from '@/lib/deviceAuth';

export function AddFromPhoneButton() {
  const can = useCan('upload');
  const bridge = appBridge();
  const [syncOpen, setSyncOpen] = useState(false);
  if (!can || typeof bridge?.pickImages !== 'function') return null;
  const button = (onClick?: () => void) => (
    <Button variant="outline" size="md" icon={<ImagePlus />} className="rounded-full compact:px-2.5" onClick={onClick}>
      <span className="compact:sr-only">从手机添加</span>
    </Button>
  );
  if (typeof bridge.syncAlbums !== 'function') return button(() => bridge.pickImages?.());
  return (
    <>
      <Menu trigger={button()} width={200} onCloseAutoFocus={(e) => e.preventDefault()}>
        <MenuItem icon={<ImagePlus />} onSelect={() => bridge.pickImages?.()}>
          选图片传到电脑
        </MenuItem>
        <MenuItem icon={<FolderSync />} onSelect={() => setSyncOpen(true)}>
          同步相册
        </MenuItem>
      </Menu>
      <AlbumSyncDialog open={syncOpen} onOpenChange={setSyncOpen} />
    </>
  );
}
