import type { LibraryRoot } from '@emaki/shared';
import { Button, Dialog, DialogFooter } from '@/components/ui';
import { AddFolderForm } from './LibraryRootsEditor';

export function AddFolderDialog({
  open,
  onOpenChange,
  roots,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roots: LibraryRoot[];
}) {
  const close = () => onOpenChange(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加图库文件夹"
      description="输入文件夹的完整路径，子文件夹也会一起扫描。添加后自动开始扫描，文件不会被移动或修改。"
      width={560}
    >
      {/* 表单在弹窗关闭时卸载，下次打开自动清空 */}
      <AddFolderForm
        roots={roots}
        autoFocus
        onDone={close}
        actions={({ disabled, loading }) => (
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              取消
            </Button>
            <Button type="submit" variant="primary" loading={loading} disabled={disabled}>
              添加并扫描
            </Button>
          </DialogFooter>
        )}
      />
    </Dialog>
  );
}
