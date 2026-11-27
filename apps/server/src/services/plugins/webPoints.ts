/**
 * 网页的内部点（@emaki/shared 的 WEB_POINTS，docs/plugins.md 第 7 节）在服务端的登记：补丁在网页上加，这里只为了查有没有、算指纹。
 * 指纹按点所在的源文件（apps/web/src 下）的内容算：文件改了就算这个点变了（比只看那个组件粗，但不会漏）。
 * 读不到源文件（只发了打包好的网页）时只按名字和版本号算。换行统一成 \n（Windows 上签出的是 \r\n）。
 */
import { WEB_POINTS, pointKind } from '@emaki/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Points } from '../../core/points.ts';

/** 网页的源码（仓库里的 apps/web/src） */
export const WEB_SRC_DIR = path.resolve(import.meta.dirname, '../../../../web/src');

const NOOP = () => {};

export function defineWebPoints(points: Points, srcDir = WEB_SRC_DIR): void {
  for (const p of WEB_POINTS) {
    const file = path.join(srcDir, ...p.file.split('/'));
    points.define(
      p.name,
      {
        kind: pointKind(p.name)!,
        label: p.label,
        version: p.version,
        signature: () => {
          try {
            return `${p.file}\n${readFileSync(file, 'utf8').replace(/\r\n/g, '\n')}`;
          } catch {
            return p.file;
          }
        },
      },
      NOOP,
    );
  }
}
