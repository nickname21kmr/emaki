import { describe, expect, it } from 'vitest';
import { TaggerCrashedError, type TaggerLike, type TaggerStartOptions } from '../client.ts';
import type { HostItemResult } from '../protocol.ts';
import { ResilientTagger } from '../tagJob.ts';

const OPTS: TaggerStartOptions = { repo: 'A1yCE/pixai-tagger-v1.0-onnx-fp16', modelPath: 'm', labelsPath: 'l', device: 'dml', batchSize: 1, modelsDir: 'x' };
const TH = { general: 0.35, character: 0.35 };
const okRes = (id: number): HostItemResult => ({ id, ok: true, rating: null, general: [], character: [] }) as unknown as HostItemResult;

/** 和真的 TaggerClient 一样：带着坏图的请求让子进程退出，在途和之后的请求立刻失败 */
function client(bad: number, delay = 5): TaggerLike {
  let dead = false;
  const waiting = new Set<(e: Error) => void>();
  return {
    device: 'dml',
    batchSize: 1,
    info: { type: 'ready', device: 'dml', dmlDeviceId: 0, fallbackReason: null, batchSize: 1, fixedBatch: true, inputName: 'i', inputShape: [], outputName: 'o', numLabels: 0, loadMs: 0, pid: 1 },
    tag: async (items) => {
      if (dead) throw new TaggerCrashedError('识别子进程已退出');
      await new Promise<void>((resolve, reject) => {
        const fail = (e: Error) => {
          clearTimeout(t);
          reject(e);
        };
        const t = setTimeout(() => {
          waiting.delete(fail);
          resolve();
        }, delay);
        waiting.add(fail);
      });
      if (dead) throw new TaggerCrashedError('识别子进程已退出');
      if (items.some((i) => i.id === bad)) {
        dead = true;
        const e = new TaggerCrashedError('识别子进程退出（3221225477）');
        for (const w of waiting) w(e);
        waiting.clear();
        throw e;
      }
      return items.map((i) => okRes(i.id));
    },
  };
}

describe('ResilientTagger', () => {
  it('坏图和 3 张好图同时在途：只有坏图被跳过，好图都正常返回', async () => {
    for (const order of [[1, 2, 3, 4], [2, 1, 3, 4], [4, 3, 2, 1], [2, 3, 4, 1]]) {
      const BAD = 1;
      let made = 0;
      const t = new ResilientTagger(client(BAD), OPTS, async () => (made++, client(BAD)), () => {});
      // 第一轮先成功几张，留下「识别成功过的图」
      for (const id of [10, 11, 12]) await t.tag([{ id, path: `p${id}` }], TH);
      const res = await Promise.all(order.map((id) => t.tag([{ id, path: `p${id}` }], TH)));
      const byId = new Map(res.flat().map((r) => [r.id, r]));
      expect(byId.get(BAD)).toMatchObject({ ok: false, code: 'DECODE' });
      for (const id of order.filter((x) => x !== BAD)) expect(byId.get(id)).toMatchObject({ ok: true });
      expect(made).toBeLessThanOrEqual(4);
    }
  });

  it('后面又来了一批好图（隔离中排在坏图后面）：都不会被误判', async () => {
    const BAD = 5;
    const t = new ResilientTagger(client(BAD), OPTS, async () => client(BAD), () => {});
    await t.tag([{ id: 100, path: 'p' }], TH);
    const all = await Promise.all([5, 6, 7, 8, 9, 10, 11, 12].map((id) => t.tag([{ id, path: `p${id}` }], TH)));
    const flat = all.flat();
    expect(flat.filter((r) => !r.ok).map((r) => r.id)).toEqual([BAD]);
  });
});
