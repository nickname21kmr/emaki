import type { ThumbWidth } from '@emaki/shared';

/**
 * 网格格子按实际像素宽度（CSS 宽度 × 屏幕缩放）选缩略图档位。
 *
 * 留了余量：480 那档最多放大到 1.5 倍，240 最多 1.2 倍。不留余量的话，缩放 125–150% 的屏幕上稍宽一点的格子就跳到 960，
 * 而 960 平时不预先生成（后台只补 480 和 240），要当场解原图现做，比旁边的格子晚几百毫秒才出来。
 * 重复页对比细节要清晰，那边不走这里（features/duplicates 的 DuplicateTile）。
 */
export function gridThumbTier(cssWidth: number, dpr: number): ThumbWidth {
  const px = cssWidth * (dpr || 1);
  return px > 720 ? 960 : px > 288 ? 480 : 240;
}
