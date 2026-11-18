/**
 * 让手机找到电脑（docs/mobile.md 2.2）：局域网入口打开时用 mDNS 广播自己，服务类型 `_emaki._tcp`，
 * TXT 带电脑的固定标识 id、协议版本 v、电脑名称 name。App（和 scripts/lan-client.ts discover）按 id 认电脑。
 *
 * 广播和 https 监听是碰真网络的部件（infra/ports.ts 的 lan）：真实实现在这里，测试换成记录调用的假实现。
 */
import { Bonjour, type Service } from 'bonjour-service';
import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from 'node:events';

/** mDNS 的服务类型（`_emaki._tcp`） */
export const SERVICE_TYPE = 'emaki';

export interface AdvertiseInfo {
  name: string;
  port: number;
  serverId: string;
  protocol: number;
}

export interface Advertiser {
  start(info: AdvertiseInfo): void;
  stop(): void;
}

/** 局域网入口碰真网络的两件事：广播、在所有网卡上监听 https */
export interface LanNetwork {
  /** onError：广播出了问题（端口 5353 用不了等），记进状态，不影响监听 */
  advertiser(onError: (err: Error) => void): Advertiser;
  listen(app: FastifyInstance, port: number): Promise<void>;
}

/** 真实的广播：bonjour-service */
export class BonjourAdvertiser implements Advertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  constructor(private readonly onError: (err: Error) => void) {}

  start(info: AdvertiseInfo): void {
    this.stop();
    // 不给 errorCallback 的话 bonjour-service 遇到错误直接 throw；multicast-dns 的 socket 错误（EADDRINUSE / EACCES）它也没接，要自己接
    const bonjour = new Bonjour({}, (err: Error) => this.onError(err));
    (bonjour as unknown as { server: { mdns: EventEmitter } }).server.mdns.on('error', (err: Error) => this.onError(err));
    this.bonjour = bonjour;
    // 实例名在局域网里要唯一：两台电脑同名时也不冲突（App 显示的是 TXT 里的 name）
    this.service = bonjour.publish({
      name: `${info.name} (${info.serverId.slice(0, 6)})`,
      type: SERVICE_TYPE,
      protocol: 'tcp',
      port: info.port,
      txt: { id: info.serverId, v: String(info.protocol), name: info.name },
    });
    this.service.on('error', (err: Error) => this.onError(err));
  }

  stop(): void {
    const { bonjour, service } = this;
    this.bonjour = null;
    this.service = null;
    if (!bonjour) return;
    // 先发「下线」再关 socket
    const close = () => bonjour.destroy();
    if (service?.stop) service.stop(close);
    else close();
  }
}

/** 真实网络：bonjour 广播，https 监听所有网卡（IPv4） */
export const REAL_LAN_NETWORK: LanNetwork = {
  advertiser: (onError) => new BonjourAdvertiser(onError),
  async listen(app, port) {
    await app.listen({ host: '0.0.0.0', port });
  },
};
