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
  /**
   * 证书指纹（证书 DER 的 sha256，hex）。浏览器配对用：网页拿不到 TLS 证书，只能从这里取来算校验码。
   * 中间人可以同时换掉证书和这一项，所以浏览器这条路防不了中间人（只防同一 Wi-Fi 下的人冒充手机）；
   * App 要用自己在 TLS 握手里看到的那张证书算，不能信这一项
   */
  fingerprint: string;
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

/** GET /api/v1/me：凭证还有效时返回这台设备（App 用；scopes 是真正生效的范围，同 Me） */
export interface LanMe {
  deviceId: string;
  name: string;
  scopes: Scope[];
}

/**
 * GET /api/me：谁在调用（两个入口都有）。网页按它隐藏用不了的入口（apps/web/src/lib/capabilities.ts）。
 * - 本机入口：local，scopes 是全部范围；
 * - 局域网入口：这台设备，scopes 是真正生效的范围（存下的权限和可授予范围的交集，和注册表拦截用的是同一份）。
 * 电脑上改了这台设备的名称或权限时，局域网入口只给它开着的事件连接推一条 MeEvent，网页重新取。
 */
export type Me = { kind: 'local'; scopes: Scope[] } | ({ kind: 'device' } & LanMe);

/** SSE 事件（只推给那台设备的局域网连接）：电脑上改了它的名称或权限，网页重新取 GET /api/me。不编号、不补发 */
export interface MeEvent {
  type: 'me';
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

// ---------------------------------------------------------------- 手机上传（B1，docs/mobile.md 5.4）

/** 设备传上来的图放到哪：图库文件夹 + 相对路径（手动上传再进「手动上传」子文件夹，同步的相册进相册名的子文件夹） */
export interface UploadTarget {
  deviceId: string;
  /** 图库文件夹；null = 没有可用的（一个自动识别的图库文件夹都没有） */
  rootId: string | null;
  rootPath: string | null;
  /** 相对图库文件夹，正斜杠；'' = 图库文件夹本身 */
  dir: string;
  /** 没设过，用的是默认（收件箱/手机/<设备名>） */
  isDefault: boolean;
}

/** POST /api/uploads/check：这些图电脑上有没有（按 sha256） */
export interface UploadCheckResult {
  results: {
    sha256: string;
    /** 图库里内容相同的图；没有是 null */
    imageId: string | null;
    /** 图库里没有，但删过（只在回收站里、或文件丢了）：同步相册时不再传（电脑上删掉的不会被同步回来） */
    deleted: boolean;
    /** 那张图在问的这台设备的「上传到」里：所在的文件夹（相对「上传到」，'' 是它本身）；不在里面、或者不是设备问的是 null */
    dir: string | null;
  }[];
}

export type UploadStatus = 'receiving' | 'imported' | 'existing' | 'failed';

/** POST /api/uploads：开始（或接着）传一个文件 */
export interface UploadBeginResult {
  uploadId: string;
  /** 已经收到的字节数：接着从这里传 */
  received: number;
  status: UploadStatus;
  /** 已经传完（这台设备传过同一个文件）：电脑上那张图 */
  imageId: string | null;
}

/** POST /api/uploads/:id/complete */
export interface UploadCompleteResult {
  ok: true;
  message: string;
  status: 'imported' | 'existing';
  imageId: string;
}

/** GET /api/uploads/batches：电脑上看最近的上传 */
export interface UploadBatch {
  id: string;
  deviceId: string;
  deviceName: string;
  /** null = 手动上传 */
  album: string | null;
  createdAt: string;
  updatedAt: string;
  undoneAt: string | null;
  imported: number;
  existing: number;
  failed: number;
  /** 还在传的 */
  receiving: number;
  /** 这一批新入库的图（最多 12 张，给缩略图） */
  imageIds: string[];
}

// ---------------------------------------------------------------- 同步相册（B2，docs/mobile.md 5.5）

/** 一个相册的盘点：App 把相册里每张图的 sha256 问过电脑之后报的 */
export interface AlbumInventory {
  total: number;
  /** 电脑上有（任何地方） */
  have: number;
  /** 其中在这台设备的「上传到」里的 */
  inTarget: number;
  /** 电脑上删过的（只在回收站里、或文件丢了）：不会再传 */
  deleted: number;
  /** 电脑上没有的：同步时要传 */
  new: number;
  newBytes: number;
  /** 「上传到」里老图最集中的文件夹（相对「上传到」）和张数；一张都不在里面是 null */
  folder: string | null;
  folderCount: number;
  at: string;
}

/** 新图放到哪是怎么来的：跟着老图、按相册路径取名、用户改的 */
export type AlbumDirReason = 'history' | 'name' | 'manual';

/** 手机上的一个相册（= 一个文件夹，不含子文件夹） */
export interface DeviceAlbum {
  /** 手机上的路径：'Download'、'Pictures/bili' */
  path: string;
  name: string;
  count: number;
  bytes: number;
  latestAt: string | null;
  /** 手机上没有这个文件夹了 */
  gone: boolean;
  /** 没盘点过是 null */
  inventory: AlbumInventory | null;
  sync: boolean;
  /** 新图放到「上传到」下的哪个文件夹（'' 是「上传到」本身）：定下来的，或者还没定时现在会选的 */
  dir: string;
  dirReason: AlbumDirReason;
  /** 定下来了：第一次打开同步时定，之后不再自动变 */
  dirFixed: boolean;
  /** 为什么放这里：「以前的 8556 张都在这里」「按相册路径取的名字」「你改的」 */
  dirNote: string;
  /** 建议同步：盘点过，电脑上已有的图过半在这台设备的「上传到」里（以前拷过的相册） */
  suggested: boolean;
  /** 上次同步完还没传上来的（会再试） */
  pending: number | null;
  /** 电脑读不了的（格式不支持，例如改成 .jpg 的 HEIF）：不再传，重新盘点后再试一次 */
  rejected: number | null;
  syncedAt: string | null;
}

/** App 报的同步状态 */
export interface AlbumSyncState {
  running: 'inventory' | 'sync' | null;
  done: number | null;
  total: number | null;
  error: string | null;
  /** 最近一次有结果的同步、盘点：「同步了 12 张」「盘点了 22 个相册」（没有新图的同步不报） */
  summary: string | null;
  /** summary 是什么时候的 */
  summaryAt: string | null;
  reportedAt: string | null;
  inventoriedAt: string | null;
  syncedAt: string | null;
}

/** GET /api/uploads/albums：一台设备的同步相册 */
export interface AlbumSyncInfo {
  deviceId: string;
  deviceName: string;
  target: UploadTarget;
  /** 只在 Wi-Fi（不按流量计费的网络）下同步 */
  wifiOnly: boolean;
  /** 只在充电时同步 */
  chargingOnly: boolean;
  state: AlbumSyncState;
  albums: DeviceAlbum[];
}

/** POST /api/uploads/albums（App 报相册、盘点、状态）的回答：App 按它同步 */
export interface AlbumSyncConfig {
  wifiOnly: boolean;
  chargingOnly: boolean;
  albums: { path: string; sync: boolean }[];
}
