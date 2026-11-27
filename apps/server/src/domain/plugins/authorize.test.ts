import { EMPTY_GRANT, type Grant } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { authorize, declinedOf, grantedFolder, grantedScopes, requireGrant, withDeclined } from './authorize.ts';

const grant: Grant = {
  scopes: ['read', 'import'],
  folders: [{ id: 'dl', rootId: 1, dir: '下载' }],
  network: ['pixiv.net'],
  background: true,
  unsafe: false,
};

describe('插件的授权检查只有一处（docs/plugins.md 4.1）', () => {
  it('权限范围、联网（子域名也算）、文件夹、后台：有返回 null，没有写原因', () => {
    expect(authorize(grant, { scope: 'read' })).toBeNull();
    expect(authorize(grant, { scope: 'settings' })).toMatch(/没有授权「/);
    expect(authorize(grant, { network: 'www.pixiv.net' })).toBeNull();
    expect(authorize(grant, { network: 'WWW.PIXIV.NET' })).toBeNull();
    expect(authorize(grant, { network: 'evil.example' })).toMatch(/没有授权连接 evil\.example/);
    expect(authorize(grant, { network: 'pixiv.net.evil.example' })).not.toBeNull();
    expect(authorize(grant, { folder: 'dl' })).toBeNull();
    expect(authorize(grant, { folder: 'other' })).toMatch(/没有文件夹「other」/);
    expect(authorize(grant, {})).toBeNull();
    expect(authorize(EMPTY_GRANT, {})).toMatch(/没有给放文件的文件夹/);
    expect(authorize(grant, { background: true })).toBeNull();
    expect(authorize(EMPTY_GRANT, { background: true })).toMatch(/后台/);
    expect(() => requireGrant(EMPTY_GRANT, { scope: 'read' })).toThrow(/没有授权「读图库」/);
    expect(grantedFolder(grant)).toEqual(grant.folders[0]);
    expect(() => grantedFolder(grant, 'x')).toThrow(/x/);
    expect([...grantedScopes(grant, ['read', 'curate', 'import'])]).toEqual(['read', 'import']);
  });

  it('你关掉的：清单要了、授权里没有的；更新时和现在的授权合起来算「不是新要的」', () => {
    const requested = { scopes: ['read', 'import', 'jobs'] as const, network: ['pixiv.net', 'i.pximg.net'], background: true, folders: [{ id: 'dl', purpose: '' }, { id: 'tmp', purpose: '' }] };
    const d = declinedOf({ ...requested, scopes: [...requested.scopes] }, grant);
    expect(d).toEqual({ scopes: ['jobs'], network: ['i.pximg.net'], folders: [{ id: 'tmp', purpose: '' }] });
    expect(declinedOf(undefined, grant)).toEqual({});
    const all = withDeclined(grant, d);
    expect(all.scopes).toEqual(['read', 'import', 'jobs']);
    expect(all.network).toEqual(['pixiv.net', 'i.pximg.net']);
    expect(all.folders.map((f) => f.id)).toEqual(['dl', 'tmp']);
  });
});
