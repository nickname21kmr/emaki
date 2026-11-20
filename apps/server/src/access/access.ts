/**
 * 模块「设备与访问」（docs/mobile.md 第 2 节，2.8）：局域网入口的配置、证书、配对、设备凭证。表 lan_access、devices 只有 access/ 写。
 *
 * 引擎（SqliteDataSource）建它，注册表里的命令和查询（commands/access.ts）经它读写；
 * 局域网入口的启停（https 监听、mDNS 广播）在 lan.ts 的 LanEntry，它把自己挂到这里（attach），配置改了立即生效。
 */
import {
  LAN_PROTOCOL,
  SCOPES,
  type AccessStatus,
  type AccessTicket,
  type LanHello,
  type LanMe,
  type Me,
  type PairRequestInfo,
  type Scope,
} from '@emaki/shared';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { config as appConfig } from '../config.ts';
import type { EventBus } from '../core/events.ts';
import type { Db } from '../db/connection.ts';
import { ConflictError, HttpError } from '../http/errors.ts';
import { currentActor, currentCall, deviceIdOf } from '../propagation/actor.ts';
import { loadOrCreateCert, readCert, type LanTls } from './cert.ts';
import { deviceInfo, Devices, type Device } from './devices.ts';
import { lanAddresses } from './discovery.ts';
import { Pairing } from './pairing.ts';

/** App 低于这个版本时提示升级（hello 里给） */
export const MIN_APP_VERSION = '0.1.0';
export const DEFAULT_LAN_PORT = 5175;

export interface LanConfig {
  serverId: string;
  enabled: boolean;
  port: number;
  /** 自己改的电脑名称；null = 计算机名 */
  name: string | null;
}

/** 局域网入口现在的状态（LanEntry 给） */
export interface LanState {
  listening: boolean;
  error: string | null;
}

/** 局域网入口的控制器（lan.ts 的 LanEntry）：按配置启停 */
export interface LanController {
  state(): LanState;
  /** 按现在的配置启停：关掉旧的、按新端口开（不抛错，失败记进 state().error） */
  apply(): Promise<void>;
}

interface ConfigRow {
  server_id: string;
  enabled: number;
  port: number;
  name: string | null;
}

export class Access {
  readonly devices: Devices;
  readonly pairing: Pairing;
  private controller: LanController | null = null;
  private cert: LanTls | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      bus: EventBus;
      /** 证书放在 <dataDir>/lan */
      dataDir: string;
      clock: () => number;
    },
  ) {
    this.devices = new Devices(deps.db, deps.clock);
    this.pairing = new Pairing({
      clock: deps.clock,
      fingerprint: () => this.tls().fingerprint,
      devices: this.devices,
      notify: (reason, request) => this.notify(reason, request),
    });
  }

  /** 局域网入口的配置；第一次读时插一行（生成 serverId） */
  config(): LanConfig {
    const { db } = this.deps;
    let row = db.prepare('SELECT server_id, enabled, port, name FROM lan_access WHERE id = 1').get() as ConfigRow | undefined;
    if (!row) {
      db.prepare('INSERT OR IGNORE INTO lan_access (id, server_id) VALUES (1, ?)').run(randomBytes(16).toString('hex'));
      row = db.prepare('SELECT server_id, enabled, port, name FROM lan_access WHERE id = 1').get() as ConfigRow;
    }
    return { serverId: row.server_id, enabled: row.enabled === 1, port: row.port, name: row.name };
  }

  /** 广播、hello 里的电脑名称 */
  displayName(): string {
    return this.config().name ?? os.hostname();
  }

  /** 证书：没有就生成（第一次打开局域网入口时，约 0.5 秒） */
  tls(): LanTls {
    this.cert ??= loadOrCreateCert(path.join(this.deps.dataDir, 'lan'), this.config().serverId);
    return this.cert;
  }

  /** 已经生成过的证书的指纹（hex）；还没生成是 null */
  private fingerprintHex(): string | null {
    this.cert ??= readCert(path.join(this.deps.dataDir, 'lan'));
    return this.cert?.fingerprintHex ?? null;
  }

  /** LanEntry 把自己挂上来；返回取下的函数 */
  attach(controller: LanController): () => void {
    this.controller = controller;
    return () => {
      if (this.controller === controller) this.controller = null;
    };
  }

  /** 推给本机页面（局域网入口的 SSE 不推这类事件） */
  notify(reason: 'requested' | 'changed', request?: PairRequestInfo): void {
    this.deps.bus.emit({ type: 'access', reason, ...(request ? { request } : {}) });
  }

  /** GET /api/access */
  status(): AccessStatus {
    const c = this.config();
    const state = this.controller?.state() ?? { listening: false, error: null };
    return {
      enabled: c.enabled,
      port: c.port,
      name: c.name,
      defaultName: os.hostname(),
      serverId: c.serverId,
      fingerprint: this.fingerprintHex(),
      addresses: lanAddresses(),
      listening: state.listening,
      error: state.error,
      requests: this.pairing.waiting(),
      devices: this.devices.list().map(deviceInfo),
    };
  }

  /** PATCH /api/access：存下来，局域网入口立即按新配置启停（不用重启） */
  async configure(patch: { enabled?: boolean; port?: number; name?: string | null }): Promise<AccessStatus> {
    const c = this.config();
    const next = {
      enabled: patch.enabled ?? c.enabled,
      port: patch.port ?? c.port,
      name: patch.name === undefined ? c.name : patch.name,
    };
    this.deps.db
      .prepare('UPDATE lan_access SET enabled = ?, port = ?, name = ? WHERE id = 1')
      .run(next.enabled ? 1 : 0, next.port, next.name);
    await this.controller?.apply();
    this.notify('changed');
    return this.status();
  }

  /**
   * GET /api/me（两个入口）：谁在调用。本机入口（user、助手）是 local、全部范围；
   * 局域网入口上是这台设备，范围取这次请求的 grant（lan.ts 认证时算好的、注册表拦截用的同一份），按 SCOPES 的顺序
   */
  me(): Me {
    const id = deviceIdOf(currentActor());
    if (!id) return { kind: 'local', scopes: Object.keys(SCOPES) as Scope[] };
    return { kind: 'device', ...this.deviceMe(id) };
  }

  /** GET /api/v1/me（App 用）和 GET /api/me 的设备部分：没认出（或撤销了）是 401 */
  deviceMe(id: string | null = deviceIdOf(currentActor())): LanMe {
    const d = id ? this.devices.get(id) : null;
    if (!d || d.revokedAt) throw new HttpError(401, 'unauthorized', '需要先在电脑上批准这台设备');
    const grant = currentCall()?.grant ?? new Set<Scope>();
    return { deviceId: d.id, name: d.name, scopes: (Object.keys(SCOPES) as Scope[]).filter((s) => grant.has(s)) };
  }

  /** GET /api/v1/hello */
  hello(): LanHello {
    const c = this.config();
    return {
      app: 'emaki',
      protocol: LAN_PROTOCOL,
      serverId: c.serverId,
      name: this.displayName(),
      version: appConfig.appVersion,
      minAppVersion: MIN_APP_VERSION,
      port: c.port,
      addresses: lanAddresses(),
      pairing: true,
      // 只在局域网入口开着时有人问，证书已经有了
      fingerprint: this.tls().fingerprintHex,
    };
  }

  /** 批准一个请求（命令 devices.approve） */
  approve(id: string, opts: { scopes?: readonly Scope[]; name?: string }): Device {
    return this.pairing.approve(id, opts);
  }

  /** 撤销（命令 devices.revoke）：之后它的请求全部 401 device_revoked，事件连接立即断开 */
  revoke(id: string): Device {
    const d = this.devices.get(id);
    if (!d || d.revokedAt) throw new HttpError(404, 'not_found', '没有这台设备');
    this.devices.revoke(id);
    this.notify('changed');
    return d;
  }

  /** 改名称、权限（命令 devices.update） */
  update(id: string, patch: { name?: string; scopes?: readonly Scope[] }): Device {
    const d = this.devices.update(id, patch);
    if (!d) throw new HttpError(404, 'not_found', '没有这台设备');
    this.notify('changed');
    return d;
  }

  /** 扫码的一次性口令（命令 access.createTicket）：局域网入口没开时 409 */
  createTicket(): AccessTicket {
    const c = this.config();
    if (!c.enabled) throw new ConflictError('先打开「手机访问」再生成二维码');
    const fp = this.tls().fingerprintHex;
    const { ticket, expiresAt } = this.pairing.createTicket();
    const hosts = lanAddresses().join(',');
    return {
      uri: `emaki://pair?id=${c.serverId}&fp=${fp}&p=${c.port}&h=${hosts}&t=${ticket}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** 引擎关闭时：停掉配对的定时器、叫醒长轮询 */
  close(): void {
    this.pairing.close();
  }
}
