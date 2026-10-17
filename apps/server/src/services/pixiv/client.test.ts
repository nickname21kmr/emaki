import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { PixivAccessError, PixivClient } from './client.ts';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => vi.mocked(sleep).mockReset().mockResolvedValue(undefined));
const ok = () => ({status:200,headers:{get:()=>null},text:async()=>JSON.stringify({error:false,body:{id:'123',pageCount:1,tags:{tags:[]}}})});

it.each([true,false])('保留独立的原创标记 %s，即使标签数组没有原创', async isOriginal => {
  const fetch=vi.fn().mockResolvedValue({...ok(),text:async()=>JSON.stringify({error:false,body:{id:'123',pageCount:2,isOriginal,tags:{tags:[{tag:'practice'}]}}})});
  expect((await new PixivClient(fetch).artwork('123',new AbortController().signal))?.isOriginal).toBe(isOriginal);
});

it('连接失败和超时退避 1、2 秒后恢复，每次请求使用新的超时信号', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockRejectedValueOnce(new DOMException('timeout','TimeoutError')).mockResolvedValue(ok());
  const signal = new AbortController().signal;
  expect((await new PixivClient(fetch).artwork('123',signal))?.id).toBe('123');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(vi.mocked(sleep).mock.calls.map(c=>c[0])).toEqual([1000,2000]);
  expect(new Set(fetch.mock.calls.map(c=>c[1].signal)).size).toBe(3);
});

it('响应体断开也重试，与 5xx 共用最多三次请求的预算', async () => {
  const error = new Error('body disconnected');
  const fetch=vi.fn().mockResolvedValueOnce({...ok(),status:503})
    .mockResolvedValue({...ok(),text:async()=>{throw error;}});
  await expect(new PixivClient(fetch).artwork('123',new AbortController().signal)).rejects.toBe(error);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(vi.mocked(sleep).mock.calls.map(c=>c[0])).toEqual([1000,2000]);
});

it('请求期间取消不会重试', async () => {
  const c=new AbortController();
  const fetch=vi.fn().mockImplementation(async()=>{c.abort();throw new Error('connection closed');});
  await expect(new PixivClient(fetch).artwork('123',c.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it('退避期间取消不会再发请求', async () => {
  const c=new AbortController();
  vi.mocked(sleep).mockImplementationOnce(async (_ms,_value,options)=>{
    expect(options?.signal).toBe(c.signal);
    c.abort();
    throw c.signal.reason;
  });
  const fetch=vi.fn().mockRejectedValue(new Error('offline'));
  await expect(new PixivClient(fetch).artwork('123',c.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([401,403,429])('访问限制 %i 不重试', async status => {
  const fetch=vi.fn().mockResolvedValue({...ok(),status});
  await expect(new PixivClient(fetch).artwork('123',new AbortController().signal)).rejects.toBeInstanceOf(PixivAccessError);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it('JSON 或字段错误不当成网络故障反复请求', async () => {
  for(const text of ['not json',JSON.stringify({error:false,body:{id:'123'}})]) {
    const fetch=vi.fn().mockResolvedValue({...ok(),text:async()=>text});
    await expect(new PixivClient(fetch).artwork('123',new AbortController().signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  expect(sleep).not.toHaveBeenCalled();
});

it('200 业务错误不能当成明确404缓存', async () => {
  const fetch=vi.fn().mockResolvedValue({...ok(),text:async()=>JSON.stringify({error:true,body:null})});
  await expect(new PixivClient(fetch).artwork('123',new AbortController().signal)).rejects.toThrow('业务错误');
});
