/**
 * 主进程侧的打标签客户端。注意：这里只能有 import type onnxruntime —— 主进程绝不加载推理库。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.ts';
import type { ChildMsg, HostItemResult, HostThresholds, InitMsg, ReadyMsg } from './protocol.ts';

export class TaggerCrashedError extends Error {}

export interface TaggerStartOptions {
  repo: string;
  modelPath: string;
  labelsPath: string;
  device: 'cpu' | 'dml';
  batchSize: number;
  modelsDir: string;
  fixedBatch?: boolean;
}

export interface TaggerLike {
  readonly device: 'cpu' | 'dml' | 'webgpu';
  readonly batchSize: number;
  readonly info: ReadyMsg;
  tag(items: { id: number; path: string }[], th: HostThresholds): Promise<HostItemResult[]>;
}

const INIT_TIMEOUT = 600_000; // DML 首次编译 + 多适配器探测可能要几分钟
const REQUEST_TIMEOUT = 300_000; // 防止 DML 卡死（microsoft/onnxruntime#16473）

/** 开发时跑 .ts，打包成 JS（T23）后跑 .js */
const hostEntry = () => fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './host.ts' : './host.js', import.meta.url));

export class TaggerClient implements TaggerLike {
  private reqId = 0;
  private readonly pending = new Map<number, { resolve: (r: HostItemResult[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    readonly info: ReadyMsg,
  ) {
    child.on('message', (m: ChildMsg) => {
      if (m.type === 'result') this.settle(m.reqId, null, m.results);
      else if (m.type === 'error' && m.reqId !== null) this.settle(m.reqId, new Error(m.message));
    });
    child.on('exit', (code, sig) => {
      this.exited = true;
      const err = new TaggerCrashedError(`识别子进程退出（${sig ?? code}）`);
      for (const id of [...this.pending.keys()]) this.settle(id, err);
    });
  }

  get device() {
    return this.info.device;
  }
  get batchSize() {
    return this.info.batchSize;
  }
  get alive() {
    return !this.exited;
  }

  static spawn(o: TaggerStartOptions & { dmlDeviceId: number | 'probe' }): Promise<TaggerClient> {
    // execArgv 继承 process.execArgv：tsx 的 loader 会传下去，.ts 子进程能跑；advanced 序列化能传 Float32Array
    const child = fork(hostEntry(), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new TaggerCrashedError('识别模型加载超时'));
      }, INIT_TIMEOUT);
      const onMsg = (m: ChildMsg) => {
        if (m.type === 'ready') {
          cleanup();
          resolve(new TaggerClient(child, m));
        } else if (m.type === 'error' && m.fatal) {
          cleanup();
          child.kill();
          reject(new Error(m.message));
        }
      };
      const onExit = (code: number | null, sig: string | null) => {
        cleanup();
        reject(new TaggerCrashedError(`识别子进程在加载时退出（${sig ?? code}）`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMsg);
        child.off('exit', onExit);
      };
      child.on('message', onMsg);
      child.on('exit', onExit);
      const init: InitMsg = {
        type: 'init',
        repo: o.repo,
        modelPath: o.modelPath,
        labelsPath: o.labelsPath,
        device: o.device,
        dmlDeviceId: o.dmlDeviceId,
        batchSize: o.batchSize,
        fixedBatch: o.fixedBatch ?? o.device === 'dml',
      };
      child.send(init);
    });
  }

  tag(items: { id: number; path: string }[], th: HostThresholds, timeoutMs = REQUEST_TIMEOUT): Promise<HostItemResult[]> {
    if (this.exited) return Promise.reject(new TaggerCrashedError('识别子进程已退出'));
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill(); // 卡死：杀掉，exit 事件会把所有 pending 都 reject
        reject(new TaggerCrashedError('识别请求超时'));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.child.send({ type: 'tag', reqId, items, thresholds: th });
    });
  }

  private settle(reqId: number, err: Error | null, results?: HostItemResult[]) {
    const p = this.pending.get(reqId);
    if (!p) return;
    this.pending.delete(reqId);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(results!);
  }

  /** 发 shutdown，5 秒后还没退出就 kill */
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

const dmlCacheFile = (modelsDir: string) => path.join(modelsDir, 'dml-device.json');

function readDmlCache(modelsDir: string): number | null {
  try {
    const v = JSON.parse(readFileSync(dmlCacheFile(modelsDir), 'utf8')) as { deviceId?: unknown };
    return typeof v.deviceId === 'number' ? v.deviceId : null;
  } catch {
    return null;
  }
}

/** 带 DML→CPU 回退和适配器缓存 */
export async function startTagger(o: TaggerStartOptions): Promise<TaggerClient> {
  if (o.device === 'cpu') return TaggerClient.spawn({ ...o, dmlDeviceId: 0 });
  const cached = readDmlCache(o.modelsDir);
  const id: number | 'probe' = config.dmlDeviceId ?? cached ?? 'probe';
  let client: TaggerClient;
  try {
    client = await TaggerClient.spawn({ ...o, dmlDeviceId: id });
  } catch (err) {
    if (!(err instanceof TaggerCrashedError)) throw err;
    // DML 在 ready 之前原生崩溃：用 CPU 再起一次
    const cpu = await TaggerClient.spawn({ ...o, device: 'cpu', dmlDeviceId: 0 });
    cpu.info.fallbackReason = `DirectML 子进程崩溃：${err.message}`;
    return cpu;
  }
  if (client.info.device === 'dml' && id === 'probe' && client.info.dmlDeviceId !== null) {
    writeFileSync(dmlCacheFile(o.modelsDir), JSON.stringify({ deviceId: client.info.dmlDeviceId }));
  } else if (client.info.device === 'cpu' && cached !== null && id === cached) {
    rmSync(dmlCacheFile(o.modelsDir), { force: true }); // 缓存的适配器失效了，下次重新探测
  }
  return client;
}

// ---------------------------------------------------------------- 单例

let current: { key: string; client: Promise<TaggerClient> } | null = null;
let idleTimer: NodeJS.Timeout | null = null;

export function acquireTagger(o: TaggerStartOptions): Promise<TaggerClient> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const key = `${o.repo}|${o.device}|${o.batchSize}`;
  if (current && current.key !== key) void shutdownTagger();
  if (!current) {
    const client = startTagger(o);
    current = { key, client };
    // 启动失败不要把 rejected 的 promise 一直缓存着
    client.catch(() => {
      if (current?.client === client) current = null;
    });
  }
  return current.client.then(async (c) => {
    if (c.alive) return c;
    current = null;
    return acquireTagger(o);
  });
}

/** 空闲一段时间后关子进程，释放显存（约 3 GB） */
export function releaseTagger(idleMs = 60_000): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void shutdownTagger(), idleMs);
  idleTimer.unref();
}

export async function shutdownTagger(): Promise<void> {
  const c = current;
  current = null;
  if (c) await c.client.then((x) => x.dispose()).catch(() => {});
}
