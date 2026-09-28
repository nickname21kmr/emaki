import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { AnnexPage } from '@/features/annex/AnnexPage';
import { CollectionDetailPage } from '@/features/collections/CollectionDetailPage';
import { CollectionsPage } from '@/features/collections/CollectionsPage';
import { BookReader } from '@/features/collections/reader/BookReader';
import { CharacterDetailPage } from '@/features/characters/CharacterDetailPage';
import { CharactersPage } from '@/features/characters/CharactersPage';
import { DuplicatesPage } from '@/features/duplicates/DuplicatesPage';
import { ExcludedPage } from '@/features/excluded/ExcludedPage';
import { GalleryPage } from '@/features/gallery/GalleryPage';
import { DevUiPage } from '@/features/dev/DevUiPage';
import { HomePage } from '@/features/home/HomePage';
import { WelcomePage } from '@/features/onboarding/WelcomePage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { UnrecognizedPage } from '@/features/unrecognized/UnrecognizedPage';
import { WorkDetailPage } from '@/features/works/WorkDetailPage';

/**
 * 路由表。新页面放在 src/features/<名字>/ 下，在这里登记。
 * 页面的筛选状态尽量放在 URL 查询参数里（useSearchParams），这样刷新 / 前进后退都能保留。
 */
export const router = createBrowserRouter([
  // 首次使用引导：没有任何图库文件夹时 AppShell 会跳过来
  { path: 'welcome', element: <WelcomePage /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'gallery', element: <GalleryPage /> },
      { path: 'characters', element: <CharactersPage /> },
      { path: 'characters/:id', element: <CharacterDetailPage /> },
      { path: 'works/:id', element: <WorkDetailPage /> },
      { path: 'unrecognized', element: <UnrecognizedPage /> },
      { path: 'duplicates', element: <DuplicatesPage /> },
      { path: 'collections', element: <CollectionsPage /> },
      { path: 'collections/:id', element: <CollectionDetailPage /> },
      { path: 'collections/:id/read', element: <BookReader /> },
      { path: 'annex/:kind?', element: <AnnexPage /> },
      { path: 'excluded', element: <ExcludedPage /> },
      { path: 'settings', element: <SettingsPage /> },
      // 开发用：共用件并排展示（生产构建不注册）
      ...(import.meta.env.DEV ? [{ path: 'dev/ui', element: <DevUiPage /> }] : []),
      { path: '*', element: <HomePage /> },
    ],
  },
]);
