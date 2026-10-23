import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { qk } from '@/lib/queries';
import { claimEntrance } from '../viewState';

/** 助手里读单张图（结果图版、勘误缩略图、输入面缩略图）。不存在的图不重试，直接显示「已移除」 */
export const useAssistantImage = (id: string) =>
  useQuery({ queryKey: qk.image(id), queryFn: () => api.image(id), staleTime: 60000, retry: false });

/** 高度 0 ↔ auto 加淡入淡出：旁注、条目、详情、状态行、便笺退场共用（§15） */
export const COLLAPSE = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: DURATION.fast, ease: EASE_OUT },
} as const;

/** 这一条第一次出现时淡入（切会话后的第一份快照不播，重新挂载不重播） */
export function useEntrance(sessionId: string, key: string) {
  const [enter] = useState(() => claimEntrance(sessionId, key));
  return enter;
}

/** 文字开关：「展开全文 / 收起」「查看详情」这类 */
export function TextToggle({ open, onClick, className, children, controls }: { open?: boolean; onClick: () => void; className?: string; children: ReactNode; controls?: string }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={controls} onClick={onClick} className={cn('text-xs font-medium text-fg-muted underline-offset-4 hover:text-fg hover:underline', className)}>
      {children}
    </button>
  );
}

/** line-clamp 截住的块有没有超出（收着的时候量；展开后沿用上次的结果） */
export function useClamped<T extends HTMLElement>(clamped: boolean, content: unknown) {
  const ref = useRef<T>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !clamped) return;
    const check = () => setOver(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clamped, content]);
  return [ref, over] as const;
}

/** 代码块右上角的复制钮：平时隐藏，悬停或聚焦时出现；复制后 1.5 秒内显示勾 */
export function CopyButton({ text, className }: { text: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard?.writeText(text()).then(() => setCopied(true), () => { /* 没有剪贴板权限就算了 */ });
  };
  return (
    <IconButton
      size="sm"
      label={copied ? '已复制' : '复制'}
      onClick={copy}
      className={cn(
        'absolute top-1.5 right-1.5 bg-sunken opacity-0 group-hover/pre:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
        copied && 'opacity-100',
        className,
      )}
    >
      {copied ? <Check strokeWidth={1.8} /> : <Copy strokeWidth={1.8} />}
    </IconButton>
  );
}
