/**
 * sharp 全局设置。所有用到 sharp 的模块都从这里 import，保证设置已生效。
 */
import os from 'node:os';
import sharp, { type SharpOptions } from 'sharp';

// libvips 默认最多同时开着 20 个文件句柄；在 Windows 上会导致原图没法移到回收站或重命名（EBUSY）
sharp.cache(false);
// 每张图只用一半的核，给 HTTP / tagger 留余量
sharp.concurrency(Math.max(1, Math.floor(os.availableParallelism() / 2)));

/**
 * failOn 默认 'warning' 太严格：pixiv 常见的「Corrupt JPEG data: N extraneous bytes」都会失败；
 * 'none' 连截断的 JPEG 也能解出上半部分。像素上限放宽到 5 亿，超过记 decode_error。
 */
export const SHARP_INPUT = { failOn: 'none', limitInputPixels: 500_000_000 } as const satisfies SharpOptions;

export { sharp };
