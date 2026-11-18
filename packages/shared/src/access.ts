/**
 * 设备与访问（docs/mobile.md 第 2 节）：局域网入口、配对、设备凭证。
 *
 * - App 原生部分用的接口在局域网入口的 /api/v1/… 下（hello、配对、me），有自己的协议版本（LAN_PROTOCOL）；
 * - 本机页面管理设备的查询和命令在注册表里（scope 是 devices，设备凭证永远拿不到）：GET /api/access、PATCH /api/access、
 *   POST /api/access/requests/:id/approve | reject、PATCH | DELETE /api/devices/:id、POST /api/access/tickets。
 * 配对协议的细节见服务端 apps/server/src/access/pairing.ts 的文件头。
 */
import type { Scope } from './commands.ts';

/** 局域网入口的协议版本（hello 里的 protocol、mDNS 的 TXT v） */
export const LAN_PROTOCOL = 1;

/** GET /api/v1/hello：不要凭证。App 先问它：是不是 Emaki、哪台电脑、协议版本、现在接不接受请求 */
export interface LanHello {
  app: 'emaki';
  protocol: number;
  /** 电脑的固定标识（第一次打开局域网入口时生成） */
  serverId: string;
  /** 电脑名称（默认是计算机名，设置里可改） */
  name: string;
  /** Emaki 的版本 */
  version: string;
  /** App 低于这个版本时提示升级 */
  minAppVersion: string;
  port: number;
  /** 电脑所有网卡的 IPv4 地址（不含本机回环）：App 换地址时挨个试 */
  addresses: string[];
  /** 接受新的连接请求 */
  pairing: boolean;
}

/** POST /api/v1/pair 的请求体：commit 是 sha256(nonceA) 的 hex；带 ticket（扫码的一次性口令）时不用 commit，直接批准 */
export interface PairStartBody {
  name: string;
  model?: string;
  commit?: string;
  ticket?: string;
}

/** POST /api/v1/pair 的响应（普通请求）：id 是这次请求的编号兼凭据，nonce 是电脑的随机数 nonceB（hex） */
export interface PairStarted {
  id: string;
  nonce: string;
  expiresAt: string;
}

/** GET /api/v1/pair/:id：请求的状态。approved 只发一次（发出去以后这条请求就删掉，再问是 expired） */
export type PairStatus =
  | { status: 'pending' }
  | { status: 'approved'; deviceId: string; token: string }
  | { status: 'rejected' }
  | { status: 'expired' };

/** POST /api/v1/pair 的响应：普通请求返回 PairStarted；带扫码口令的直接批准，返回凭证 */
export type PairStartResponse = PairStarted | Extract<PairStatus, { status: 'approved' }>;

/** 本机页面上等批准的请求（只列手机已经公开了随机数、算得出校验码的） */
export interface PairRequestInfo {
  /** 本机页面用的编号（批准、拒绝时用；和手机手里的那个凭据不是一个） */
  id: string;
  /** 6 位校验码，和手机上显示的应该一样 */
  code: string;
  name: string;
  model: string | null;
  /** 发请求的地址 */
  address: string | null;
  createdAt: string;
  expiresAt: string;
}

/** 已批准、没撤销的设备 */
export interface DeviceInfo {
  id: string;
  name: string;
  model: string | null;
  scopes: Scope[];
  createdAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
}

/** GET /api/access：设置 →「手机访问」 */
export interface AccessStatus {
  enabled: boolean;
  port: number;
  /** 自己改过的名称；null = 用计算机名 */
  name: string | null;
  /** 计算机名（name 为 null 时用它） */
  defaultName: string;
  serverId: string;
  /** 证书指纹（DER 的 sha256，hex）；还没打开过、没生成证书时是 null */
  fingerprint: string | null;
  addresses: string[];
  /** 局域网入口正在监听 */
  listening: boolean;
  /** 打不开时的原因（中文，端口被占用等） */
  error: string | null;
  requests: PairRequestInfo[];
  devices: DeviceInfo[];
}

/** GET /api/v1/me：凭证还有效时返回这台设备 */
export interface LanMe {
  deviceId: string;
  name: string;
  scopes: Scope[];
}

/** POST /api/access/tickets：二维码的内容（emaki://pair?…）和过期时间 */
export interface AccessTicket {
  uri: string;
  expiresAt: string;
}

/**
 * SSE 事件（只推给本机入口）：requested 是手机发来了请求、算出了校验码（带请求）；
 * changed 是批准、拒绝、过期、撤销、改权限、改配置、监听状态变了（网页重新取 GET /api/access）。
 * 不编号、不补发：网页连上时自己取一次状态。
 */
export interface AccessEvent {
  type: 'access';
  reason: 'requested' | 'changed';
  request?: PairRequestInfo;
}
