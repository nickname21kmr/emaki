import { useEffect, useRef, useState } from 'react';
import { SearchInput } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 图库搜索框：本地即时回显，停顿 250ms 后才写进 URL（?q=），避免每个字都触发请求。
 * URL 从外部变化（比如在看图器里点了标签）时同步回输入框。
 */
export function GallerySearch({
  value,
  onCommit,
  className,
}: {
  value: string;
  onCommit: (q: string) => void;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // 父组件每次渲染都会给新的 onCommit，放 ref 里，免得防抖计时被无关的重渲染打断
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  // 自己刚提交的值回流到 URL 时不要覆盖输入框（用户可能已经接着打了几个字）
  const lastCommitted = useRef(value);
  const commit = (q: string) => {
    lastCommitted.current = q;
    commitRef.current(q);
  };

  useEffect(() => {
    if (value === lastCommitted.current) return;
    lastCommitted.current = value;
    setText(value);
  }, [value]);

  useEffect(() => {
    const q = text.trim();
    if (q === value) return;
    const t = window.setTimeout(() => commit(q), 250);
    return () => window.clearTimeout(t);
    // commit 只读 ref，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, value]);

  return (
    <SearchInput
      ref={inputRef}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClear={() => {
        setText('');
        commit('');
        inputRef.current?.focus();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(text.trim());
        if (e.key === 'Escape') {
          // 第一次 Esc 清空，第二次失焦，别让它冒泡去清空多选
          e.stopPropagation();
          if (text) {
            setText('');
            commit('');
          } else {
            inputRef.current?.blur();
          }
        }
      }}
      placeholder="搜索角色、作品、标签或文件名"
      aria-label="搜索角色、作品、标签或文件名"
      // 隐藏浏览器自带的清除叉，只留 Input 自己的
      className={cn('rounded-full! [&_input::-webkit-search-cancel-button]:appearance-none', className)}
    />
  );
}
