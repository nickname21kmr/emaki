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
): JustifiedRow[] {
  if (containerWidth <= 0) return [];
  const rows: JustifiedRow[] = [];
  let start = 0;
  let ratioSum = 0;

  // 太宽的全景图 / 太窄的长图限制一下比例，避免一行只有一张怪图
  const ratioOf = (it: JustifiedItem) => Math.min(Math.max(it.width / Math.max(it.height, 1), 0.4), 3);

  for (let i = 0; i < items.length; i++) {
    ratioSum += ratioOf(items[i]!);
    const n = i - start + 1;
    const rowWidthAtTarget = ratioSum * targetHeight + gap * (n - 1);
    if (rowWidthAtTarget >= containerWidth) {
      const height = (containerWidth - gap * (n - 1)) / ratioSum;
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
