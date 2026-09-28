import { describe, expect, it } from 'vitest';
import { autoKind, decideCollection, dirFeatures, orderPages, type DirPage } from './detect.ts';

interface Opts {
  names?: string[];
  w?: number | ((i: number) => number);
  h?: number | ((i: number) => number);
  kind?: string | ((i: number) => string);
  judged?: boolean;
}
function at<T>(v: T | ((i: number) => T), i: number): T {
  return typeof v === 'function' ? (v as (i: number) => T)(i) : v;
}
const pad = (i: number, n = 3) => String(i).padStart(n, '0');
const hex = (i: number, len: number) => ((i * 2654435761 + 0x9e3779b9) >>> 0).toString(16).padStart(8, '0').repeat(5).slice(0, len);
const uuid = (i: number) => {
  const h = hex(i, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function mk(n: number, o: Opts = {}): DirPage[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      id: 1000 + i,
      fileName: o.names?.[k] ?? `${pad(i)}.jpg`,
      width: at(o.w ?? 1200, k),
      height: at(o.h ?? 1700, k),
      modifiedAt: `2024-01-01T00:${pad(Math.floor(i / 60), 2)}:${pad(i % 60, 2)}.000Z`,
      kind: at(o.kind ?? 'illustration', k),
      judged: o.judged ?? false,
    };
  });
}

const run = (leaf: string, pages: DirPage[]) => {
  const f = dirFeatures(pages);
  const d = decideCollection(leaf, f);
  return d ? { ...d, ...autoKind(leaf, f, d.rule) } : null;
};
const names = (n: number, fn: (i: number) => string) => Array.from({ length: n }, (_, i) => fn(i));

describe('decideCollection + autoKind', () => {
  it('① 页码文件名的漫画本', () => {
    expect(run('Book', mk(20, { kind: 'comic', judged: true }))).toEqual({ rule: 'A', pageOrder: 'name', kind: 'doujin', source: 'pages' });
  });
  it('② uuid 名、统一版心 → B，暂按名字归本子，按修改时间排', () => {
    const pages = mk(30, { names: names(30, (i) => `${uuid(i)}.jpg`), w: 1280, h: (i) => 1818 + (i % 5) });
    expect(run('5c4fe8c847fa5e791d2d9189', pages)).toEqual({ rule: 'B', pageOrder: 'mtime', kind: 'doujin', source: 'name' });
  });
  it('③ 同上但是横版视频帧 → 不成册', () => {
    const pages = mk(30, { names: names(30, (i) => `${uuid(i)}.jpg`), w: 1920, h: 1080 });
    expect(run('5c4fe8c847fa5e791d2d9189', pages)).toBeNull();
  });
  it('④ 杂项目录名单', () => {
    expect(run('QQ_Images', mk(30))).toBeNull();
  });
  it('⑤ 截图页超过 20%', () => {
    const pages = mk(10, { names: names(10, (i) => `${i + 1}.png`), kind: (i) => (i < 3 ? 'screenshot' : 'illustration'), judged: true });
    expect(run('x', pages)).toBeNull();
  });
  it('⑥ 不足 8 页', () => {
    expect(run('Book', mk(7))).toBeNull();
  });
  it('⑦ 识别过的彩色插画本 → 画集', () => {
    expect(run('某画集', mk(12, { judged: true }))).toMatchObject({ rule: 'A', kind: 'artbook', source: 'pages' });
  });
  it('⑧ 同人志命名、未识别 → 暂归本子', () => {
    const pages = mk(12, { names: names(12, (i) => `${pad(i + 1, 2)}.jpg`) });
    expect(run('(C99) [社团 (作者)] 标题 (原作)', pages)).toMatchObject({ rule: 'A', kind: 'doujin', source: 'name' });
  });
  it('⑨ 下载目录：16 位 hex 名、尺寸各不相同 → 不成册', () => {
    const pages = mk(40, { names: names(40, (i) => `${hex(i, 16)}.jpg`), w: (i) => 800 + i * 37, h: (i) => 900 + i * 53 });
    expect(run('Download', pages)).toBeNull();
  });
  it('⑩ 含 6 页横向跨页的画集', () => {
    const pages = mk(14, { w: (i) => (i < 6 ? 3500 : 2480), h: (i) => (i < 6 ? 2470 : 3508), judged: true });
    expect(run('Book', pages)).toMatchObject({ rule: 'A', kind: 'artbook' });
  });
  it('⑪ 连载', () => {
    const pages = mk(20, { names: names(20, (i) => `${i + 1}.jpg`), kind: 'comic', judged: true });
    expect(run('某连载 第3话', pages)).toMatchObject({ rule: 'A', kind: 'doujin' });
  });
  it('⑫ 书名号里的画集名、随机文件名 → C', () => {
    const rand = ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst', 'uvwx', 'yzab', 'cdef', 'ghij', 'klmn'];
    expect(run('《某画集》', mk(10, { names: rand.map((x) => `${x}.jpg`) }))).toEqual({
      rule: 'C',
      pageOrder: 'mtime',
      kind: 'artbook',
      source: 'name',
    });
  });
  it('⑬ 类型来源是兜底但识别过，也算已判定（RV-C-1）', () => {
    expect(run('某本', mk(12, { judged: true }))).toMatchObject({ rule: 'A', kind: 'artbook', source: 'pages' });
  });
});

describe('orderPages', () => {
  it('按文件名：自然序，附页落到最后', () => {
    const input = ['0000-1.jpg', '0000.jpg', '0001.jpg', '10.jpg', '2.jpg', '招募.png', 'ScanImage10.jpg', 'ScanImage02.jpg'];
    expect(orderPages(mk(input.length, { names: input }), 'name').map((p) => p.fileName)).toEqual([
      '0000.jpg',
      '0000-1.jpg',
      '0001.jpg',
      '2.jpg',
      '10.jpg',
      'ScanImage02.jpg',
      'ScanImage10.jpg',
      '招募.png',
    ]);
  });
});
