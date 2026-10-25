import { getOptions } from 'ssim.js';
import { ssim } from 'ssim.js/dist/ssim.js';

// Use the original Gaussian SSIM map, not its default automatic downsampling or grayscale average.
const OPTIONS = getOptions({ ssim: 'fast', downsample: false, windowSize: 11 });
const REGION = 16;

/** Minimum sliding regional mean: a small edit must not disappear in a whole-image average. */
function minimumRegionalMean(data: ArrayLike<number>, width: number, height: number): number {
  const size = Math.min(REGION, width, height);
  const sums = new Float64Array((width + 1) * (height + 1));
  const stride = width + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += data[y * width + x]!;
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1]! + sum;
    }
  }
  let min = 1;
  for (let y = size; y <= height; y++)
    for (let x = size; x <= width; x++) {
      const sum = sums[y * stride + x]! - sums[(y - size) * stride + x]! - sums[y * stride + x - size]! + sums[(y - size) * stride + x - size]!;
      min = Math.min(min, sum / (size * size));
    }
  return Math.max(-1, Math.min(1, min));
}

/** RGB SSIM maps are averaged per position; alpha is checked separately if it changes. */
export function localStructure(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  if (width < 11 || height < 11) return a.every((v, i) => v === b[i]) ? 1 : -1;
  const n = width * height;
  let sum: Float64Array | undefined;
  let mapWidth = 0, mapHeight = 0, alphaScore = 1;
  for (let channel = 0; channel < 4; channel++) {
    const ac = new Array<number>(n), bc = new Array<number>(n);
    let equal = true;
    for (let i = 0; i < n; i++) {
      ac[i] = a[i * 4 + channel]!;
      bc[i] = b[i * 4 + channel]!;
      equal &&= ac[i] === bc[i];
    }
    if (channel === 3 && equal) continue;
    const map = ssim({ data: ac, width, height }, { data: bc, width, height }, OPTIONS);
    mapWidth = map.width;
    mapHeight = map.height;
    if (channel === 3) alphaScore = minimumRegionalMean(map.data, map.width, map.height);
    else {
      sum ??= new Float64Array(map.data.length);
      for (let i = 0; i < map.data.length; i++) sum[i]! += map.data[i]! / 3;
    }
  }
  return Math.min(alphaScore, minimumRegionalMean(sum!, mapWidth, mapHeight));
}
