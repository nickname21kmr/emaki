/**
 * 手机上传的一段字节（B1，docs/mobile.md 5.4）：PUT /api/uploads/:id?offset=N，请求体是 application/octet-stream，一段最多 8 MiB。
 * 请求体是二进制，不走注册表（注册表的输入是 JSON）；权限和注册表一样：局域网入口上要 upload 权限，执行者必须是一台设备。
 * 开始、传完、问有没有走注册表的 upload.begin / upload.complete / upload.check（commands/upload.ts）。
 */
import { UPLOAD_CHUNK_MAX } from '@emaki/shared/schemas';
import type { FastifyInstance } from 'fastify';
import type { SqliteDataSource } from '../datasource/sqlite/SqliteDataSource.ts';
import { receiveChunk } from '../domain/upload/upload.ts';
import { currentActor, currentCall, deviceIdOf } from '../propagation/actor.ts';
import { BadRequestError, HttpError } from './errors.ts';

export function uploadRoutes(app: FastifyInstance, engine: SqliteDataSource): void {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_CHUNK_MAX }, (_req, body, done) =>
    done(null, body),
  );

  // 不带类型参数：冒烟测试按源码里的写法认手写的路由（见 test/http.smoke.test.ts 的路由清单）
  app.put('/api/uploads/:id', { bodyLimit: UPLOAD_CHUNK_MAX }, async (raw): Promise<{ received: number }> => {
    const req = raw as typeof raw & { params: { id: string }; query: { offset?: string } };
    const grant = currentCall()?.grant;
    if (grant && !grant.has('upload')) throw new HttpError(403, 'forbidden', '这台设备没有「上传图片」的权限');
    const deviceId = deviceIdOf(currentActor());
    if (!deviceId) throw new BadRequestError('只有手机上的 App 能上传（通过手机访问的局域网入口）');
    const offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestError('offset 要是非负整数');
    if (!Buffer.isBuffer(req.body)) throw new BadRequestError('请求体要是 application/octet-stream');
    return receiveChunk(engine.ctx, deviceId, req.params.id, offset, req.body);
  });
}
