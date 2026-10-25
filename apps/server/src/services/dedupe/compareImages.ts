/** Fine comparison of candidate originals: perceptual pixel gate and local RGB structural verification. */
import { readFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import type { Sharp } from 'sharp';
import { decodeBmp } from '../image/bmp.ts';
import { sharp } from '../image/sharpConfig.ts';
import { localStructure } from './localStructure.ts';

// Bump when preprocessing or decision limits change: cached decisions must be recomputed.
export const COMPARISON_VERSION = 'pixelmatch8-ssim3-v4';
export const COMPATIBLE_PIXEL_VERSION = 'pixelmatch-8-v1';
export const COMPARISON_LIMITS = {
  // Calibrated on resized/recompressed library samples; see docs/duplicate-detection.md.
  colorThreshold: 0.15,
  maxDifferentFraction: 0.005,
  maxLocalDifference: 28,
  noiseSigma: 1,
  minLocalStructure: 0.6,
} as const;
const MAX_EDGE = 1024;
const MAX_EXACT_PIXELS = 32 * 1024 * 1024;

export interface ImageComparison {
  match: 'pixels' | 'visual' | null;
  differentFraction: number;
  /** Worst 4x4 mean of the RGB SSIM map; absent when the pixel gate already rejected the pair. */
  localStructure?: number;
  maxLocalDifference?: number;
}

/** Both Pixelmatch gates and full-size equality are unchanged; SSIM only narrows acceptance. */
export function compatibleDecision(old: ImageComparison): ImageComparison | null {
  if (old.match === 'pixels') return { match: 'pixels', differentFraction: 0, localStructure: 1 };
  if (old.match === null) return { match: null, differentFraction: old.differentFraction, ...(old.maxLocalDifference === undefined ? {} : { maxLocalDifference: old.maxLocalDifference }) };
  return null;
}

async function open(file: string): Promise<Sharp> {
  // A truncated file must not become a duplicate of another truncated decode.
  if (/\.bmp$/i.test(file)) {
    const raw = decodeBmp(await readFile(file));
    if (!raw) throw new Error('不支持的 BMP 变体');
    return sharp(raw.data, { raw });
  }
  return sharp(file, { failOn: 'error', limitInputPixels: 500_000_000 }).autoOrient();
}

/** No first-frame comparison: animations with the same cover can have different remaining frames. */
export async function compareImages(aFile: string, bFile: string): Promise<ImageComparison> {
  const noMatch: ImageComparison = { match: null, differentFraction: 1 };
  if (/\.html?$/i.test(aFile) || /\.html?$/i.test(bFile)) return noMatch;
  const [a, b] = await Promise.all([open(aFile), open(bFile)]);
  const [am, bm] = await Promise.all([a.metadata(), b.metadata()]);
  if ((am.pages ?? 1) > 1 || (bm.pages ?? 1) > 1) return noMatch;
  const aw = am.autoOrient.width, ah = am.autoOrient.height;
  const bw = bm.autoOrient.width, bh = bm.autoOrient.height;
  // Allow rounding by one pixel in a resized copy, not stretching or cropping.
  if (Math.abs(aw / ah - bw / bh) > Math.max(1 / ah, 1 / bh)) return noMatch;
  const rgba = (s: Sharp) => s.toColourspace('srgb').ensureAlpha().raw();
  if (aw === bw && ah === bh && aw * ah <= MAX_EXACT_PIXELS) {
    const [ap, bp] = await Promise.all([rgba(a.clone()).toBuffer(), rgba(b.clone()).toBuffer()]);
    if (ap.equals(bp)) return { match: 'pixels', differentFraction: 0, localStructure: 1 };
  }
  const [w, h] = aw * ah <= bw * bh ? [aw, ah] : [bw, bh];
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale));
  const resize = (s: Sharp) => rgba(s.resize(width, height, { fit: 'fill', kernel: 'lanczos3' })).toBuffer();
  const [ap, bp] = await Promise.all([resize(a), resize(b)]);
  const options = { threshold: COMPARISON_LIMITS.colorThreshold, includeAA: false };
  const differentFraction = pixelmatch(ap, bp, null, width, height, options) / (width * height);
  if (differentFraction > COMPARISON_LIMITS.maxDifferentFraction) return { match: null, differentFraction };
  const maxLocalDifference = pixelmatch(ap, bp, null, width, height, { ...options, windowSize: 16 });
  if (maxLocalDifference > COMPARISON_LIMITS.maxLocalDifference) return { match: null, differentFraction, maxLocalDifference };
  // A fixed Gaussian low-pass suppresses JPEG ringing before structural comparison.
  // The pixel gate above still sees the unblurred colors; equality is always checked at full resolution.
  const structurePixels = await Promise.all([ap, bp].map(p => sharp(p, { raw: { width, height, channels: 4 } })
    .blur(COMPARISON_LIMITS.noiseSigma).raw().toBuffer()));
  const structure = localStructure(structurePixels[0]!, structurePixels[1]!, width, height);
  return {
    match: structure >= COMPARISON_LIMITS.minLocalStructure ? 'visual' : null,
    differentFraction,
    localStructure: structure,
    maxLocalDifference,
  };
}
