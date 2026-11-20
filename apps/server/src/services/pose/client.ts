/**
 * 主进程侧的姿势检测客户端（这里只能 import type onnxruntime，主进程不加载推理库）。
 * 一次「提取姿势」任务开一个子进程，跑完关掉；DirectML 起不来时子进程自己退回 CPU。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.ts';
import type { PoseChildMsg, PoseDetector, PoseDetectorOptions, PoseInitMsg, PoseItemResult, PoseReadyMsg } from './protocol.ts';

const INIT_TIMEOUT = 300_000;
const REQUEST_TIMEOUT = 120_000;

const hostEntry = () => fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './host.ts' : './host.js', import.meta.url));

/** 识别模型探测过的 DirectML 适配器（tagger/client.ts 写的缓存），没有就用 0 */
function dmlDevice(): number {
  if (config.dmlDeviceId !== null && config.dmlDeviceId !== undefined) return config.dmlDeviceId;
  try {
    const v = JSON.parse(readFileSync(path.join(config.modelsDir, 'dml-device.json'), 'utf8')) as { deviceId?: unknown };
    return typeof v.deviceId === 'number' ? v.deviceId : 0;
  } catch {
    return 0;
  }
}

export class PoseClient implements PoseDetector {
  private reqId = 0;
  private readonly pending = new Map<number, { resolve: (r: PoseItemResult[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    readonly info: PoseReadyMsg,
  ) {
    child.on('message', (m: PoseChildMsg) => {
      if (m.type === 'result') this.settle(m.reqId, null, m.results);
      else if (m.type === 'error' && m.reqId !== null) this.settle(m.reqId, new Error(m.message));
    });
    child.on('exit', (code, sig) => this.die(`姿势子进程退出（${sig ?? code}）`));
    child.on('error', (err) => this.die(`姿势子进程出错：${err.message}`));
  }

  get device() {
    return this.info.device;
  }

  private die(why: string) {
    this.exited = true;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    for (const id of [...this.pending.keys()]) this.settle(id, new Error(why));
  }

  static spawn(o: PoseDetectorOptions): Promise<PoseClient> {
    const child = fork(hostEntry(), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('姿势模型加载超时'));
      }, INIT_TIMEOUT);
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMsg);
        child.off('exit', onExit);
      };
      const onMsg = (m: PoseChildMsg) => {
        if (m.type === 'ready') {
          cleanup();
          resolve(new PoseClient(child, m));
        } else if (m.type === 'error' && m.fatal) {
          cleanup();
          child.kill();
          reject(new Error(m.message));
        }
      };
      const onExit = (code: number | null, sig: string | null) => {
        cleanup();
        reject(new Error(`姿势子进程在加载时退出（${sig ?? code}）`));
      };
      child.on('message', onMsg);
      child.on('exit', onExit);
      const init: PoseInitMsg = { type: 'init', yoloxPath: o.yoloxPath, dwposePath: o.dwposePath, device: o.device, dmlDeviceId: dmlDevice() };
      child.send(init);
    });
  }

  detect(items: { id: number; path: string }[]): Promise<PoseItemResult[]> {
    if (this.exited || !this.child.connected) return Promise.reject(new Error('姿势子进程已退出'));
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.die('姿势检测超时'), REQUEST_TIMEOUT);
      this.pending.set(reqId, { resolve, reject, timer });
      this.child.send({ type: 'detect', reqId, items }, (err) => {
        if (err) this.die(`发给姿势子进程失败：${err.message}`);
      });
    });
  }

  private settle(reqId: number, err: Error | null, results?: PoseItemResult[]) {
    const p = this.pending.get(reqId);
    if (!p) return;
    this.pending.delete(reqId);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(results!);
  }

  async dispose(): Promise<void> {
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 5000);
      this.child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        this.child.send({ type: 'shutdown' });
      } catch {
        this.child.kill();
      }
    });
  }
}

/** 真实的检测器（infra/ports.ts 的 poseDetector 为 null 时用它） */
export const spawnPoseDetector = (o: PoseDetectorOptions): Promise<PoseDetector> => PoseClient.spawn(o);
