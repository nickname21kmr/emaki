import { useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Emaki 的徽记「相角徽环」：圆环 + 四向相角刻度 + 三张照片扇形叠放（参考碧蓝档案校徽的单色线条徽章）。
 * 没有底色块，线条用 currentColor——默认 text-brand，跟着底色（data-palette）和明暗切换。
 * size ≤ 16 时换成简化版（圆环、刻度、一张照片），小图标也看得清。
 * spin：悬停时外环和刻度转 45°（侧栏 Logo 用），照片不动。
 */
export function Emblem({ size = 40, spin = false, className }: { size?: number; spin?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const small = size <= 16;
  const ring = cn('origin-center transition-transform duration-700 ease-[var(--ease-spring)] [transform-box:view-box]', spin && 'group-hover:rotate-45');
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0 text-brand', className)}
    >
      {small ? (
        <>
          <g className={ring}>
            <circle cx="32" cy="32" r="21" strokeWidth="6" />
            <path d="M32 2 L39 10 L25 10 Z M32 62 L39 54 L25 54 Z M2 32 L10 25 L10 39 Z M62 32 L54 25 L54 39 Z" fill="currentColor" strokeWidth="1" />
          </g>
          <rect x="23.5" y="21" width="17" height="22" rx="2.5" strokeWidth="5" />
        </>
      ) : (
        <>
          <mask id={`${id}-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
            <rect width="64" height="64" fill="#fff" />
            <rect x="23.4" y="21.4" width="17.2" height="22.2" rx="2.8" fill="#000" />
          </mask>
          <g className={ring}>
            <circle cx="32" cy="32" r="22.5" strokeWidth="3" />
            <path
              d="M32 3.8 L35.6 8.4 L28.4 8.4 Z M32 60.2 L35.6 55.6 L28.4 55.6 Z M3.8 32 L8.4 28.4 L8.4 35.6 Z M60.2 32 L55.6 28.4 L55.6 35.6 Z"
              fill="currentColor"
              strokeWidth="1.2"
            />
          </g>
          <g mask={`url(#${id}-cut)`} strokeWidth="2.4">
            <rect x="20.6" y="21.5" width="13" height="17" rx="1.8" transform="rotate(-16 27 30)" />
            <rect x="30.4" y="21.5" width="13" height="17" rx="1.8" transform="rotate(16 37 30)" />
          </g>
          <rect x="25" y="23" width="14" height="19" rx="1.8" strokeWidth="2.4" />
          <path d="M27.6 37.8 L31 33.9 L33.4 36.2 L35 34.8 L36.8 37.8" strokeWidth="2" />
          <circle cx="34.8" cy="28.2" r="1.5" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

/** 浏览器标签页图标：简化版徽记，颜色取当前底色的品牌色（ThemeSync 在底色 / 明暗变化时更新） */
export function faviconSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="21" stroke-width="6"/><path d="M32 2 L39 10 L25 10 Z M32 62 L39 54 L25 54 Z M2 32 L10 25 L10 39 Z M62 32 L54 25 L54 39 Z" fill="${color}" stroke-width="1"/><rect x="23.5" y="21" width="17" height="22" rx="2.5" stroke-width="5"/></svg>`;
}
