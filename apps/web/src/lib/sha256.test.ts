import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex, sha256, sha256Sync, toHex } from './sha256';

const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('sha256：纯 JS 的退路（非安全上下文里没有 crypto.subtle）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('标准测试向量', () => {
    expect(toHex(sha256Sync(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256Sync(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('补位的边界长度（55、56、63、64、65、119、120 字节）和较长的随机数据都和 node:crypto 一样', () => {
    for (const n of [1, 31, 32, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4099]) {
      const b = new Uint8Array(randomBytes(n));
      expect([n, toHex(sha256Sync(b))]).toEqual([n, nodeSha(b)]);
    }
  });

  it('没有 crypto.subtle 时 sha256() 退回纯 JS，结果一样', async () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    expect(globalThis.crypto.subtle).toBeUndefined();
    const b = new Uint8Array(randomBytes(77));
    expect(toHex(await sha256(b))).toBe(nodeSha(b));
  });

  it('subtle 调用失败时也退回纯 JS', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('NotSupported')) } });
    const b = new Uint8Array(randomBytes(40));
    expect(toHex(await sha256(b))).toBe(nodeSha(b));
  });

  it('有 subtle 时用它（带偏移的视图也对）', async () => {
    const big = new Uint8Array(randomBytes(64));
    const view = big.subarray(8, 40);
    expect(toHex(await sha256(view))).toBe(nodeSha(view));
  });

  it('hex 来回转换；不是 hex 的报错', () => {
    const b = new Uint8Array(randomBytes(32));
    expect(fromHex(toHex(b))).toEqual(b);
    expect(fromHex('00ff7A')).toEqual(new Uint8Array([0, 255, 122]));
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });
});
