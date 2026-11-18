/**
 * 批准过的设备和它们的凭证（docs/mobile.md 2.3 第 4 条、2.4、2.5）。表 devices 只有这里写（单一写入者）。
 *
 * - 凭证是 32 字节随机数（base64url），只发给手机一次；库里只存 sha256（hex）。
 * - 认证（authenticate）走内存：第一次用时把整张表读进来，按凭证的哈希查；批准、撤销、改权限、删除时同步改内存。
 *   不认识的凭证不查库（局域网里随便发来的凭证不会打到数据库上）。
 * - 撤销只写 revoked_at、不删行：审计记录里的 device:<id> 还要显示名字；被撤销的凭证回 device_revoked（App 显示「已被电脑移除」）。
 * - 最后访问时间和地址：同一台设备至少隔 60 秒才写一次库。
 * - 撤销时通知订阅者：局域网入口据此立即断开这台设备开着的事件连接；改名称、权限时也通知，局域网入口给它的事件连接推一条 me。
 */
import type { DeviceInfo, Scope } from '@emaki/shared';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.ts';

/** 最后访问时间至少隔这么久才写一次库 */
export const SEEN_WRITE_MS = 60_000;

export interface Device extends DeviceInfo {
  revokedAt: string | null;
}

export type AuthResult = { device: Device } | { error: 'unauthorized' | 'device_revoked' };

interface Row {
  id: string;
  name: string;
  model: string | null;
  scopes: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  last_address: string | null;
  revoked_at: string | null;
}

const COLUMNS = 'id, name, model, scopes, token_hash, created_at, last_seen_at, last_address, revoked_at';

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** 设备 id：8 字节随机数（base64url，11 个字符），出现在审计记录的 device:<id> 里 */
const newDeviceId = (): string => randomBytes(8).toString('base64url');

function toDevice(r: Row): Device {
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    scopes: JSON.parse(r.scopes) as Scope[],
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    lastAddress: r.last_address,
    revokedAt: r.revoked_at,
  };
}

export const deviceInfo = ({ revokedAt: _revoked, ...info }: Device): DeviceInfo => info;

export class Devices {
  /** 凭证的哈希 → 设备（包括撤销了的）；null = 还没读过库 */
  private byHash: Map<string, Device> | null = null;
  private readonly byId = new Map<string, { hash: string; device: Device }>();
  /** 设备 id → 上次写库的时间（毫秒） */
  private readonly seenWritten = new Map<string, number>();
  private readonly revokedListeners = new Set<(deviceId: string) => void>();
  private readonly updatedListeners = new Set<(deviceId: string) => void>();

  constructor(
    private readonly db: Db,
    private readonly clock: () => number,
  ) {}

  private cache(): Map<string, Device> {
    if (!this.byHash) {
      this.byHash = new Map();
      for (const r of this.db.prepare(`SELECT ${COLUMNS} FROM devices`).all() as Row[]) this.remember(r.token_hash, toDevice(r));
    }
    return this.byHash;
  }

  private remember(hash: string, device: Device): void {
    this.byHash!.set(hash, device);
    this.byId.set(device.id, { hash, device });
  }

  private entry(id: string): { hash: string; device: Device } | undefined {
    this.cache();
    return this.byId.get(id);
  }

  /** 按凭证认设备：不认识 unauthorized，撤销了 device_revoked */
  authenticate(token: string): AuthResult {
    const device = this.cache().get(hashToken(token));
    if (!device) return { error: 'unauthorized' };
    if (device.revokedAt) return { error: 'device_revoked' };
    return { device };
  }

  /** 新设备：生成凭证，库里只存哈希。返回设备和凭证（凭证只在这里出现一次） */
  create(input: { name: string; model: string | null; scopes: readonly Scope[] }): { device: Device; token: string } {
    const token = randomBytes(32).toString('base64url');
    const hash = hashToken(token);
    const device: Device = {
      id: newDeviceId(),
      name: input.name,
      model: input.model,
      scopes: [...input.scopes],
      createdAt: new Date(this.clock()).toISOString(),
      lastSeenAt: null,
      lastAddress: null,
      revokedAt: null,
    };
    this.cache();
    this.db
      .prepare('INSERT INTO devices (id, name, model, scopes, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(device.id, device.name, device.model, JSON.stringify(device.scopes), hash, device.createdAt);
    this.remember(hash, device);
    return { device, token };
  }

  /** 删掉一台从没用过的设备（批准后手机没来取凭证，过期了） */
  remove(id: string): void {
    const e = this.entry(id);
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    if (!e) return;
    this.byHash!.delete(e.hash);
    this.byId.delete(id);
    this.seenWritten.delete(id);
  }

  /** 撤销：之后这个凭证的每个请求都是 device_revoked，开着的事件连接立即断开。已经撤销过的返回 false */
  revoke(id: string): boolean {
    const e = this.entry(id);
    if (!e || e.device.revokedAt) return false;
    const at = new Date(this.clock()).toISOString();
    this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(at, id);
    e.device.revokedAt = at;
    for (const fn of this.revokedListeners) fn(id);
    return true;
  }

  /** 改名称、权限（下一个请求就按新的权限；这台设备开着的事件连接收到一条 me） */
  update(id: string, patch: { name?: string; scopes?: readonly Scope[] }): Device | null {
    const e = this.entry(id);
    if (!e || e.device.revokedAt) return null;
    if (patch.name !== undefined) e.device.name = patch.name;
    if (patch.scopes !== undefined) e.device.scopes = [...patch.scopes];
    this.db.prepare('UPDATE devices SET name = ?, scopes = ? WHERE id = ?').run(e.device.name, JSON.stringify(e.device.scopes), id);
    for (const fn of this.updatedListeners) fn(id);
    return e.device;
  }

  /** 这台设备（包括撤销了的）；没有返回 null */
  get(id: string): Device | null {
    return this.entry(id)?.device ?? null;
  }

  /** 没撤销的设备，先批准的在前 */
  list(): Device[] {
    this.cache();
    return [...this.byId.values()]
      .map((e) => e.device)
      .filter((d) => !d.revokedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** 记下最后访问时间和地址：内存里每次都更新，库至少隔 SEEN_WRITE_MS 写一次 */
  seen(id: string, address: string | null): void {
    const e = this.entry(id);
    if (!e) return;
    const now = this.clock();
    e.device.lastSeenAt = new Date(now).toISOString();
    e.device.lastAddress = address;
    const last = this.seenWritten.get(id);
    if (last !== undefined && now - last < SEEN_WRITE_MS) return;
    this.seenWritten.set(id, now);
    this.db.prepare('UPDATE devices SET last_seen_at = ?, last_address = ? WHERE id = ?').run(e.device.lastSeenAt, address, id);
  }

  /** 订阅撤销（局域网入口断开这台设备的事件连接用）。返回取消订阅 */
  onRevoked(fn: (deviceId: string) => void): () => void {
    this.revokedListeners.add(fn);
    return () => this.revokedListeners.delete(fn);
  }

  /** 订阅改名称、权限（局域网入口给这台设备的事件连接推 me 用）。返回取消订阅 */
  onUpdated(fn: (deviceId: string) => void): () => void {
    this.updatedListeners.add(fn);
    return () => this.updatedListeners.delete(fn);
  }
}
