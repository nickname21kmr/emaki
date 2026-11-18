/**
 * 配对：手机请求连接，电脑上核对校验码后批准（docs/mobile.md 2.3）。等待中的请求只放在内存里，5 分钟就作废，不进数据库。
 *
 * 协议（局域网入口，https；App 和假手机脚本 scripts/lan-client.ts 都照这个实现）：
 *
 * 0. 手机先连上电脑的 https，记下证书 DER 的 sha256（fp，32 字节）。以后的每个请求都只认这张证书。
 *    `GET /api/v1/hello` → `{ app: 'emaki', protocol, serverId, name, … }`（LanHello）：确认是 Emaki、是哪台电脑。
 * 1. 手机生成 32 字节随机数 nonceA，`POST /api/v1/pair`，体 `{ name, model?, commit }`，commit = hex(sha256(nonceA))。
 *    返回 `{ id, nonce, expiresAt }`：id 是 16 字节随机数（base64url），既是这次请求的编号也是它的凭据，只有手机知道；
 *    nonce 是电脑的 32 字节随机数 nonceB（hex）。
 * 2. 手机看到 nonceB 之后才公开 nonceA：`POST /api/v1/pair/:id/reveal`，体 `{ nonce: hex(nonceA) }`。
 *    电脑核对 sha256(nonceA) == commit（对不上这条请求直接作废），算出校验码，请求变成「等你批准」，本机页面弹出提示。
 *    校验码不返回给手机：手机自己算。reveal 只能一次（再来回 409）。
 * 3. 校验码 = sha256(utf8("emaki-pair-v1") ‖ fp ‖ nonceA ‖ nonceB) 的前 4 字节按大端读成无符号整数，模 1 000 000，补零到 6 位。
 *    两边的数字一样，说明手机看到的证书就是电脑的这张（中间人换了证书，fp 不同，数字就对不上），
 *    而且中间人在看到 nonceB 之前已经被 commit 绑死了 nonceA，凑不出一样的数字。
 * 4. 手机长轮询 `GET /api/v1/pair/:id?wait=<秒，最多 25>`：`{ status: 'pending' }` / `{ status: 'approved', deviceId, token }` /
 *    `{ status: 'rejected' }` / `{ status: 'expired' }`。凭证只发一次：发出去以后这条请求就删掉（再问是 expired）。
 *    带 `?cookie=1` 时批准的响应顺带 Set-Cookie（浏览器配对用，access/lan.ts）。
 * 5. 之后每个请求带 `Authorization: Bearer <token>`（网页带 Cookie `emaki_device=<token>`）。
 *
 * 规则：请求 5 分钟过期（批准后 5 分钟内没取走凭证也作废，设备行一并删掉）；同时等批准的请求最多 3 个（429）；
 * 同一个地址 10 分钟内最多发 10 次请求（429）。
 *
 * 扫码：本机页面用命令 access.createTicket 生成一次性口令（2 分钟有效，用一次就失效），放进二维码；
 * `POST /api/v1/pair` 带 `ticket`（不用 commit）时直接批准（默认权限），响应就是 `{ status: 'approved', deviceId, token }`。
 * 扫码等于你已经在电脑上同意了；证书指纹也在二维码里，手机照样认准它。
 */
import { DEVICE_DEFAULT_SCOPES, type PairRequestInfo, type PairStartResponse, type PairStatus, type Scope } from '@emaki/shared';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../http/errors.ts';
import type { Device, Devices } from './devices.ts';

/** 请求的有效期（批准后取凭证也是这么久） */
export const PAIR_TTL_MS = 5 * 60_000;
/** 同时等批准的请求最多这么多个 */
export const MAX_WAITING = 3;
/** 同一个地址在这段时间里最多发 RATE_MAX 次请求 */
export const RATE_WINDOW_MS = 10 * 60_000;
export const RATE_MAX = 10;
/** 扫码口令的有效期 */
export const TICKET_TTL_MS = 2 * 60_000;
/** 长轮询最多等这么多秒 */
export const MAX_WAIT_S = 25;

/** 校验码（第 3 步）：手机和电脑各算一遍，测试和假手机脚本也用它 */
export function pairingCode(fingerprint: Uint8Array, nonceA: Uint8Array, nonceB: Uint8Array): string {
  const h = createHash('sha256').update('emaki-pair-v1', 'utf8').update(fingerprint).update(nonceA).update(nonceB).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

interface PairRequest {
  /** 协议里的 id：手机拿它 reveal、轮询，同时是凭据 */
  key: string;
  /** 本机页面用的编号 */
  id: string;
  name: string;
  model: string | null;
  address: string | null;
  commit: string;
  nonceB: Buffer;
  createdAt: number;
  expiresAt: number;
  state: 'committed' | 'revealed' | 'approved' | 'rejected';
  code: string | null;
  /** 批准后：设备和要发给手机的凭证 */
  issued?: { deviceId: string; token: string };
}

export interface PairingDeps {
  clock: () => number;
  /** 证书指纹（32 字节原始值）：算校验码 */
  fingerprint: () => Buffer;
  devices: Devices;
  /** 本机页面要知道的变化：requested 新请求（带请求），changed 其余 */
  notify: (reason: 'requested' | 'changed', request?: PairRequestInfo) => void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const gone = () => new HttpError(404, 'not_found', '这个请求不存在或已经过期，请在手机上重新请求');

export class Pairing {
  /** key → 请求 */
  private readonly requests = new Map<string, PairRequest>();
  /** 地址 → 最近发请求的时间 */
  private readonly attempts = new Map<string, number[]>();
  /** 扫码口令 → 过期时间 */
  private readonly tickets = new Map<string, number>();
  /** key → 长轮询在等的 */
  private readonly waiters = new Map<string, Set<() => void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PairingDeps) {}

  /** 第 1 步（或者扫码直接批准）。address 是请求的来源地址 */
  start(body: { name: string; model?: string; commit?: string; ticket?: string }, address: string | null): PairStartResponse {
    const now = this.sweep();
    const key = address ?? '?';
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) throw new HttpError(429, 'too_many_requests', '请求太频繁了，请过几分钟再试');
    recent.push(now);
    this.attempts.set(key, recent);

    if (body.ticket !== undefined) {
      const expires = this.tickets.get(body.ticket);
      if (expires === undefined || expires <= now) throw new HttpError(403, 'forbidden', '二维码已经过期或用过了，请在电脑上重新生成');
      this.tickets.delete(body.ticket);
      const { device, token } = this.deps.devices.create({ name: body.name, model: body.model ?? null, scopes: DEVICE_DEFAULT_SCOPES });
      this.deps.notify('changed');
      return { status: 'approved', deviceId: device.id, token };
    }

    const waiting = [...this.requests.values()].filter((r) => r.state === 'committed' || r.state === 'revealed').length;
    if (waiting >= MAX_WAITING) throw new HttpError(429, 'too_many_requests', '等待批准的请求太多了，请先在电脑上处理');
    const r: PairRequest = {
      key: randomBytes(16).toString('base64url'),
      id: randomBytes(6).toString('base64url'),
      name: body.name,
      model: body.model || null,
      address,
      commit: body.commit!,
      nonceB: randomBytes(32),
      createdAt: now,
      expiresAt: now + PAIR_TTL_MS,
      state: 'committed',
      code: null,
    };
    this.requests.set(r.key, r);
    this.schedule();
    return { id: r.key, nonce: r.nonceB.toString('hex'), expiresAt: iso(r.expiresAt) };
  }

  /** 第 2 步：手机公开 nonceA。对得上就算出校验码、推给本机页面；对不上这条请求作废 */
  reveal(key: string, nonceHex: string): void {
    this.sweep();
    const r = this.requests.get(key);
    if (!r) throw gone();
    if (r.state !== 'committed') throw new HttpError(409, 'conflict', '这个请求已经公开过随机数了');
    const nonceA = Buffer.from(nonceHex, 'hex');
    if (sha256Hex(nonceA) !== r.commit) {
      this.drop(r);
      throw new HttpError(400, 'bad_request', '随机数和之前提交的对不上，这次请求作废了，请重新请求');
    }
    r.state = 'revealed';
    r.code = pairingCode(this.deps.fingerprint(), nonceA, r.nonceB);
    this.deps.notify('requested', this.info(r));
  }

  /** 第 4 步：请求的状态；还在等时最多等 waitMs 毫秒（批准、拒绝、过期都会提前叫醒） */
  async status(key: string, waitMs = 0): Promise<PairStatus> {
    this.sweep();
    const r = this.requests.get(key);
    if (r && (r.state === 'committed' || r.state === 'revealed') && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(key) ?? new Set();
        this.waiters.set(key, set);
        const wake = () => {
          clearTimeout(timer);
          set.delete(wake);
          if (!set.size) this.waiters.delete(key);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(waitMs, MAX_WAIT_S * 1000));
        set.add(wake);
      });
      this.sweep();
    }
    const now = this.requests.get(key);
    if (!now) return { status: 'expired' };
    if (now.state === 'approved') {
      // 凭证只发一次
      this.requests.delete(key);
      this.schedule();
      return { status: 'approved', deviceId: now.issued!.deviceId, token: now.issued!.token };
    }
    if (now.state === 'rejected') {
      this.requests.delete(key);
      this.schedule();
      return { status: 'rejected' };
    }
    return { status: 'pending' };
  }

  /** 本机页面批准（scopes 已经按 DEVICE_GRANTABLE_SCOPES 校验过）。凭证等手机来取，5 分钟内没来取就作废 */
  approve(id: string, opts: { scopes?: readonly Scope[]; name?: string } = {}): Device {
    const r = this.waitingRequest(id);
    const { device, token } = this.deps.devices.create({
      name: opts.name ?? r.name,
      model: r.model,
      scopes: opts.scopes ?? DEVICE_DEFAULT_SCOPES,
    });
    r.state = 'approved';
    r.issued = { deviceId: device.id, token };
    r.expiresAt = this.deps.clock() + PAIR_TTL_MS;
    this.wake(r.key);
    this.schedule();
    this.deps.notify('changed');
    return device;
  }

  /** 本机页面拒绝：手机下次问的时候告诉它 rejected */
  reject(id: string): void {
    const r = this.waitingRequest(id);
    r.state = 'rejected';
    this.wake(r.key);
    this.deps.notify('changed');
  }

  /** 等批准的请求（已经算出校验码的），先来的在前 */
  waiting(): PairRequestInfo[] {
    this.sweep();
    return [...this.requests.values()]
      .filter((r) => r.state === 'revealed')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => this.info(r));
  }

  /** 扫码的一次性口令 */
  createTicket(): { ticket: string; expiresAt: number } {
    const now = this.sweep();
    const ticket = randomBytes(16).toString('base64url');
    const expiresAt = now + TICKET_TTL_MS;
    this.tickets.set(ticket, expiresAt);
    this.schedule();
    return { ticket, expiresAt };
  }

  /**
   * 清掉过期的请求、口令和限速记录（每次调用时都先做一遍，另有一个定时器在最早的过期时间叫醒它）。
   * 批准了没取走凭证的，设备行一并删掉。返回现在的时间
   */
  sweep(): number {
    const now = this.deps.clock();
    let changed = false;
    for (const r of [...this.requests.values()]) {
      if (r.expiresAt > now) continue;
      if (r.state === 'revealed' || r.state === 'approved') changed = true;
      if (r.state === 'approved' && r.issued) this.deps.devices.remove(r.issued.deviceId);
      this.drop(r);
    }
    for (const [t, expires] of this.tickets) if (expires <= now) this.tickets.delete(t);
    for (const [a, times] of this.attempts) {
      const recent = times.filter((t) => now - t < RATE_WINDOW_MS);
      if (recent.length) this.attempts.set(a, recent);
      else this.attempts.delete(a);
    }
    if (changed) this.deps.notify('changed');
    return now;
  }

  /** 停掉定时器，叫醒所有长轮询（引擎关闭时） */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const key of [...this.waiters.keys()]) this.wake(key);
  }

  private waitingRequest(id: string): PairRequest {
    this.sweep();
    const r = [...this.requests.values()].find((x) => x.id === id && x.state === 'revealed');
    if (!r) throw new HttpError(404, 'not_found', '这个请求不存在或已经过期');
    return r;
  }

  private drop(r: PairRequest): void {
    this.requests.delete(r.key);
    this.wake(r.key);
    this.schedule();
  }

  private wake(key: string): void {
    for (const fn of [...(this.waiters.get(key) ?? [])]) fn();
  }

  /** 定时器设在最早的过期时间：过期了要推给本机页面、删掉没取走凭证的设备 */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...[...this.requests.values()].map((r) => r.expiresAt), ...this.tickets.values());
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.sweep();
        this.schedule();
      },
      Math.max(0, next - this.deps.clock()) + 50,
    );
    this.timer.unref();
  }

  private info(r: PairRequest): PairRequestInfo {
    return {
      id: r.id,
      code: r.code ?? '',
      name: r.name,
      model: r.model,
      address: r.address,
      createdAt: iso(r.createdAt),
      expiresAt: iso(r.expiresAt),
    };
  }
}
