/**
 * 最小的 BMP 解码器（预编译 sharp 不支持 BMP）。
 * 只支持 BI_RGB 的 24/32 位，以及 BI_BITFIELDS 的 32 位（假定标准 BGRA 掩码）；其余返回 null。
 */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

export function decodeBmp(buf: Buffer): RawImage | null {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const topDown = rawHeight < 0; // 高度为负表示自上而下
  const height = Math.abs(rawHeight);
  if (width <= 0 || height <= 0) return null;
  if (!((compression === 0 && (bpp === 24 || bpp === 32)) || (compression === 3 && bpp === 32))) return null;

  const srcBytes = bpp / 8;
  const channels: 3 | 4 = bpp === 32 ? 4 : 3;
  const rowSize = Math.ceil((width * srcBytes) / 4) * 4; // 每行 4 字节对齐
  if (offset + rowSize * height > buf.length) return null;

  const out = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const srcRow = offset + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * srcBytes;
      const d = (y * width + x) * channels;
      out[d] = buf[s + 2]!; // BGR(A) → RGB(A)
      out[d + 1] = buf[s + 1]!;
      out[d + 2] = buf[s]!;
      if (channels === 4) out[d + 3] = buf[s + 3]!;
    }
  }
  return { data: out, width, height, channels };
}
