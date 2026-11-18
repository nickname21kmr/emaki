/**
 * mDNS 广播按网卡分开（access/discovery.ts）：只开一个时回答从哪块网卡发出去由系统决定，装了 OpenVPN、VMware、Hyper-V 的 Windows
 * 上常常发到虚拟网卡上，手机收不到；回答里也只留这块网卡自己的地址。
 */
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { lanAddresses, onlyAddress } from '../../src/access/discovery.ts';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;
const v6 = (address: string) => ({ address, family: 'IPv6', internal: false }) as NetworkInterfaceInfo;

describe('能让手机连过来的地址', () => {
  it('所有网卡上的 IPv4，去掉回环、169.254.x.x、IPv6 和重复的', () => {
    const ifaces = {
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      '以太网 4': [v6('fe80::1'), v4('192.168.0.100')],
      'OpenVPN TAP-Windows6': [v4('169.254.18.139')],
      'VMware Network Adapter VMnet8': [v4('192.168.2.1')],
      'vEthernet (Default Switch)': [v4('172.21.32.1'), v4('192.168.0.100')],
      Tailscale: [v4('100.101.102.103')],
    };
    expect(lanAddresses(ifaces)).toEqual(['192.168.0.100', '192.168.2.1', '172.21.32.1', '100.101.102.103']);
  });
});

describe('回答里只留这块网卡的地址', () => {
  it('留下 PTR、SRV、TXT 和这块网卡的 A 记录，去掉别的网卡的 A 记录和全部 AAAA', () => {
    const records = [
      { type: 'PTR', data: 'x._emaki._tcp.local' },
      { type: 'SRV', data: { port: 5175 } },
      { type: 'TXT', data: [] },
      { type: 'A', data: '192.168.0.100' },
      { type: 'A', data: '192.168.2.1' },
      { type: 'AAAA', data: 'fe80::1' },
    ];
    expect(onlyAddress(records, '192.168.0.100').map((r) => `${r.type} ${typeof r.data === 'string' ? r.data : ''}`.trim())).toEqual([
      'PTR x._emaki._tcp.local',
      'SRV',
      'TXT',
      'A 192.168.0.100',
    ]);
  });
});
