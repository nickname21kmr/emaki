import type { LibraryRoot } from '@emaki/shared';
import { FolderPlus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button, EmptyState } from '@/components/ui';
import { AddFolderDialog } from './AddFolderDialog';
import { JobAction } from './JobAction';
import { RootList } from './LibraryRootsEditor';
import { SettingsCard, SettingsSection } from './SettingsSection';

export function LibrarySection({ roots }: { roots: LibraryRoot[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <SettingsSection
      id="library"
      description="Emaki 会扫描这些文件夹里的图片并建立索引，不会移动、重命名或修改任何文件。"
      actions={
        roots.length > 0 && (
          <>
            <Button variant="ghost" icon={<FolderPlus />} onClick={() => setAdding(true)}>
              添加文件夹
            </Button>
            <JobAction kind="scan" variant="primary" icon={<RefreshCw />} disabled={!roots.some((r) => r.enabled)}>
              立即扫描
            </JobAction>
          </>
        )
      }
    >
      <SettingsCard>
        {roots.length === 0 ? (
          <EmptyState
            glyph="卷"
            title="还没有图库文件夹"
            description="添加一个存放插画的文件夹，Emaki 会扫描它、认出里面的角色。文件本身留在原处。"
            action={
              <Button variant="primary" icon={<FolderPlus />} onClick={() => setAdding(true)}>
                添加文件夹
              </Button>
            }
            className="py-12"
          />
        ) : (
          <RootList roots={roots} />
        )}
      </SettingsCard>
      <AddFolderDialog open={adding} onOpenChange={setAdding} roots={roots} />
    </SettingsSection>
  );
}
