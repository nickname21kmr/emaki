/** 主进程 ↔ 姿势检测子进程的消息（和识别子进程分开：模型不同，生命周期跟着「提取姿势」任务走） */
import type { DetectedPerson } from '../../domain/pose/features.ts';

export type PoseDevice = 'cpu' | 'dml';

export interface PoseInitMsg {
  type: 'init';
  yoloxPath: string;
  dwposePath: string;
  device: PoseDevice;
  dmlDeviceId: number;
}

export interface PoseDetectMsg {
  type: 'detect';
  reqId: number;
  items: { id: number; path: string }[];
}

export type PoseParentMsg = PoseInitMsg | PoseDetectMsg | { type: 'shutdown' };

/** w、h 是检测时那张图（长边缩到 1024 以内）的尺寸，persons 的坐标在这张图上 */
export type PoseItemResult =
  | { id: number; ok: true; w: number; h: number; persons: DetectedPerson[] }
  /** 和识别一样：ENOENT 文件不在了，IO 暂时读不了（下次再试），DECODE / UNSUPPORTED 是图本身的问题 */
  | { id: number; ok: false; code: 'ENOENT' | 'IO' | 'UNSUPPORTED' | 'DECODE'; message: string };

export interface PoseReadyMsg {
  type: 'ready';
  device: PoseDevice;
  fallbackReason: string | null;
  loadMs: number;
}

export type PoseChildMsg =
  | PoseReadyMsg
  | { type: 'result'; reqId: number; results: PoseItemResult[] }
  | { type: 'error'; reqId: number | null; message: string; fatal: boolean };

/** 检测器（infra/ports.ts 的 poseDetector 可以换成假的） */
export interface PoseDetector {
  readonly device: PoseDevice;
  detect(items: { id: number; path: string }[]): Promise<PoseItemResult[]>;
  dispose(): Promise<void>;
}

export interface PoseDetectorOptions {
  yoloxPath: string;
  dwposePath: string;
  device: PoseDevice;
}

export type PoseDetectorFactory = (o: PoseDetectorOptions) => Promise<PoseDetector>;
