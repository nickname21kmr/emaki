/**
 * 局域网入口（docs/mobile.md 2.1、2.4、2.6、2.7）：手机（App 或浏览器）从局域网连进来的那个入口。默认关，设置 →「手机访问」里打开。
 *
 * 和本机入口（app.ts 的 buildApp）的区别：
 * - 只走 https（证书见 cert.ts），监听所有网卡，端口默认 5175；
 * - 不限制 Host（地址会变），靠设备凭证：除了 `/api/v1/hello`、`/api/v1/pair*` 和网页的静态文件，所有 `/api/` 都要
 *   `Authorization: Bearer <token>` 或 Cookie `emaki_device=<token>`；没有或不认识 401 unauthorized，撤销了 401 device_revoked；
 * - 认证通过后在 runAsDevice 里处理请求：actor 是 device:<id>，注册表按这台设备的权限范围拦截（commands/registry.ts）；
 * - 写请求照样核对 Origin（必须是 https://<Host>）和 sec-fetch-site，POST 必须是 JSON；
 * - 不挂 AI 助手的路由（/api/assistant/* 里有外部 MCP 的令牌）；SSE 不推 access 事件，设备被撤销时立即断开它的连接。
 *
 * 判断「要不要凭证」看匹配到的路由（req.routeOptions.url，是路由表里的模板，不受 '/%61pi/…' 这种编码影响）；
 * 没匹配到路由的（404、前端路由回落）看解码后的路径是不是 /api 开头。
 *
 * LanEntry 按 lan_access 的 enabled / port 启停 https 监听和 mDNS 广播（discovery.ts）；access.configure 改了配置后立即生效。
 * 监听失败（端口被占用等）不抛到启动流程里，记进状态的 error。
 */
import { DEVICE_GRANTABLE_SCOPES, LAN_PROTOCOL, type LanMe, type PairStartResponse, type PairStatus } from '@emaki/shared';
import { PairRevealInput, PairStartInput } from '@emaki/shared/schemas';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createFastify, mountShared, serveWeb } from '../app.ts';
import type { Engine } from '../commands/registry.ts';
import { config } from '../config.ts';
import type { EventBus } from '../core/events.ts';
import { HttpError } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { currentActor, deviceIdOf, runAsDevice, runCall } from '../propagation/actor.ts';
import type { Access, LanController, LanState } from './access.ts';
import type { LanTls } from './cert.ts';
import { REAL_LAN_NETWORK, type Advertiser, type LanNetwork } from './discovery.ts';
import { MAX_WAIT_S } from './pairing.ts';

/** 浏览器配对后放凭证的 Cookie */
export const DEVICE_COOKIE = 'emaki_device';
const COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=315360000';

/** 不要凭证的路由（路由表里的模板）：App 先问 hello，再走配对 */
const PUBLIC_ROUTES = new Set(['/api/v1/hello', '/api/v1/pair', '/api/v1/pair/:id', '/api/v1/pair/:id/reveal']);

/** 请求的来源地址（IPv4 映射成 IPv6 的去掉前缀） */
export const addressOf = (req: FastifyRequest): string | null => (req.ip ? req.ip.replace(/^::ffff:/, '') : null);

/** 请求带的设备凭证：Authorization: Bearer 优先，其次 Cookie */
function tokenOf(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === DEVICE_COOKIE) return v.join('=') || null;
  }
  return null;
}

/** 这个请求要不要凭证 */
function needsToken(req: FastifyRequest): boolean {
  const route = req.routeOptions.url;
  if (route !== undefined) return route.startsWith('/api') && !PUBLIC_ROUTES.has(route);
  // 没匹配到路由：解码后是 /api 开头的（不存在的接口、AI 助手的路由）也要凭证，其余是前端路由，回落到 index.html
  let p = req.url.split('?')[0] ?? '';
  try {
    p = decodeURIComponent(p);
  } catch {
    return true;
  }
  return p.toLowerCase().startsWith('/api');
}

const unauthorized = (reply: FastifyReply, code: 'unauthorized' | 'device_revoked') =>
  reply.code(401).send({
    ok: false,
    error: code === 'device_revoked' ? '这台设备已经被电脑移除，请重新请求连接' : '需要先在电脑上批准这台设备',
    code,
  });

/** 局域网入口的应用（测试直接用它的 inject，不开端口） */
export async function buildLanApp(engine: Engine, bus: EventBus, access: Access, tls: LanTls, opts: { webDist?: string } = {}) {
  // forceCloseConnections：关掉入口（或换端口）时，手机开着的事件连接、长轮询一起断开
  const app = createFastify({ https: { key: tls.key, cert: tls.cert }, forceCloseConnections: true });

  // 1. 只认自己的页面（同本机入口，只是协议是 https、Host 不限）；POST 必须是 JSON。配对的接口也一样
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = req.headers.origin?.toLowerCase();
    const site = req.headers['sec-fetch-site'];
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if ((origin && origin !== `https://${host}`) || (write && site && site !== 'same-origin' && site !== 'none')) {
      return reply.code(403).send({ ok: false, error: '只允许 Emaki 自己的页面调用', code: 'forbidden' });
    }
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return reply.code(415).send({ ok: false, error: '请求必须是 JSON', code: 'bad_request' });
    }
  });

  // 2. 设备凭证。后面的钩子和处理函数都在这台设备的身份和权限下执行（注册表按 grant 拦截）
  app.addHook('onRequest', (req, reply, done) => {
    if (!needsToken(req)) {
      // 不要凭证的请求（hello、配对、静态文件）：给一个空的权限范围，万一调到注册表也一律 403
      return runCall({ actor: 'system:lan', grant: new Set() }, done);
    }
    const token = tokenOf(req);
    const auth = token ? access.devices.authenticate(token) : ({ error: 'unauthorized' } as const);
    if ('error' in auth) return void unauthorized(reply, auth.error);
    access.devices.seen(auth.device.id, addressOf(req));
    // 只给可授予的范围：库里的权限就算被改出了 devices、desktop 也不生效
    runAsDevice(auth.device.id, auth.device.scopes.filter((s) => DEVICE_GRANTABLE_SCOPES.includes(s)), done);
  });

  mountShared(app, engine, bus, {
    // 配对请求、校验码只给本机页面
    skip: (e) => e.type === 'access',
    watch: (close) => {
      const id = deviceIdOf(currentActor());
      return access.devices.onRevoked((revoked) => {
        if (revoked === id) close();
      });
    },
  });
  lanRoutes(app, access);
  await serveWeb(app, opts.webDist ?? config.webDist);
  return app;
}

/** App 原生部分用的接口（带版本，docs/mobile.md 2.7） */
function lanRoutes(app: FastifyInstance, access: Access): void {
  app.get('/api/v1/hello', () => access.hello());

  app.get('/api/v1/me', (): LanMe => {
    const id = deviceIdOf(currentActor());
    const d = id ? access.devices.get(id) : null;
    if (!d) throw new HttpError(401, 'unauthorized', '需要先在电脑上批准这台设备');
    return { deviceId: d.id, name: d.name, scopes: d.scopes };
  });

  const withCookie = <T extends PairStartResponse | PairStatus>(req: FastifyRequest, reply: FastifyReply, result: T): T => {
    if ('status' in result && result.status === 'approved' && (req.query as { cookie?: string }).cookie === '1')
      reply.header('set-cookie', `${DEVICE_COOKIE}=${result.token}; ${COOKIE_ATTRS}`);
    return result;
  };

  app.post('/api/v1/pair', (req, reply) => {
    const body = parse(PairStartInput, req.body);
    return withCookie(req, reply, access.pairing.start(body, addressOf(req)));
  });

  app.post('/api/v1/pair/:id/reveal', (req) => {
    const { id } = req.params as { id: string };
    access.pairing.reveal(id, parse(PairRevealInput, req.body).nonce);
    return { ok: true };
  });

  app.get('/api/v1/pair/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wait = Math.max(0, Math.min(MAX_WAIT_S, Number((req.query as { wait?: string }).wait) || 0));
    return withCookie(req, reply, await access.pairing.status(id, wait * 1000));
  });
}

/** 监听失败的中文说明 */
function describeListenError(err: unknown, port: number): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') return `端口 ${port} 已被占用，换一个端口试试`;
  if (code === 'EACCES') return `没有权限监听端口 ${port}`;
  return `局域网入口没能打开：${err instanceof Error ? err.message : String(err)}`;
}

/**
 * 局域网入口的控制器：按 lan_access 的配置启停 https 监听和 mDNS 广播。index.ts 启动时建它，app.close() 和退出时一并关掉。
 * 几次 apply 排队执行，不会同时开两个。
 */
export class LanEntry implements LanController {
  private app: FastifyInstance | null = null;
  private advertiser: Advertiser | null = null;
  private running: { port: number; name: string } | null = null;
  private listenError: string | null = null;
  private advertiseError: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly network: LanNetwork;
  private readonly detach: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly bus: EventBus,
    private readonly opts: { network?: LanNetwork; webDist?: string; log?: (msg: string) => void } = {},
  ) {
    this.network = opts.network ?? engine.ports.lan ?? REAL_LAN_NETWORK;
    this.detach = engine.access.attach(this);
  }

  state(): LanState {
    return { listening: !!this.app, error: this.listenError ?? (this.app ? this.advertiseError : null) };
  }

  /** 启动时按存下的配置打开（没开就什么也不做） */
  start(): Promise<void> {
    return this.apply();
  }

  apply(): Promise<void> {
    this.queue = this.queue.then(() => this.reconcile()).catch((err: unknown) => this.opts.log?.(`局域网入口出错：${String(err)}`));
    return this.queue;
  }

  private async reconcile(): Promise<void> {
    if (this.closed) return;
    const access = this.engine.access;
    const before = JSON.stringify(this.state());
    const cfg = access.config();
    if (!cfg.enabled) {
      await this.stop();
      this.listenError = null;
    } else {
      const name = access.displayName();
      if (this.app && this.running?.port === cfg.port) {
        // 只改了名称：重新广播
        if (this.running.name !== name) this.advertise(name, cfg.port, cfg.serverId);
      } else {
        await this.stop();
        let app: FastifyInstance | null = null;
        try {
          app = await buildLanApp(this.engine, this.bus, access, access.tls(), { webDist: this.opts.webDist });
          await this.network.listen(app, cfg.port);
          this.app = app;
          this.listenError = null;
          this.opts.log?.(`局域网入口已打开：https://0.0.0.0:${cfg.port}`);
          this.advertise(name, cfg.port, cfg.serverId);
        } catch (err) {
          await app?.close().catch(() => {});
          this.listenError = describeListenError(err, cfg.port);
          this.opts.log?.(this.listenError);
        }
      }
    }
    if (JSON.stringify(this.state()) !== before) access.notify('changed');
  }

  private advertise(name: string, port: number, serverId: string): void {
    this.advertiser?.stop();
    this.advertiseError = null;
    this.running = { port, name };
    try {
      this.advertiser = this.network.advertiser((err) => {
        this.advertiseError = `局域网广播出错（手机可能搜不到这台电脑，可以扫码或手动输入地址）：${err.message}`;
        this.opts.log?.(this.advertiseError);
        this.engine.access.notify('changed');
      });
      this.advertiser.start({ name, port, serverId, protocol: LAN_PROTOCOL });
    } catch (err) {
      this.advertiser = null;
      this.advertiseError = `局域网广播没能启动（手机可能搜不到这台电脑，可以扫码或手动输入地址）：${(err as Error).message}`;
      this.opts.log?.(this.advertiseError);
    }
  }

  private async stop(): Promise<void> {
    this.advertiser?.stop();
    this.advertiser = null;
    this.advertiseError = null;
    this.running = null;
    const app = this.app;
    this.app = null;
    if (app) {
      await app.close().catch(() => {});
      this.opts.log?.('局域网入口已关闭');
    }
  }

  /** 关掉（app.close()、退出时） */
  async close(): Promise<void> {
    this.closed = true;
    this.detach();
    await this.queue;
    await this.stop();
  }
}
