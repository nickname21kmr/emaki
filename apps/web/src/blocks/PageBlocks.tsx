import { Fragment, type ReactNode } from 'react';
import { useDisabledBlocks } from '@/lib/plugins';
import { blocksOf, type BlockId, type PageId } from './registry';

/** 每个区块怎么画：页面把自己的状态、回调闭包进来；返回 null = 这次不显示（后面的章节编号自动前移） */
export type BlockRenderers<P extends PageId> = Record<BlockId<P>, () => ReactNode>;

/**
 * 按注册表（blocks/registry.ts）的顺序渲染一页里的区块。不加包裹元素：页面的布局（gap、章节编号的 CSS 计数器）和以前完全一样。
 * 属于停用的插件的区块（比如别册停用了，首页的别册目次）不画（docs/plugins.md 9.4）；
 * 以后的个人布局（隐藏、换顺序）也在这里按区块 id 处理，页面组件不用改
 */
export function PageBlocks<P extends PageId>({ page, region, render }: { page: P; region?: string; render: BlockRenderers<P> }) {
  const disabled = useDisabledBlocks();
  return (
    <>
      {blocksOf(page, region).filter((b) => !disabled.has(b.id)).map((b) => (
        <Fragment key={b.id}>{render[b.id as BlockId<P>]()}</Fragment>
      ))}
    </>
  );
}
