import type { ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { PageGate } from '@/features/access/PageGate';
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
import { PluginDetailPage } from '@/features/plugins/PluginDetailPage';
import { PluginsPage } from '@/features/plugins/PluginsPage';
import { WelcomePage } from '@/features/onboarding/WelcomePage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { UnrecognizedPage } from '@/features/unrecognized/UnrecognizedPage';
import { WorkDetailPage } from '@/features/works/WorkDetailPage';
import { PAGES, type PageId } from './pages';

/**
 * 路由表。新页面放在 src/features/<名字>/ 下，先在 src/pages.ts 登记（路径、需要的能力），再在这里用 page() 挂上：
 * 没权限的设备直接打开这个地址时，PageGate 显示说明页（docs/mobile.md 4.4）。
 * 页面的筛选状态尽量放在 URL 查询参数里（useSearchParams），这样刷新 / 前进后退都能保留。
 */
function page(id: PageId, element: ReactNode, nested = true): RouteObject {
  const path = PAGES[id].path;
  const gated = <PageGate page={id}>{element}</PageGate>;
  // AppShell 下面的用相对路径；首页是 index
  if (nested && path === '/') return { index: true, element: gated, handle: { page: id } };
  return { path: nested ? path.replace(/^\//, '') : path, element: gated, handle: { page: id } };
}

export const routes: RouteObject[] = [
  // 首次使用引导：没有任何图库文件夹时 AppShell 会跳过来
  page('welcome', <WelcomePage />, false),
  {
    element: <AppShell />,
    children: [
      page('home', <HomePage />),
      page('gallery', <GalleryPage />),
      page('characters', <CharactersPage />),
      page('character', <CharacterDetailPage />),
      page('work', <WorkDetailPage />),
      page('unrecognized', <UnrecognizedPage />),
      page('duplicates', <DuplicatesPage />),
      page('collections', <CollectionsPage />),
      page('collection', <CollectionDetailPage />),
      page('reader', <BookReader />),
      page('annex', <AnnexPage />),
      page('excluded', <ExcludedPage />),
      page('settings', <SettingsPage />),
      page('plugins', <PluginsPage />),
      page('plugin', <PluginDetailPage />),
      // 开发用：共用件并排展示（生产构建不注册）
      ...(import.meta.env.DEV ? [page('devUi', <DevUiPage />)] : []),
      page('fallback', <HomePage />),
    ],
  },
];
