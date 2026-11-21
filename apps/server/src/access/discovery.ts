/**
 * 让手机找到电脑（docs/mobile.md 2.2）：局域网入口打开时用 mDNS 广播自己，服务类型 `_emaki._tcp`，
 * TXT 带电脑的固定标识 id、协议版本 v、电脑名称 name。App（和 scripts/lan-client.ts discover）按 id 认电脑。
 *
 * 广播和 https 监听是碰真网络的部件（infra/ports.ts 的 lan）：真实实现在这里，测试换成记录调用的假实现。
 */
import { Bonjour, type Service } from 'bonjour-service';
import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from 'node:events';
import os from 'node:os';

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
/**
 * 能让手机连过来的地址：所有网卡上的 IPv4，去掉本机回环和 169.254.x.x（没连上的网卡自己分的地址）。
 * hello、二维码、mDNS 都用它（包括 Tailscale 的 100.x、虚拟机网卡的地址：App 挨个试，对不上证书的不用）
 */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.') && !out.includes(a.address)) out.push(a.address);
  return out;
}

interface MdnsRecord {
  type: string;
  data?: unknown;
}

/** 回答里只留这块网卡自己的 A 记录，不要 AAAA（局域网入口只监听 IPv4） */
export function onlyAddress<T extends MdnsRecord>(records: T[], address: string): T[] {
  return records.filter((r) => r.type !== 'AAAA' && (r.type !== 'A' || r.data === address));
}

/**
 * 每块网卡一个广播。只开一个（multicast-dns 的默认做法）时，回答从哪块网卡发出去由系统决定：
 * 装了 OpenVPN、VMware、Hyper-V 的 Windows 上常常发到虚拟网卡上，同一 Wi-Fi 下的手机收不到（2026-11-18 在真实网络里遇到）。
 * 所以按网卡分别开，各自只回答自己的地址（bonjour-service 默认把所有网卡的地址都放进回答，手机可能拿到虚拟网卡的地址），
 * TXT 里也带上这个地址（addr）。每 30 秒看一次网卡有没有变（换 Wi-Fi、DHCP 换了地址），变了重新广播。
 */
export class BonjourAdvertiser implements Advertiser {
  private running: { bonjour: Bonjour; service: Service }[] = [];
  private info: AdvertiseInfo | null = null;
  private published = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onError: (err: Error) => void,
    private readonly addresses: () => string[] = () => lanAddresses(),
  ) {}

  start(info: AdvertiseInfo): void {
    this.info = info;
    this.publish();
    if (!this.timer) {
      this.timer = setInterval(() => this.refresh(), 30_000);
      this.timer.unref();
    }
  }

  private refresh(): void {
    if (this.info && this.addresses().join(',') !== this.published) this.publish();
  }

  private publish(): void {
    this.unpublish();
    const info = this.info;
    if (!info) return;
    const addresses = this.addresses();
    this.published = addresses.join(',');
    for (const address of addresses) {
      // 不给 errorCallback 的话 bonjour-service 遇到错误直接 throw；multicast-dns 的 socket 错误（EADDRINUSE / EACCES）它也没接，要自己接
      // bonjour-service 把第一个参数原样交给 multicast-dns（它的类型声明没写这两项）：在这块网卡上收发，socket 绑 0.0.0.0（Linux 上绑网卡地址收不到组播）
      const mdns = { interface: address, bind: '0.0.0.0' } as unknown as ConstructorParameters<typeof Bonjour>[0];
      const bonjour = new Bonjour(mdns, (err: Error) => this.onError(err));
      (bonjour as unknown as { server: { mdns: EventEmitter } }).server.mdns.on('error', (err: Error) => this.onError(err));
      // 实例名在局域网里要唯一：两台电脑同名时也不冲突（App 显示的是 TXT 里的 name）。
      // 不探测重名：几块网卡上发的是同一个名字，本机组播回环会让它们互相当成重名
      const service = bonjour.publish({
        name: `${info.name} (${info.serverId.slice(0, 6)})`,
        type: SERVICE_TYPE,
        protocol: 'tcp',
        port: info.port,
        probe: false,
        disableIPv6: true,
        txt: { id: info.serverId, v: String(info.protocol), name: info.name, addr: address },
      });
      const records = service.records.bind(service);
      service.records = () => onlyAddress(records(), address);
      service.on('error', (err: Error) => this.onError(err));
      this.running.push({ bonjour, service });
    }
  }

  private unpublish(): void {
    const running = this.running;
    this.running = [];
    for (const { bonjour, service } of running) {
      // 先发「下线」再关 socket
      const close = () => bonjour.destroy();
      if (service.stop) service.stop(close);
      else close();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.info = null;
    this.published = '';
    this.unpublish();
  }
}

/** 真实网络：bonjour 广播，https 监听所有网卡（IPv4） */
export const REAL_LAN_NETWORK: LanNetwork = {
  advertiser: (onError) => new BonjourAdvertiser(onError),
  async listen(app, port) {
    await app.listen({ host: '0.0.0.0', port });
  },
};
