/**
 * createFastify 的两处设置（两个入口共用）：
 * - JSON schema 的编译器用到时才加载：平时不加载，路由真带了 schema 照常校验、照常序列化；
 * - 请求日志只记慢的和出错的，长连接（被接管的响应）结束时不算慢请求。
 * 另外是静态托管用的两个小判断（缓存头、是不是构建产物）；托管本身在 test/staticWeb.test.ts。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOW_REQUEST_MS, createFastify, isAssetRequest, requestLogEntry, webCacheControl } from './app.ts';

const require = createRequire(import.meta.url);
/** 这个进程里加载过名字里带 name 的 CommonJS 模块没有 */
const loaded = (name: string) =>
  Object.keys(require.cache).some((file) => file.split(path.sep).join('/').includes(`/node_modules/${name}/`));

/** 日志收进数组（pino 一行一个 JSON） */
function capture(level = 'info') {
  const lines: { level: number; msg: string }[] = [];
  const logger = { level, stream: { write: (line: string) => void lines.push(JSON.parse(line) as { level: number; msg: string }) } };
  return { lines, logger };
}
const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;

describe('JSON schema 的编译器用到时才加载', () => {
  it('路由不带 schema：不加载，请求照常', async () => {
    const app = createFastify({ logger: false });
    app.get('/ping', () => ({ ok: true }));
    app.post('/echo', (req) => req.body);
    expect((await app.inject({ url: '/ping' })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'POST', url: '/echo', payload: { a: [1, 2] } })).json()).toEqual({ a: [1, 2] });
    expect((await app.inject({ url: '/nope' })).statusCode).toBe(404);
    expect([loaded('@fastify/ajv-compiler'), loaded('@fastify/fast-json-stringify-compiler')]).toEqual([false, false]);
    await app.close();
  });

  it('路由带了 schema：注册时加载，校验和序列化都生效', async () => {
    const app = createFastify({ logger: false });
    app.get(
      '/sum',
      {
        schema: {
          querystring: { type: 'object', required: ['a'], properties: { a: { type: 'integer' }, b: { type: 'integer', default: 1 } } },
          response: { 200: { type: 'object', properties: { sum: { type: 'integer' } } } },
        },
      },
      (req) => {
        const { a, b } = req.query as { a: number; b: number };
        // extra 不在 response 的 schema 里，序列化时会被去掉
        return { sum: a + b, extra: 'x' };
      },
    );
    // 校验通过：字符串按 schema 转成数字，默认值补上
    const ok = await app.inject({ url: '/sum?a=2' });
    expect([ok.statusCode, ok.json()]).toEqual([200, { sum: 3 }]);
    const bad = await app.inject({ url: '/sum?a=x' });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: '/sum' })).statusCode).toBe(400);
    expect([loaded('@fastify/ajv-compiler'), loaded('@fastify/fast-json-stringify-compiler')]).toEqual([true, true]);
    await app.close();
  });
});

describe('requestLogEntry：一个结束了的请求记哪一级的日志', () => {
  const base = { method: 'GET', url: '/api/images?limit=120', statusCode: 200, ms: 12, byFastify: true };

  it('不慢也没出错：debug（默认的 info 级别下不出现）', () => {
    expect(requestLogEntry(base)).toEqual({ level: 'debug', msg: 'GET /api/images?limit=120 200 12 ms' });
    expect(requestLogEntry({ ...base, ms: SLOW_REQUEST_MS }).level).toBe('debug');
    expect(requestLogEntry({ ...base, statusCode: 404 }).level).toBe('debug');
    expect(requestLogEntry({ ...base, statusCode: 304 }).level).toBe('debug');
  });

  it('慢请求：info，一行里有方法、地址、状态码、毫秒', () => {
    expect(requestLogEntry({ ...base, ms: 412.6 })).toEqual({ level: 'info', msg: '慢请求 GET /api/images?limit=120 200 413 ms' });
    // 缩略图、原图这类文件响应一样
    expect(requestLogEntry({ ...base, url: '/api/images/7/original', ms: 900 })).toEqual({
      level: 'info',
      msg: '慢请求 GET /api/images/7/original 200 900 ms',
    });
  });

  it('5xx：warn，快慢都记；501（还没实现）不算出错', () => {
    expect(requestLogEntry({ ...base, method: 'POST', url: '/api/commands/x', statusCode: 500, ms: 3 })).toEqual({
      level: 'warn',
      msg: '请求出错 POST /api/commands/x 500 3 ms',
    });
    expect(requestLogEntry({ ...base, statusCode: 503, ms: 900 }).level).toBe('warn');
    expect(requestLogEntry({ ...base, statusCode: 501 }).level).toBe('debug');
    expect(requestLogEntry({ ...base, statusCode: 501, ms: 900 }).level).toBe('info');
  });

  it('被接管的连接（SSE 这类）：开了多久都不算慢请求', () => {
    expect(requestLogEntry({ ...base, url: '/api/events', ms: 3_600_000, byFastify: false }).level).toBe('debug');
  });

  it('地址太长就截断', () => {
    const { msg } = requestLogEntry({ ...base, url: `/api/images?ids=${'1,'.repeat(2000)}`, ms: 900 });
    expect(msg.length).toBeLessThan(340);
    expect(msg).toContain('… 200 900 ms');
  });
});

describe('请求日志：只记慢的和出错的', () => {
  // 请求的耗时 fastify 用 performance.now() 量。换成假的钟，在处理函数里自己拨：不用真的等，机器再忙也不会把普通请求量成慢的
  let clock = 0;
  beforeEach(() => {
    clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  afterEach(() => void vi.restoreAllMocks());
  const pass = (ms: number) => void (clock += ms);
  const entries = (lines: { level: number; msg: string }[]) => lines.map((l) => [l.level, l.msg]);

  it('普通请求一行也不记（fastify 默认每个请求两行）；刚好到门槛的不算慢', async () => {
    const { lines, logger } = capture();
    const app = createFastify({ logger });
    app.get('/ping', () => ({ ok: true }));
    app.get('/file', (_req, reply) => reply.type('image/png').send(Readable.from([Buffer.from('png')])));
    app.get('/missing', (_req, reply) => reply.code(404).send({ ok: false }));
    app.get('/edge', () => {
      pass(SLOW_REQUEST_MS);
      return { ok: true };
    });
    for (const url of ['/ping', '/ping', '/file', '/missing', '/edge']) await app.inject({ url });
    await app.close();
    expect(lines).toEqual([]);
  });

  it('构造时不打 fastify 的弃用警告（顶层的 disableRequestLogging 选项会，每次启动一条）', async () => {
    const emitted = vi.spyOn(process, 'emitWarning');
    const app = createFastify({ logger: false });
    await app.ready();
    await app.close();
    expect(emitted.mock.calls.map((args) => args.map(String).join(' ')).filter((w) => /FSTDEP|FastifyDeprecation/.test(w))).toEqual([]);
  });

  it('日志级别调到 debug：每个请求结束时一行', async () => {
    const { lines, logger } = capture('debug');
    const app = createFastify({ logger });
    app.get('/ping', () => {
      pass(7);
      return { ok: true };
    });
    app.get('/missing', (_req, reply) => reply.code(404).send({ ok: false }));
    for (const url of ['/ping?a=1', '/missing']) await app.inject({ url });
    await app.close();
    expect(entries(lines)).toEqual([
      [DEBUG, 'GET /ping?a=1 200 7 ms'],
      [DEBUG, 'GET /missing 404 0 ms'],
    ]);
  });

  it('慢请求记一行 info；文件响应（流）一样', async () => {
    const { lines, logger } = capture();
    const app = createFastify({ logger });
    app.get('/slow', () => {
      pass(SLOW_REQUEST_MS + 1);
      return { ok: true };
    });
    app.get('/slow-file', (_req, reply) => {
      pass(1200);
      return reply.type('image/png').send(Readable.from([Buffer.from('png')]));
    });
    await app.inject({ url: '/slow?x=1' });
    await app.inject({ url: '/slow-file' });
    await app.close();
    expect(entries(lines)).toEqual([
      [INFO, `慢请求 GET /slow?x=1 200 ${SLOW_REQUEST_MS + 1} ms`],
      [INFO, '慢请求 GET /slow-file 200 1200 ms'],
    ]);
  });

  it('5xx 记一行 warn；出错的详情照旧由错误处理记', async () => {
    const { lines, logger } = capture();
    const app = createFastify({ logger });
    app.setErrorHandler((err, req, reply) => {
      req.log.error(err);
      void reply.status(500).send({ ok: false });
    });
    app.get('/boom', () => {
      pass(3);
      throw new Error('炸了');
    });
    expect((await app.inject({ url: '/boom' })).statusCode).toBe(500);
    await app.close();
    expect(entries(lines)).toEqual([
      [ERROR, '炸了'],
      [WARN, '请求出错 GET /boom 500 3 ms'],
    ]);
  });

  it('被接管的长连接（/api/events 这类）由服务端结束时不记成慢请求', async () => {
    const { lines, logger } = capture();
    const app = createFastify({ logger });
    app.get('/stream', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('retry: 3000\n\n');
      // 开了十分钟之后服务端把它关掉（设备被撤销、关掉入口）
      pass(600_000);
      reply.raw.end();
    });
    const res = await app.inject({ url: '/stream' });
    expect([res.statusCode, res.body]).toEqual([200, 'retry: 3000\n\n']);
    await app.close();
    expect(lines).toEqual([]);
  });
});

describe('静态托管的两个判断', () => {
  const dist = path.resolve('some', 'web', 'dist');

  it('webCacheControl：dist/assets/ 下的文件长期缓存，其余每次核对', () => {
    const immutable = 'public, max-age=31536000, immutable';
    expect(webCacheControl(dist, path.join(dist, 'assets', 'index-D-azgq3W.js'))).toBe(immutable);
    expect(webCacheControl(dist, path.join(dist, 'assets', 'fonts', 'inter-latin.woff2'))).toBe(immutable);
    expect(webCacheControl(dist, path.join(dist, 'index.html'))).toBe('no-cache');
    expect(webCacheControl(dist, path.join(dist, 'favicon.svg'))).toBe('no-cache');
    // 名字像但不在 assets 目录里的、dist 之外的
    expect(webCacheControl(dist, path.join(dist, 'assets'))).toBe('no-cache');
    expect(webCacheControl(dist, path.join(dist, 'assets-old', 'a.js'))).toBe('no-cache');
    expect(webCacheControl(dist, path.join(dist, 'sub', 'assets', 'a.js'))).toBe('no-cache');
    expect(webCacheControl(dist, path.join(dist, '..', 'assets', 'a.js'))).toBe('no-cache');
  });

  it('isAssetRequest：/assets/ 下的地址，带查询串、百分号编码的也认', () => {
    for (const url of ['/assets/index-abc.js', '/assets/index-abc.js?v=1', '/%61ssets/index-abc.js', '/assets/a/b.css']) {
      expect([url, isAssetRequest(url)]).toEqual([url, true]);
    }
    // 最后两个：%2F 静态托管不当成目录分隔；解不开的编码
    for (const url of ['/', '/assets', '/gallery?kind=all', '/api/assets/1', '/x/assets/a.js', '/assets%2Fa.js?x=/assets/', '/%E0%A4%A']) {
      expect([url, isAssetRequest(url)]).toEqual([url, false]);
    }
  });
});
