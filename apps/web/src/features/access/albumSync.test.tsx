import { SCOPES, type AlbumSyncInfo, type DeviceAlbum, type Me, type Scope } from '@emaki/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { qk } from '@/lib/queries';
import { albumCountsText, AlbumSyncPanel, syncStatusText } from './AlbumSync';

const g = globalThis as { EmakiApp?: unknown };
afterEach(() => {
  delete g.EmakiApp;
});

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const album = (over: Partial<DeviceAlbum> = {}): DeviceAlbum => ({
  path: 'Download',
  name: 'Download',
  count: 8725,
  bytes: 13499 * 1048576,
  latestAt: null,
  gone: false,
  inventory: {
    total: 8725,
    have: 8571,
    inTarget: 8556,
    deleted: 2,
    new: 152,
    newBytes: 194 * 1048576,
    folder: '下载',
    folderCount: 8556,
    at: ago(5),
  },
  sync: false,
  dir: '下载',
  dirReason: 'history',
  dirFixed: false,
  dirNote: '以前的 8556 张都在这里',
  suggested: true,
  pending: null,
  syncedAt: null,
  ...over,
});

const info = (over: Partial<AlbumSyncInfo> = {}): AlbumSyncInfo => ({
  deviceId: 'pad',
  deviceName: '小米平板',
  target: { deviceId: 'pad', rootId: '2', rootPath: 'B:/Users/zc/Pictures', dir: '下载图片/平板导入', isDefault: false },
  wifiOnly: true,
  chargingOnly: false,
  state: { running: null, done: null, total: null, error: null, summary: null, reportedAt: null, inventoriedAt: null, syncedAt: null },
  albums: [],
  ...over,
});

function html(data: AlbumSyncInfo, deviceId?: string) {
  const client = new QueryClient();
  const me: Me = deviceId
    ? { kind: 'local', scopes: Object.keys(SCOPES) as Scope[] }
    : { kind: 'device', deviceId: 'pad', name: '小米平板', scopes: ['read', 'upload'] };
  client.setQueryData(qk.me, me);
  client.setQueryData(qk.albumSync(deviceId), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AlbumSyncPanel deviceId={deviceId} />
    </QueryClientProvider>,
  );
}

describe('同步相册的说法（docs/mobile.md 5.5）', () => {
  it('状态：盘点、同步的进度；没盘点过；盘点过没同步；同步着的', () => {
    const s = info().state;
    expect(syncStatusText(info({ state: { ...s, running: 'inventory', done: 3000, total: 12363 } }), NOW)).toBe(
      '正在盘点相册：3,000 / 12,363',
    );
    expect(syncStatusText(info({ state: { ...s, running: 'sync' } }), NOW)).toBe('正在同步…');
    expect(syncStatusText(info(), NOW)).toBe('还没盘点过');
    expect(syncStatusText(info({ state: { ...s, inventoriedAt: ago(5) }, albums: [album()] }), NOW)).toBe(
      '5分钟前盘点过，还没有同步的相册',
    );
    expect(syncStatusText(info({ state: { ...s, syncedAt: ago(3), summary: '同步了 12 张' }, albums: [album({ sync: true })] }), NOW)).toBe(
      '同步 1 个相册 · 上次 3分钟前 · 同步了 12 张',
    );
  });

  it('相册的张数：盘点结果；都在电脑上；一张都没有；没盘点过；同步过的写还有几张没传', () => {
    expect(albumCountsText(album())).toBe('8,725 张 · 13.2 GB · 电脑上已有 8,571 张 · 没有的 152 张（194 MB） · 删过的 2 张不再传');
    const inv = album().inventory!;
    expect(albumCountsText(album({ count: 3, bytes: 300, inventory: { ...inv, have: 3, new: 0, deleted: 0 } }))).toBe(
      '3 张 · 300 B · 都在电脑上',
    );
    expect(albumCountsText(album({ count: 2, bytes: 300, inventory: { ...inv, have: 0, new: 2, deleted: 0 } }))).toBe(
      '2 张 · 300 B · 电脑上一张都没有',
    );
    expect(albumCountsText(album({ count: 1, bytes: 1, inventory: null }))).toBe('1 张 · 1 B · 没盘点过');
    expect(albumCountsText(album({ count: 1, bytes: 1, sync: true, syncedAt: ago(1), pending: 0 }))).toBe('1 张 · 1 B · 都传上来了');
  });
});

describe('同步相册面板', () => {
  it('电脑上：建议的相册和「按建议同步」、放到哪和为什么；其余的收起来；没有盘点、同步按钮', () => {
    const out = html(
      info({
        state: { ...info().state, inventoriedAt: ago(5) },
        albums: [
          album(),
          album({ path: 'DCIM/Screenshots', name: 'Screenshots', suggested: false, dir: 'Screenshots', dirReason: 'name' }),
        ],
      }),
      'pad',
    );
    expect(out).toContain('按建议同步');
    expect(out).toContain('建议同步');
    expect(out).toContain('以前的 8556 张都在这里');
    expect(out).toContain('其他相册');
    expect(out).not.toContain('DCIM/Screenshots');
    expect(out).not.toContain('盘点相册');
    expect(out).toContain('B:\\Users\\zc\\Pictures\\下载图片\\平板导入');
  });

  it('电脑上还没盘点过：告诉用户去平板上点；App 里有「盘点相册」', () => {
    expect(html(info(), 'pad')).toContain('在「小米平板」上打开 Emaki');
    g.EmakiApp = { unpaired: () => {}, pickImages: () => {}, syncAlbums: () => {} };
    const inApp = html(info());
    expect(inApp).toContain('盘点相册');
    expect(inApp).toContain('只问，不上传');
  });

  it('同步着了：不再出「按建议同步」；App 里有「现在同步」', () => {
    g.EmakiApp = { unpaired: () => {}, pickImages: () => {}, syncAlbums: () => {} };
    const out = html(info({ albums: [album({ sync: true, dirFixed: true }), album({ path: 'Pictures/bili', name: 'bili' })] }));
    expect(out).not.toContain('按建议同步');
    expect(out).toContain('现在同步');
    expect(out).toContain('盘点相册');
  });
});
