/**
 * 可替换部件（docs/core-architecture.md 第 3 节「基础设施」、第 8 节）。
 *
 * 引擎（SqliteDataSource）里所有会碰到「数据库之外的世界」的地方都在这里列出来：时钟、系统回收站、
 * 用户的图片文件、用户的图库文件夹、后台任务（扫描、识别模型、联网）、局域网入口的监听和广播。真实运行用默认实现；
 * 测试和演示模式（demo/engine.ts）换成假的，跑的仍是同一套业务逻辑和 SQL。
 *
 * 用法：SqliteDataSource.open(bus, dir, { ...部分部件 })，没给的用 REAL_PORTS 里的默认值。
 */
import type { ImageFormat, JobKind, ThumbWidth } from '@emaki/shared';
import type { LanNetwork } from '../access/discovery.ts';
import type { JobRunner } from '../core/jobs.ts';
import type { TrashImpl } from '../services/trash/recycleBin.ts';
import type { PoseDetectorFactory } from '../services/pose/protocol.ts';

/** 图片文件响应：要么直接给内容（演示模式的 SVG 占位图），要么给磁盘路径让 fastify 流式发送 */
export type FileResponse =
  | { kind: 'buffer'; contentType: string; body: Buffer | string; etag?: string; cacheControl?: string }
  | { kind: 'path'; contentType: string; filePath: string; etag?: string; cacheControl?: string };

/** 读一张图的文件时用到的行（images 表里的列） */
export interface ImageFileRow {
  id: number;
  sha256: string;
  format: ImageFormat;
  width: number;
  height: number;
  file_name: string;
  rel_path: string;
  root_path: string;
  dominant_color: string | null;
  /** 文件的修改时间，也就是 ImageItem.modifiedAt：缩略图地址里带的版本和它对得上才长缓存（commands/queries.ts 的 getThumbnail） */
  modified_at: string;
}

/** 图片文件的读取：缩略图和原图（看图器、AI 助手看图都走这里）。返回 null = 404 */
export interface ImageFilesPort {
  thumbnail(row: ImageFileRow, width: ThumbWidth): Promise<FileResponse | null>;
  original(row: ImageFileRow): Promise<FileResponse | null>;
}

export interface EnginePorts {
  /** 时钟（毫秒）。测试注入固定时间 */
  clock: () => number;

  /** 系统回收站：真的把文件移进去（trash 库）。测试换成什么也不做，演示模式只记录 */
  trashImpl: TrashImpl | undefined;

  /** 检查文件所在的盘有没有回收站（U 盘、网络盘没有）。夹具里的路径不存在，测试和演示换成不检查 */
  checkRecyclable: ((rootPath: string) => Promise<void>) | undefined;

  /** 图片文件的读取。null = 读磁盘上的真文件、生成并缓存缩略图；演示模式返回 SVG 占位图 */
  imageFiles: ImageFilesPort | null;

  /**
   * 能不能改动用户的图库文件夹：移动、导入、替换文件、整理到子文件夹、撤回移动、在资源管理器中显示、添加图库文件夹。
   * false 时这些操作一律拒绝（提示「演示数据不支持」），保证演示模式绝不读写用户真实的文件夹
   */
  libraryFiles: boolean;

  /**
   * 后台任务的执行者。扫描、文件监听触发的扫描、缩略图、识别模型（角色、画师）、联网（Pixiv、Danbooru）、查重
   * 都只在后台任务里发生。null = 真实的任务链（services/pipeline.ts）；演示模式换成只走进度条、不改数据的假任务，
   * 这样不扫描、不跑模型、不联网
   */
  jobRunner: ((kind: JobKind) => JobRunner) | null;

  /**
   * 姿势检测（「提取姿势」任务用的动漫人物检测 + DWPose）。null = 真的推理子进程（services/pose/client.ts）；测试换成假的检测器
   */
  poseDetector: PoseDetectorFactory | null;

  /** 启动时自动开文件监听、排扫描和识别（T07）。测试和演示模式关掉 */
  autoJobs: boolean;

  /** 启动时导入随仓库分发的中文词库（T12，约 0.7 秒；版本没变时不导入）。契约测试关掉 */
  importDict: boolean;

  /**
   * 局域网入口（access/lan.ts，docs/mobile.md 2.8）碰真网络的两件事：https 监听所有网卡、mDNS 广播。
   * null = 真实网络（access/discovery.ts 的 REAL_LAN_NETWORK）；测试换成记录调用的假实现。
   * 演示模式也用真实的：入口默认关着，手动打开后可以拿假手机脚本（scripts/lan-client.ts）对着演示数据走一遍
   */
  lan: LanNetwork | null;
}

/** 真实运行时的部件 */
export const REAL_PORTS: EnginePorts = {
  clock: Date.now,
  trashImpl: undefined,
  checkRecyclable: undefined,
  imageFiles: null,
  libraryFiles: true,
  jobRunner: null,
  poseDetector: null,
  autoJobs: true,
  importDict: true,
  lan: null,
};

/** 把部分部件和默认值合起来 */
export function resolvePorts(partial: Partial<EnginePorts>): EnginePorts {
  const out = { ...REAL_PORTS };
  for (const [k, v] of Object.entries(partial) as [keyof EnginePorts, never][]) if (v !== undefined) out[k] = v;
  return out;
}
