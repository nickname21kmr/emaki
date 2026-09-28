import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { assertRecyclable } from './driveType.ts';
import { chunkPaths, moveToRecycleBin } from './recycleBin.ts';

describe('chunkPaths', () => {
  it('按长度和个数分块', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `C:/${String(i).padStart(3, '0')}${'x'.repeat(596)}`);
    const chunks = chunkPaths(paths);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50);
      expect(c.reduce((s, p) => s + p.length + 3, 0)).toBeLessThanOrEqual(28_000);
    }
    expect(chunks.flat()).toEqual(paths);
    expect(chunkPaths([])).toEqual([]);
  });
});

describe('moveToRecycleBin（假 impl，不碰真回收站）', () => {
  const dir = makeTmpDir('trash');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => {
      const p = path.join(dir, `${prefix}-${i}.png`);
      writeFileSync(p, 'x');
      return p;
    });

  it('impl 静默不删 → 全部 failed；glob 为 false', async () => {
    const fs = files(3, 'a');
    let opts: unknown;
    const r = await moveToRecycleBin(fs, async (_p, o) => {
      opts = o;
    });
    expect(r.failed.length).toBe(3);
    expect(opts).toEqual({ glob: false });
  });

  it('删掉一半 → trashed / failed 各一半；不存在的 → alreadyGone', async () => {
    const fs = files(4, 'b');
    const r = await moveToRecycleBin([...fs, path.join(dir, 'nope.png')], async (p) => {
      for (const x of p.slice(0, 2)) await rm(x);
    });
    expect([r.trashed.length, r.failed.length, r.alreadyGone.length]).toEqual([2, 2, 1]);
    expect(existsSync(fs[3]!)).toBe(true);
  });
});

describe('assertRecyclable', () => {
  it('网络路径拒绝', async () => {
    await expect(assertRecyclable('//nas/share')).rejects.toThrow('没有回收站');
    await expect(assertRecyclable('\\nas\share')).rejects.toThrow('没有回收站');
  });
  it('本机 C: 通过', async () => {
    await expect(assertRecyclable('C:/Users')).resolves.toBeUndefined();
  });
});
