import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 翻页、缩放只有一份实现（docs/FRONTEND.md「播放器」）：左右滑翻一张、捏合缩放、双击的判定只在 lib/pager 里用。
 * 别的地方要这些手感就用 usePager / useTouchZoom，不在页面里另写一套（不然改手感、以后的 mod 都要改好几处）。
 */
describe('播放器的翻页和缩放只在 lib/pager', () => {
  const SRC = path.resolve(import.meta.dirname, '../..');
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  // 翻页（滑动的阈值、跟手的阻尼、速度）和缩放（捏合、双击）的判定
  const PAGING_OR_ZOOM = /\b(swipeDecision|swipeOffset|pinchZoom|isDoubleTap|velocityOf|pushSample|zoomAround|clampPan)\b/;

  it('lib/gestures.ts 里翻页、缩放的判定只有 lib/pager 用（看图器的鼠标缩放用 zoom.ts 的 zoomAround、clampPan）', () => {
    const offenders = sources(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .filter((f) => !f.startsWith('lib/pager/') && f !== 'lib/gestures.ts')
      .filter((f) => PAGING_OR_ZOOM.test(readFileSync(path.join(SRC, f), 'utf8')))
      // 看图器的鼠标滚轮缩放、拖动平移是它自己的（阅读器没有鼠标缩放），用的是 zoom.ts 的数学
      .filter((f) => f !== 'components/media/lightbox/Stage.tsx' || /\b(swipeDecision|swipeOffset|pinchZoom|isDoubleTap|velocityOf|pushSample)\b/.test(readFileSync(path.join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
