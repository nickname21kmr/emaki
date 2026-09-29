import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { walkImages } from './walk.ts';

// 让某个文件的 stat 失败（模拟移动硬盘中途断开）；平时照常
const failing = vi.hoisted(() => ({ name: '' }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    stat: (p: Parameters<typeof real.stat>[0]) =>
      failing.name && String(p).endsWith(failing.name) ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : real.stat(p),
  };
});

let root: string;
const long = Array.from({ length: 6 }, (_, i) => `很长的目录名_${i}_${'x'.repeat(40)}`).join('/');

beforeAll(async () => {
  root = makeTmpDir('walk');
  const files: [string, string | Buffer][] = [
    ['a.png', 'x'],
    ['sub/b.jpg_large', 'x'],
    ['中文 目录/插画, 测试 [1].png', 'x'],
    [`deep/${long}/long.png`, 'x'],
    ['.hidden/secret.png', 'x'],
    ['$RECYCLE.BIN/x.png', 'x'],
    ['node_modules/y.png', 'x'],
    ['misc/readme.txt', 'x'],
    ['misc/empty.png', Buffer.alloc(0)],
  ];
  for (const [rel, data] of files) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), data);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const collect = async (o = {}) => {
  const out: string[] = [];
  for await (const e of walkImages(root.replace(/\\/g, '/'), o)) out.push(e.relPath);
  return out.sort();
};

it('跳过隐藏目录、回收站、node_modules、非图片和 0 字节文件，能列出中文和超长路径', async () => {
  expect(await collect()).toEqual(['a.png', `deep/${long}/long.png`, 'sub/b.jpg_large', '中文 目录/插画, 测试 [1].png'].sort());
});

it('非递归只列一层', async () => {
  expect(await collect({ recursive: false })).toEqual(['a.png']);
});

it('从子目录开始', async () => {
  expect(await collect({ startRel: 'sub' })).toEqual(['sub/b.jpg_large']);
});

it('读不了的目录交给 onDirError', async () => {
  const errors: string[] = [];
  for await (const _ of walkImages(root.replace(/\\/g, '/'), { startRel: 'no-such-dir', onDirError: (d) => errors.push(d) })) {
    /* 不会有文件 */
  }
  expect(errors).toEqual(['no-such-dir']);
});

it('列出来却读不到信息的文件：所在目录交给 onDirError（不能当成文件没了），其它文件照常', async () => {
  failing.name = 'a.png';
  const errors: string[] = [];
  const out: string[] = [];
  try {
    for await (const e of walkImages(root.replace(/\\/g, '/'), { onDirError: (d) => errors.push(d) })) out.push(e.relPath);
  } finally {
    failing.name = '';
  }
  expect(errors).toEqual(['']);
  expect(out).not.toContain('a.png');
  expect(out).toContain('sub/b.jpg_large');
});
