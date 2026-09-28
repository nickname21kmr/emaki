/**
 * 颜色小工具。mock 和 sqlite 共用，保证两边算出的作品色 / 占位主色一致。
 * （T10 会在这里加 colorFromTag。）
 */

/** FNV-1a 32 位哈希 */
export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** 作品主题色（mock 的 hue → hex） */
export const workColorFromHue = (hue: number) => hslToHex(hue, 62, 58);

/** mock 图片的占位主色 */
export const mockDominantColor = (hue: number, imageId: string) =>
  hslToHex(hue + ((hashString(imageId) % 30) - 15), 45, 82);

/** 作品色点：按 tag 哈希取色相，和 mock 一样用 hsl(h,62%,58%) */
export const colorFromTag = (tag: string) => hslToHex(hashString(tag) % 360, 62, 58);
