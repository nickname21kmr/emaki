/**
 * Mock 模式的占位图：按图片 id 生成一张确定性的「水彩色块」SVG。
 * 只用 radialGradient（不用 blur 滤镜），几百张同屏也不卡。
 */

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function placeholderSvg(opts: {
  id: string;
  width: number;
  height: number;
  hue: number;
  /** 输出宽度（缩略图档位） */
  outWidth: number;
  label?: string;
}): string {
  const r = rng(hash(opts.id));
  const w = opts.outWidth;
  const h = Math.round((opts.height / opts.width) * w);
  const base = opts.hue + (r() - 0.5) * 30;
  const light = 88 + r() * 6;

  const blobs = Array.from({ length: 5 }, (_, i) => {
    const hue = (base + (r() - 0.3) * 90 + 360) % 360;
    const sat = 55 + r() * 30;
    const lum = 55 + r() * 25;
    const cx = (r() * 100).toFixed(1);
    const cy = (r() * 100).toFixed(1);
    const rad = (35 + r() * 45).toFixed(1);
    return { i, hue, sat, lum, cx, cy, rad };
  });

  // 一个模糊的「人物剪影」：头 + 身体，让占位图有点构图感
  const figX = 30 + r() * 40;
  const figHue = (base + 180 + (r() - 0.5) * 40) % 360;

  const defs = blobs
    .map(
      (b) => `<radialGradient id="g${b.i}" cx="${b.cx}%" cy="${b.cy}%" r="${b.rad}%">
<stop offset="0" stop-color="hsl(${b.hue.toFixed(0)} ${b.sat.toFixed(0)}% ${b.lum.toFixed(0)}%)" stop-opacity="0.95"/>
<stop offset="1" stop-color="hsl(${b.hue.toFixed(0)} ${b.sat.toFixed(0)}% ${b.lum.toFixed(0)}%)" stop-opacity="0"/>
</radialGradient>`,
    )
    .join('');

  const rects = blobs.map((b) => `<rect width="100%" height="100%" fill="url(#g${b.i})"/>`).join('');

  const label = opts.label
    ? `<text x="6%" y="94%" font-family="Inter, system-ui, sans-serif" font-size="${Math.max(10, w / 22).toFixed(0)}" fill="rgba(20,20,30,.35)">${escapeXml(opts.label)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<defs>${defs}
<radialGradient id="fig" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="hsl(${figHue.toFixed(0)} 40% 30%)" stop-opacity=".28"/><stop offset="1" stop-color="hsl(${figHue.toFixed(0)} 40% 30%)" stop-opacity="0"/></radialGradient>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${base.toFixed(0)} 60% ${light.toFixed(0)}%)"/><stop offset="1" stop-color="hsl(${((base + 40) % 360).toFixed(0)} 50% ${(light - 12).toFixed(0)}%)"/></linearGradient>
</defs>
<rect width="100%" height="100%" fill="url(#bg)"/>${rects}
<ellipse cx="${figX}%" cy="38%" rx="${(w * 0.13).toFixed(0)}" ry="${(w * 0.15).toFixed(0)}" fill="url(#fig)"/>
<ellipse cx="${figX}%" cy="92%" rx="${(w * 0.32).toFixed(0)}" ry="${(h * 0.38).toFixed(0)}" fill="url(#fig)"/>
${label}</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export { hash as hashString, rng as seededRandom };
