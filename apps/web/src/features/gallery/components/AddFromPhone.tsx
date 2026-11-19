/**
 * 「从手机添加」（B1，docs/mobile.md 5.4）：只在安卓 App 里（window.EmakiApp.pickImages，App 0.2.0 起）、而且这台设备有上传权限时显示。
 * 点了 App 打开系统的选图界面，选完在后台传给电脑，通知栏显示进度；传上来的图入库后图库自己会刷新（SSE）。
 * 浏览器里（没有 App）暂时不显示。
 */
import { ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui';
import { useCan } from '@/lib/capabilities';
import { appBridge } from '@/lib/deviceAuth';

export function AddFromPhoneButton() {
  const can = useCan('upload');
  const bridge = appBridge();
  if (!can || typeof bridge?.pickImages !== 'function') return null;
  return (
    <Button variant="outline" size="md" icon={<ImagePlus />} className="rounded-full compact:px-2.5" onClick={() => bridge.pickImages?.()}>
      <span className="compact:sr-only">从手机添加</span>
    </Button>
  );
}
