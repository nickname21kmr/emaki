import type { PluginManifest } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { contributionLines, grantAsPermissions, permissionLines, riskLine, wontLine } from './grantText';

const sample: PluginManifest = {
  id: 'example.random-browse',
  name: '随便看看',
  version: '0.1.0',
  contributes: {
    'nav.item@1': [{ id: 'random', label: '随便看看', to: '/gallery?sort=random', icon: 'compass', section: 'main' }],
    'override@1': { 'images.defaultSort': 'modifiedAt' },
  },
};

describe('授权单上的话（宿主按清单生成）', () => {
  it('只有配置的插件：列出贡献的东西；它不会读写图库、动文件、改设置、联网', () => {
    expect(contributionLines(sample).map((l) => l.text)).toEqual(['在侧栏加「随便看看」', '把「图片的默认排序」改成「修改时间」']);
    expect(permissionLines({})).toEqual([]);
    expect(riskLine({})).toBeNull();
    expect(wontLine({})).toBe('它不会：读或改你的图库、移动或删除你的图、改设置、联网');
  });

  it('要了权限：一项一句；会动文件的标出来；能读图又联网，直接写出后果', () => {
    const perms = {
      scopes: ['read', 'import', 'organize-files'] as const,
      folders: [{ id: 'dl', purpose: '下载的图放在这里' }],
      network: ['www.pixiv.net', 'i.pximg.net'],
      background: true,
    };
    const lines = permissionLines({ ...perms, scopes: [...perms.scopes] });
    expect(lines.map((l) => [l.text, !!l.danger])).toEqual([
      ['读图库', false],
      ['把下载好的文件加进图库，或替换成高清版', false],
      ['移动、移到回收站、处理重复', true],
      ['把文件放进', false],
      ['连接 www.pixiv.net、i.pximg.net', false],
      ['在后台运行', false],
    ]);
    expect(lines.find((l) => l.folder)!.folder).toEqual({ id: 'dl', purpose: '下载的图放在这里' });
    expect(riskLine({ scopes: ['read'], network: ['a.com'] })).toBe('可能把你的图发到 a.com');
    expect(wontLine({ scopes: ['read', 'organize-files', 'settings'], network: ['a.com'] })).toBeNull();
  });

  it('详情里的「授权」：给了的授权用同一套话', () => {
    const g = { scopes: ['read' as const], folders: [{ id: 'dl', rootId: 1, dir: 'x' }], network: [], background: false, unsafe: false };
    expect(permissionLines(grantAsPermissions(g, { folders: [{ id: 'dl', purpose: '放图' }] })).map((l) => l.detail)).toEqual(['列表、详情、计数', '放图']);
  });
});
