/**
 * 准备安装一个 zip 插件包（docs/plugins.md E2）：PUT /api/plugins/packages?name=<文件名>，请求体是 application/zip，最大 20 MiB。
 * 用 PUT：本机和局域网入口都要求 POST 是 JSON（防跨站），跨站的 PUT 要预检、过不去（同手机上传）。
 * 请求体是二进制，不走注册表（注册表的输入是 JSON）；权限和注册表一样：设备要有 install-plugins。
 * 返回授权单要列的东西（PluginPackage）；确认以后调注册表的 plugins.install。文件夹、git 地址走 plugins.inspect。
 */
import type { PluginPackage } from '@emaki/shared';
import type { FastifyInstance } from 'fastify';
import type { SqliteDataSource } from '../datasource/sqlite/SqliteDataSource.ts';
import { safeName } from '../domain/upload/upload.ts';
import { currentCall } from '../propagation/actor.ts';
import { BadRequestError, HttpError } from './errors.ts';

export const PLUGIN_PACKAGE_MAX = 20 * 1024 * 1024;

export function pluginPackageRoutes(app: FastifyInstance, engine: SqliteDataSource): void {
  app.addContentTypeParser('application/zip', { parseAs: 'buffer', bodyLimit: PLUGIN_PACKAGE_MAX }, (_req, body, done) => done(null, body));

  // 不带类型参数：冒烟测试按源码里的写法认手写的路由（见 test/http.smoke.test.ts 的路由清单）
  app.put('/api/plugins/packages', { bodyLimit: PLUGIN_PACKAGE_MAX }, async (raw): Promise<PluginPackage> => {
    const req = raw as typeof raw & { query: { name?: string } };
    const grant = currentCall()?.grant;
    if (grant && !grant.has('install-plugins')) throw new HttpError(403, 'forbidden', '这台设备没有「装插件」的权限');
    if (!Buffer.isBuffer(req.body)) throw new BadRequestError('请求体要是 application/zip');
    return engine.plugins.inspectZip(safeName(req.query.name ?? '', 'plugin.zip'), req.body);
  });
}
