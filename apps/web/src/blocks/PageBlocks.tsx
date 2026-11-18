import { Fragment, type ReactNode } from 'react';
import { blocksOf, type BlockId, type PageId } from './registry';

/** 每个区块怎么画：页面把自己的状态、回调闭包进来；返回 null = 这次不显示（后面的章节编号自动前移） */
export type BlockRenderers<P extends PageId> = Record<BlockId<P>, () => ReactNode>;

/**
 * 按注册表（blocks/registry.ts）的顺序渲染一页里的区块。不加包裹元素：页面的布局（gap、章节编号的 CSS 计数器）和以前完全一样。
 * 以后的个人布局（隐藏、换顺序）在这里按区块 id 处理，页面组件不用改
 */
export function PageBlocks<P extends PageId>({ page, region, render }: { page: P; region?: string; render: BlockRenderers<P> }) {
  return (
    <>
      {blocksOf(page, region).map((b) => (
        <Fragment key={b.id}>{render[b.id as BlockId<P>]()}</Fragment>
      ))}
    </>
  );
}
