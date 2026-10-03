import { afterEach, describe, expect, it } from 'vitest';
import { PoolUnavailableError, PreprocessPool } from '../preprocessPool.ts';

const FAKE = new URL('./fixtures/fakePreprocessWorker.mjs', import.meta.url);
let pool: PreprocessPool | null = null;
const make = (size = 2) => (pool = new PreprocessPool(size, () => {}, FAKE));
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe('PreprocessPool', () => {
  it('正常返回数组，错误按口径返回', async () => {
    const p = make();
    const ok = await p.run('x', 'a.png');
    expect(ok.ok && Array.from(ok.data)).toEqual([1, 2, 3]);
    expect(await p.run('x', 'missing')).toMatchObject({ ok: false, code: 'ENOENT' });
  });

  it('一个线程崩了：它手上的图 reject PoolUnavailableError（交回主线程重做），换新线程后照常工作', async () => {
    const p = make(1);
    const slow = p.run('x', 'slow:300');
    const crash = p.run('x', 'crash');
    await expect(crash).rejects.toBeInstanceOf(PoolUnavailableError);
    await expect(slow).rejects.toBeInstanceOf(PoolUnavailableError);
    expect(p.available).toBe(true);
    const after = await p.run('x', 'b.png');
    expect(after.ok).toBe(true);
  });

  it('反复崩溃后关掉线程池，之后直接 reject，不会卡住', async () => {
    const p = make(1);
    for (let i = 0; i < 3; i++) await expect(p.run('x', 'crash')).rejects.toBeInstanceOf(PoolUnavailableError);
    expect(p.available).toBe(false);
    await expect(p.run('x', 'c.png')).rejects.toBeInstanceOf(PoolUnavailableError);
  });

  it('关闭时手上的图 reject，不会永远等着', async () => {
    const p = make(1);
    const pending = expect(p.run('x', 'slow:2000')).rejects.toBeInstanceOf(PoolUnavailableError);
    await p.close();
    await pending;
  });

  it('工作线程脚本起不来：降级成不可用，不抛到外面', async () => {
    const p = (pool = new PreprocessPool(1, () => {}, new URL('./fixtures/does-not-exist.mjs', import.meta.url)));
    await expect(p.run('x', 'a.png')).rejects.toBeInstanceOf(PoolUnavailableError);
  });
});
