import { memo, useRef, type ComponentProps } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';
import type { AssistantMessage } from '@emaki/shared';
import { cn } from '@/lib/cn';
import { CopyButton } from './parts';

export interface ProseProps {
  message: AssistantMessage;
  className?: string;
}

const PROSE = cn(
  'space-y-2.5 text-[13.5px] leading-[1.75] break-words text-fg [&>:first-child]:mt-0 [&_p]:text-pretty',
  '[&_strong]:font-semibold',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:mt-4 [&_:is(h1,h2,h3,h4,h5,h6)]:text-[14px] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:tracking-tight',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_:is(ul,ol)]:pl-5 [&_li]:marker:text-fg-subtle [&_li+li]:mt-1',
  '[&_a]:text-fg [&_a]:underline [&_a]:decoration-line-strong [&_a]:underline-offset-[3px] hover:[&_a]:decoration-fg',
  // 暗色下 sunken 和纸几乎一样深，行内代码改用亮一档的 raised 才看得出底
  '[&_code]:rounded-[5px] [&_code]:bg-sunken [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] dark:[&_:not(pre)>code]:bg-raised',
  // 代码块里的 code 跟着 pre 的 11.5px，不吃行内代码的 12px
  '[&_pre]:overflow-x-auto [&_pre]:rounded-[10px] [&_pre]:bg-sunken [&_pre]:p-3 [&_pre]:text-[11.5px] [&_pre]:leading-relaxed [&_pre]:scrollbar-thin [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[length:inherit]',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-rule [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted',
  '[&_hr]:my-4 [&_hr]:border-line',
);

/** 代码块：右上角复制钮（复制的是 pre 里的纯文本） */
function Pre({ node: _node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group/pre relative">
      <pre ref={ref} {...props} />
      <CopyButton text={() => ref.current?.textContent ?? ''} />
    </div>
  );
}

const COMPONENTS: Components = {
  // 站内链接走路由，其余新窗口打开
  a: ({ href, children }) =>
    href?.startsWith('/') && !href.startsWith('//') ? <Link to={href}>{children}</Link> : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  img: ({ alt }) => <span className="text-fg-muted">[图：{alt || '图片'}]</span>,
  // 表格和结果卡的「表」同一种排法，宽了就横向滚
  table: ({ children }) => (
    <div className="-mx-1 overflow-x-auto px-1 scrollbar-thin">
      <table className="w-full border-collapse text-[12px] leading-snug">{children}</table>
    </div>
  ),
  th: ({ node: _node, className: _className, ...props }) => (
    <th {...props} className="border-b border-rule pr-3 pb-2 text-left text-[11px] font-semibold tracking-[0.08em] whitespace-nowrap text-fg-subtle last:pr-0" />
  ),
  td: ({ node: _node, className: _className, ...props }) => <td {...props} className="border-b border-line py-2 pr-3 align-top break-words tabular last:pr-0" />,
  pre: Pre,
};

/** 回答正文（§6.3）：Markdown，标题保持无衬线；流式输出时半截的 Markdown 照常渲染 */
export const Prose = memo(
  function Prose({ message, className }: ProseProps) {
    return (
      <div className={cn(PROSE, className)}>
        <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{message.text}</Markdown>
      </div>
    );
  },
  // SSE 每 100ms 推一次整份快照，正文没变就不重新解析
  (a, b) => a.message.id === b.message.id && a.message.text === b.message.text && a.className === b.className,
);
