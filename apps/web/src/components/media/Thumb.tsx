import type { ContentKind, FocusPoint, ImageItem, ThumbWidth } from '@emaki/shared';
import { EyeOff } from 'lucide-react';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { imageUrl } from '@/lib/api';
import { useImageRetry } from '@/lib/connection';
import { cn } from '@/lib/cn';
import { blurLabel, blurReason, type BlurContext } from '@/lib/blur';
import { useBlurPrefs, usePrefs } from '@/lib/stores';
import { useCoverPosition } from './useCoverPosition';

/** kind 只给逐张的图传（照片、文字按偏好模糊）；封面、头像不传，只按分级 */
type ThumbSource = Pick<ImageItem, 'id' | 'dominantColor' | 'rating'> & Partial<Pick<ImageItem,'modifiedAt'>> & { kind?: ContentKind | null };

/**
 * 模糊时的标记放哪（MG-4）：
 * - center：中间一枚（容器宽 ≥ 240px 时是「眼睛 + 分级名」胶囊，更窄时是圆点，< 72px 不画）
 * - corner：右上角小圆标，网格里用（RV-A-13：选择圈左上、类型标记左下、收藏右下）
 * - none：不画，扇形侧卡、头像用
 */
export type BlurBadge = 'center' | 'corner' | 'none';

/** 模糊半径按缩略图尺寸定：小图糊得轻一点，大图要更重才看不清 */
const BLUR_BY_WIDTH: Record<ThumbWidth, string> = {
  240: 'blur-[8px]',
  480: 'blur-[14px]',
  960: 'blur-[22px]',
};

/** 已经加载过的缩略图 URL：再次挂载时直接显示，不重播淡入（SEL-13） */
const loadedUrls = new Set<string>();

/**
 * 缩略图：主色占位 → 淡入；按模糊策略（lib/blur.ts）模糊敏感分级、照片、文字图。
 * revealOnHover：外层有 group/reveal 时，打开「悬停时显示」偏好后停留 0.35 秒显示清晰图。
 * 所有显示插画的地方都用它，不要直接 <img src={imageUrl.thumb(...)}>。
 */
export function Thumb({
  image,
  width = 480,
  className,
  imgClassName,
  focus,
  alt = '',
  eager,
  blurBadge = 'center',
  /** 强制不模糊（看图器里点了「显示」之后） */
  revealed,
  revealOnHover = false,
  imgStyle,
  rated,
  blurContext = 'browse',
  original = false,
}: {
  image: ThumbSource;
  width?: ThumbWidth;
  className?: string;
  imgClassName?: string;
  /** 手动 object-position 或自动封面的原图主体坐标，0~1 */
  focus?: FocusPoint | null;
  alt?: string;
  eager?: boolean;
  blurBadge?: BlurBadge;
  revealed?: boolean;
  revealOnHover?: boolean;
  /** 追加到 img 的内联样式（object-fit、滚动翻看这类要精确控制过渡的场合） */
  imgStyle?: CSSProperties;
  /** 分级可信吗（识别过）；不传当作可信。和 blurContext 一起交给共用的 blurReason（附录 #30） */
  rated?: boolean;
  /** 展示场合（packages/shared 的 BlurContext）：cautious 时分级不可信就打码（没识别过的本子页，RV-C-12），角标写「未识别」 */
  blurContext?: BlurContext;
  /** 大幅展示时先用缩略图占位，原图解码完成后切换；失败时保留缩略图。 */
  original?: boolean;
}) {
  // 加载失败过的（电脑断开那一会儿），重新连上后换个地址重新加载（lib/connection.ts）
  const previewLoad = useImageRetry(imageUrl.thumb(image.id, width, image.modifiedAt));
  const fullLoad = useImageRetry(original ? imageUrl.file(image.id, image.modifiedAt) : '');
  const preview = previewLoad.src;
  const full = original ? fullLoad.src : null;
  const onFullError = fullLoad.onError;
  const [decoded, setDecoded] = useState<string | null>(null);
  const src = full && decoded === full ? full : preview;
  useEffect(() => {
    if (!full) return;
    let cancelled = false;
    const loader = new Image();
    loader.decoding = 'async';
    loader.onload = () => {
      void loader.decode().then(() => {
        if (!cancelled) setDecoded(full);
      }).catch(() => { /* The thumbnail remains visible if full-image decoding fails. */ });
    };
    loader.onerror = () => {
      if (!cancelled) onFullError();
    };
    loader.src = full;
    return () => { cancelled = true; loader.onload = null; loader.onerror = null; loader.removeAttribute('src'); };
  }, [full, onFullError]);
  const crop = useCoverPosition(focus, src);
  const [loaded, setLoaded] = useState(() => loadedUrls.has(src));
  const prefs = useBlurPrefs();
  const hoverPref = usePrefs((s) => s.revealOnHover);
  // 能否不打码只有一套判断（packages/shared 的 blurReason）；分级不可信时原因是 unrated，角标写「未识别」
  const reason = revealed ? null : blurReason({ rating: image.rating, kind: image.kind, rated }, prefs, blurContext);
  const blurred = reason !== null;
  const reveal = blurred && revealOnHover && hoverPref;
  // 悬停显示：停 0.35 秒再变清晰，快速扫过不触发；必须用 blur-[0px]，blur-none 会让过渡跳变
  const revealImg = reveal && 'group-hover/reveal:scale-100 group-hover/reveal:blur-[0px] group-hover/reveal:saturate-100 group-hover/reveal:delay-[350ms]';
  const revealMark = reveal && 'group-hover/reveal:opacity-0 group-hover/reveal:delay-[350ms]';
  // 调用方给了定位类（absolute inset-0 等）就别再加 relative —— cn 不做类合并，两者冲突时谁生效看 CSS 顺序
  const positioned = /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className ?? '');

  const markLoaded = useCallback(() => {
    loadedUrls.add(src);
    setLoaded(true);
  }, [src]);
  // 浏览器缓存命中时 onLoad 可能在 React 挂上监听之前就触发了：挂载时检查一次 complete
  const imgRef = useCallback(
    (el: HTMLImageElement | null) => {
      crop.imageRef.current = el;
      if (el?.complete && el.naturalWidth > 0) markLoaded();
    },
    [markLoaded, crop.imageRef],
  );

  return (
    <div
      ref={crop.frameRef}
      className={cn(!positioned && 'relative', 'overflow-hidden', blurred && blurBadge === 'center' && '@container', className)}
      style={{ backgroundColor: image.dominantColor }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onLoad={markLoaded}
        onError={src === preview ? previewLoad.onError : fullLoad.onError}
        className={cn(
          // Tailwind v4 的 scale-* 用的是独立的 scale 属性，不是 transform，所以过渡列表里要写 scale
          'size-full object-cover transition-[opacity,filter,scale] duration-500 ease-[var(--ease-out-soft)]',
          loaded ? 'opacity-100' : 'opacity-0',
          // 模糊时放大一点，把羽化的边推出容器外，底下垫的是图片主色，不会透出灰边（CB-B5）
          blurred && ['scale-[1.18] saturate-150', BLUR_BY_WIDTH[width]],
          // 模糊时不追加调用方的悬停放大：会盖掉 scale-[1.18]、露出灰边（背景层要自带重模糊的传 revealed）
          !blurred && imgClassName,
          revealImg,
        )}
        style={focus || imgStyle ? { ...(focus ? { objectPosition: crop.position } : {}), ...imgStyle } : undefined}
      />
      {blurred && blurBadge === 'center' && (
        <div className={cn('pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300 @max-[72px]:hidden', revealMark)}>
          <span className="flex size-8 items-center justify-center rounded-full bg-black/25 text-white/90 backdrop-blur-sm @min-[240px]:hidden">
            <EyeOff className="size-4" />
          </span>
          <span className="hidden h-7 items-center gap-1.5 rounded-full bg-black/30 px-3 text-[11.5px] font-medium text-white/90 backdrop-blur-sm @min-[240px]:inline-flex">
            <EyeOff className="size-3.5" />
            {blurLabel(reason, image.rating)}
          </span>
        </div>
      )}
      {blurred && blurBadge === 'corner' && (
        <span
          className={cn(
            'pointer-events-none absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/35 text-white/90 transition-opacity duration-300',
            revealMark,
          )}
        >
          <EyeOff className="size-3" />
        </span>
      )}
    </div>
  );
}
