import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sheetFollow, sheetRelease } from './useSheetDrag';

describe('底部面板的拖动（useSheetDrag）', () => {
  it('往下 1:1 跟手；往上能展开时带阻尼，不能时不动', () => {
    expect(sheetFollow(80, false)).toBe(80);
    expect(sheetFollow(-40, true)).toBe(-10);
    expect(sheetFollow(-40, false)).toBe(0);
  });

  it('松手：过了距离或甩得够快就收起，往上拉能展开时展开，否则弹回', () => {
    // 面板 400 高：距离阈值 min(140, 400×0.15) = 60
    expect(sheetRelease(70, 0.1, 400, false)).toBe('close');
    expect(sheetRelease(30, 0.1, 400, false)).toBe('stay');
    expect(sheetRelease(30, 0.8, 400, false)).toBe('close');
    expect(sheetRelease(-30, 0.8, 400, true)).toBe('expand');
    expect(sheetRelease(-30, 0.8, 400, false)).toBe('stay');
  });
});

/**
 * 「往下拖收起」只有一份（docs/FRONTEND.md「交互只有一个实现」）：底部面板都用 useSheetDrag。
 * 看图器整张下滑关闭是播放器的事（lib/pager 的 vertical，Stage.tsx 里接 dragDecision），不算面板。
 */
it('dragDecision 只有 useSheetDrag 和看图器的下滑关闭用', () => {
  const SRC = path.resolve(import.meta.dirname, '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  const allowed = ['lib/gestures.ts', 'lib/useSheetDrag.ts', 'components/media/lightbox/Stage.tsx'];
  const users = sources(SRC)
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .filter((f) => /\bdragDecision\b/.test(readFileSync(path.join(SRC, f), 'utf8')));
  expect(users.filter((f) => !allowed.includes(f))).toEqual([]);
});
