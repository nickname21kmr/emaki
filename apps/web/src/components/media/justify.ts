/**
 * 「等高行」布局（Google Photos / Flickr 那种）：每行高度不同但都铺满宽度，图片保持原始比例。
 */
export interface JustifiedItem {
  width: number;
  height: number;
}

export interface JustifiedRow {
  /** 本行在 items 里的起止下标 [start, end) */
  start: number;
  end: number;
  height: number;
  /** 每张图的显示宽度 */
  widths: number[];
}

export function justify(
  items: readonly JustifiedItem[],
  containerWidth: number,
  targetHeight: number,
  gap: number,
  opts: { balance?: boolean } = {},
): JustifiedRow[] {
  if (containerWidth <= 0) return [];
  const rows: JustifiedRow[] = [];
  let start = 0;
  let ratioSum = 0;

  // 太宽的全景图 / 太窄的长图限制一下比例，避免一行只有一张怪图
  const ratioOf = (it: JustifiedItem) => Math.min(Math.max(it.width / Math.max(it.height, 1), 0.4), 3);
  const heightOf = (sum: number, n: number) => (containerWidth - gap * (n - 1)) / sum;

  for (let i = 0; i < items.length; i++) {
    const r = ratioOf(items[i]!);
    ratioSum += r;
    const n = i - start + 1;
    const rowWidthAtTarget = ratioSum * targetHeight + gap * (n - 1);
    if (rowWidthAtTarget >= containerWidth) {
      const height = heightOf(ratioSum, n);
      // balance（窄屏，A1）：一行只放得下两三张时，最后加进来的那张宽图会把整行压得很矮。
      // 比一比「不放它就收行」和「放它再收行」哪个更接近目标行高；不放的话它去下一行打头
      if (opts.balance && n > 1) {
        const without = heightOf(ratioSum - r, n - 1);
        if (Math.abs(without - targetHeight) < Math.abs(height - targetHeight)) {
          rows.push(makeRow(items, start, i, without, ratioOf));
          start = i;
          ratioSum = r;
          // 它自己一张就已经撑满一行
          if (r * targetHeight >= containerWidth) {
            rows.push(makeRow(items, i, i + 1, heightOf(r, 1), ratioOf));
            start = i + 1;
            ratioSum = 0;
          }
          continue;
        }
      }
      rows.push(makeRow(items, start, i + 1, height, ratioOf));
      start = i + 1;
      ratioSum = 0;
    }
  }
  // 最后一行不拉伸，用目标行高
  if (start < items.length) rows.push(makeRow(items, start, items.length, targetHeight, ratioOf));
  return rows;
}

function makeRow(
  items: readonly JustifiedItem[],
  start: number,
  end: number,
  height: number,
  ratioOf: (it: JustifiedItem) => number,
): JustifiedRow {
  const widths: number[] = [];
  for (let i = start; i < end; i++) widths.push(ratioOf(items[i]!) * height);
  return { start, end, height, widths };
}
