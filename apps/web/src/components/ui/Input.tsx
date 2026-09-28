import { Search, X } from 'lucide-react';
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leading?: ReactNode;
  trailing?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** 显示清除按钮 */
  onClear?: () => void;
}

const sizes = {
  sm: 'h-8 text-[13px] rounded-sm',
  md: 'h-9 text-sm rounded-md',
  lg: 'h-11 text-[15px] rounded-full',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leading, trailing, size = 'md', onClear, className, value, ...rest },
  ref,
) {
  return (
    <label
      className={cn(
        'group flex items-center gap-2 bg-sunken px-3 text-fg transition-[box-shadow,background-color] duration-150',
        'focus-within:bg-raised focus-within:shadow-[0_0_0_1px_var(--c-line-strong),0_0_0_4px_var(--c-shu-soft)]',
        sizes[size],
        size === 'lg' && 'px-4',
        className,
      )}
    >
      {leading && <span className="flex shrink-0 text-fg-subtle [&_svg]:size-4">{leading}</span>}
      <input
        ref={ref}
        value={value}
        className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-subtle"
        {...rest}
      />
      {onClear && value ? (
        <button
          type="button"
          aria-label="清除"
          onClick={onClear}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
      {trailing}
    </label>
  );
});

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(function SearchInput(props, ref) {
  return <Input ref={ref} leading={<Search />} type="search" {...props} />;
});
