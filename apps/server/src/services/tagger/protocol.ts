/** 主进程 ↔ 推理子进程的消息 */
import type { Rating } from '@emaki/shared';

/** InitMsg 里的 dml = 「用 GPU」；ReadyMsg 里是实际用上的后端 */
export type HostDevice = 'cpu' | 'dml' | 'webgpu';

export interface HostThresholds {
  general: number;
  character: number;
  generalMcut?: boolean;
  characterMcut?: boolean;
  /** 画师门槛；不给就不解码画师 */
  artist?: number;
}

export interface InitMsg {
  type: 'init';
  repo: string;
  modelPath: string;
  labelsPath: string;
  device: HostDevice;
  dmlDeviceId: number | 'probe';
  batchSize: number;
  fixedBatch: boolean;
  /** 不试 DirectML，直接走 WebGPU（DirectML 上崩过 / 卡死过之后重开用） */
  noDml?: boolean;
}

export interface TagMsg {
  type: 'tag';
  reqId: number;
  items: { id: number; path: string }[];
  thresholds: HostThresholds;
}

export type ParentMsg = InitMsg | TagMsg | { type: 'shutdown' };

export type HostItemResult =
  | {
      id: number;
      ok: true;
      rating: Record<Rating, number> | null;
      general: [string, number][];
      character: [string, number][];
      /** 模型能认画师、请求里给了门槛时才有；[] = 跑过但没认出 */
      artist?: [string, number][];
    }
  /** ENOENT：文件不在了；IO：暂时读不了（被占用、没权限），这次不记、下次再试；UNSUPPORTED / DECODE：图本身的问题 */
  | { id: number; ok: false; code: 'ENOENT' | 'IO' | 'UNSUPPORTED' | 'DECODE'; message: string };

export interface ReadyMsg {
  type: 'ready';
  device: HostDevice;
  dmlDeviceId: number | null;
  fallbackReason: string | null;
  batchSize: number;
  fixedBatch: boolean;
  inputName: string;
  inputShape: (number | string)[];
  outputName: string;
  numLabels: number;
  loadMs: number;
  pid: number;
}

export type ChildMsg =
  | ReadyMsg
  | { type: 'result'; reqId: number; results: HostItemResult[]; preprocessMs: number; inferMs: number }
  | { type: 'error'; reqId: number | null; message: string; fatal: boolean };
