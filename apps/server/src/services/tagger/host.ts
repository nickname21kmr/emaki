/**
 * 推理子进程入口（child_process.fork）。
 *
 * 为什么放子进程：onnxruntime-node 的 session.run() 在 JS 线程上同步执行，放主进程会卡住 HTTP / SSE；
 * DirectML 偶尔原生崩溃（进程直接退出），放子进程主进程只要重启它、回退到 CPU。
 * 不用 worker_threads：onnxruntime-node 在 worker 里有已知问题（microsoft/onnxruntime#23790）。
 */
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import type * as Ort from 'onnxruntime-node';
import { clearReshapeAllowzero } from './dmlPatch.ts';
import { parseLabels, type Labels } from './labels.ts';
import { findModel, type TaggerModelSpec } from './models.ts';
import { decodeRow } from './postprocess.ts';
// 主线程也加载一次 preprocess（连带 sharp）：原生模块先在主线程初始化，工作线程和回退路径都用它
import { perImage, preprocessFile } from './preprocess.ts';
import { PoolUnavailableError, PreprocessPool, type PreprocessReply } from './preprocessPool.ts';
import type { ChildMsg, HostDevice, HostItemResult, InitMsg, ParentMsg, TagMsg } from './protocol.ts';

// onnxruntime-node 是 CJS，用 require 最稳
const ort = createRequire(import.meta.url)('onnxruntime-node') as typeof Ort;

// 父进程退出（包括 tsx watch 重启）时自杀，防止孤儿进程占着显存
process.on('disconnect', () => process.exit(0));

const send = (m: ChildMsg) => process.send?.(m);

// 同一个 session 同一时间只能有一个 run()
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
};

interface State {
  spec: TaggerModelSpec;
  labels: Labels;
  session: Ort.InferenceSession;
  inputName: string;
  outputName: string;
  batchSize: number;
  fixedBatch: boolean;
}
let state: State | null = null;
/** 预处理线程池：模型加载好之后再开（加载期间不和它抢 CPU）；起不来就是 null，预处理留在主线程 */
let pool: PreprocessPool | null = null;

function sessionOptions(spec: TaggerModelSpec, device: HostDevice, deviceId: number, batch: number, fixed: boolean): Ort.InferenceSession.SessionOptions {
  if (device === 'dml') {
    return {
      executionProviders: [{ name: 'dml', deviceId } as Ort.InferenceSession.ExecutionProviderConfig],
      enableMemPattern: false, // DirectML 强制要求，不关会报错
      executionMode: 'sequential', // DirectML 强制要求
      graphOptimizationLevel: 'all',
      ...(fixed ? { freeDimensionOverrides: { [spec.batchDim]: batch } } : {}), // 形状固定时 DML 更快
      logSeverityLevel: 3,
    };
  }
  return {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, os.availableParallelism() - 1),
    logSeverityLevel: 3,
  };
}

function dims(spec: TaggerModelSpec, n: number): number[] {
  return spec.preprocess === 'wd-v3' ? [n, spec.inputSize, spec.inputSize, 3] : [n, 3, spec.inputSize, spec.inputSize];
}

async function runZeros(spec: TaggerModelSpec, session: Ort.InferenceSession, batch: number, outputName: string) {
  const buf = new Float32Array(batch * perImage(spec));
  const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor('float32', buf, dims(spec, batch)) }, [outputName]);
  return out[outputName]!.data as Float32Array;
}

async function init(msg: InitMsg): Promise<void> {
  let m = msg;
  const t0 = performance.now();
  const spec = findModel(m.repo);
  if (!spec) throw new Error(`未知模型：${m.repo}`);
  const labels = parseLabels(spec.labelsFormat, await readFile(m.labelsPath, 'utf8'));
  // 模型只接受固定大小的 batch（PixAI v1 = 1）
  if (spec.maxBatch !== null) m = { ...m, batchSize: Math.min(m.batchSize, spec.maxBatch) };

  let session: Ort.InferenceSession | null = null;
  let device: HostDevice = 'cpu';
  let dmlDeviceId: number | null = null;
  let fallbackReason: string | null = null;
  let batchSize = m.batchSize;
  let fixedBatch = m.fixedBatch;

  // 先 DirectML（按模型配置），不行再 WebGPU（PixAI 这类能两边跑的），都不行最后 CPU
  const reasons: string[] = [];
  if (m.device !== 'cpu' && spec.gpu === 'dml' && !m.noDml) {
    // 要打补丁的模型读进内存改好再交给 ORT；每个适配器共用这一份
    let source: string | Uint8Array = m.modelPath;
    if (spec.dmlPatch === 'reshape-allowzero') {
      const buf = await readFile(m.modelPath);
      clearReshapeAllowzero(buf);
      source = buf;
    }
    // 适配器 0 不一定是独显（混合显卡笔记本、虚拟显示适配器），探测模式下逐个试，留最快的
    const ids = m.dmlDeviceId === 'probe' ? [0, 1, 2, 3] : [m.dmlDeviceId];
    const errors: string[] = [];
    let best: { id: number; s: Ort.InferenceSession; ms: number } | null = null;
    for (const id of ids) {
      try {
        const opts = sessionOptions(spec, 'dml', id, batchSize, fixedBatch);
        const s = typeof source === 'string' ? await ort.InferenceSession.create(source, opts) : await ort.InferenceSession.create(source, opts);
        const outName = spec.outputName ?? s.outputNames[0]!;
        await runZeros(spec, s, batchSize, outName); // 首次会编译 DML 着色器
        let ms = 0;
        if (ids.length > 1) {
          const t = performance.now();
          await runZeros(spec, s, batchSize, outName);
          await runZeros(spec, s, batchSize, outName);
          ms = (performance.now() - t) / 2;
        }
        if (!best || ms < best.ms) {
          await best?.s.release();
          best = { id, s, ms };
        } else await s.release();
      } catch (err) {
        errors.push(`#${id}：${(err as Error).message.split('\n')[0]}`);
      }
    }
    if (best) {
      session = best.s;
      device = 'dml';
      dmlDeviceId = best.id;
    } else {
      reasons.push(`DirectML 不可用（${errors.join('；')}）`);
    }
  }
  if (!session && m.device !== 'cpu' && (spec.gpu === 'webgpu' || spec.webgpuFallback)) {
    try {
      session = await ort.InferenceSession.create(m.modelPath, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      } as Ort.InferenceSession.SessionOptions);
      device = 'webgpu';
    } catch (err) {
      reasons.push(`WebGPU 不可用（${(err as Error).message.split('\n')[0]}）`);
    }
  }
  if (reasons.length) fallbackReason = reasons.join('；');
  if (!session) {
    batchSize = Math.min(batchSize, 4); // CPU 上大 batch 没有收益
    fixedBatch = false;
    session = await ort.InferenceSession.create(m.modelPath, sessionOptions(spec, 'cpu', 0, batchSize, false));
  }

  const inputName = session.inputNames[0]!;
  const outputName = spec.outputName ?? session.outputNames[0]!;
  const probe = await runZeros(spec, session, fixedBatch ? batchSize : 1, outputName);
  const n = fixedBatch ? batchSize : 1;
  if (probe.length !== n * labels.names.length) {
    throw new Error(`标签表与模型不匹配：输出 ${probe.length / n} 维，标签 ${labels.names.length} 个`);
  }
  state = { spec, labels, session, inputName, outputName, batchSize, fixedBatch };
  pool = new PreprocessPool(undefined, (msg) => console.warn(`[tagger] ${msg}`));
  const meta = session.inputMetadata[0] as { shape?: (number | string)[] } | undefined;
  send({
    type: 'ready',
    device,
    dmlDeviceId,
    fallbackReason,
    batchSize,
    fixedBatch,
    inputName,
    inputShape: meta?.shape ?? [],
    outputName,
    numLabels: labels.names.length,
    loadMs: Math.round(performance.now() - t0),
    pid: process.pid,
  });
}

/** 线程池用不了时在主线程预处理（原来的做法），错误口径和工作线程一致 */
async function preprocessInline(spec: TaggerModelSpec, id: number, path: string): Promise<PreprocessReply> {
  return { id, ...(await preprocessFile(spec, path)) };
}

async function tag(m: TagMsg): Promise<void> {
  const s = state;
  if (!s) throw new Error('子进程还没初始化');
  const t0 = performance.now();
  const results: (HostItemResult | null)[] = [];
  const inputs: (Float32Array | null)[] = await Promise.all(
    m.items.map(async (item, k) => {
      let r: PreprocessReply;
      try {
        if (!pool) throw new PoolUnavailableError('没有线程池');
        r = await pool.run(s.spec.repo, item.path);
      } catch (err) {
        if (!(err instanceof PoolUnavailableError)) throw err;
        r = await preprocessInline(s.spec, item.id, item.path);
      }
      if (r.ok) return r.data;
      results[k] = { id: item.id, ok: false, code: r.code, message: r.message };
      return null;
    }),
  );
  const preprocessMs = performance.now() - t0;

  const okIdx = inputs.flatMap((x, k) => (x ? [k] : []));
  let inferMs = 0;
  const per = perImage(s.spec);
  for (let start = 0; start < okIdx.length; start += s.batchSize) {
    const chunk = okIdx.slice(start, start + s.batchSize);
    // 固定 batch 时最后一批补零到 batch 大小，输出里丢掉
    const n = s.fixedBatch ? s.batchSize : chunk.length;
    // 一张一批（PixAI）直接用线程池给的数组，省一次 12 MB 的复制
    let buf: Float32Array;
    if (n === 1 && chunk.length === 1 && inputs[chunk[0]!]!.length === per) buf = inputs[chunk[0]!]!;
    else {
      buf = new Float32Array(n * per);
      chunk.forEach((k, j) => buf.set(inputs[k]!, j * per));
    }
    const t1 = performance.now();
    const out = await serial(() =>
      s.session.run({ [s.inputName]: new ort.Tensor('float32', buf, dims(s.spec, n)) }, [s.outputName]),
    );
    inferMs += performance.now() - t1;
    const probs = out[s.outputName]!.data as Float32Array;
    // PixAI v1 输出 logits：就地过 Sigmoid
    if (s.spec.logits) for (let i = 0; i < probs.length; i++) probs[i] = 1 / (1 + Math.exp(-probs[i]!));
    chunk.forEach((k, j) => {
      const d = decodeRow(probs, j * s.labels.names.length, s.labels, {
        generalThreshold: m.thresholds.general,
        characterThreshold: m.thresholds.character,
        generalMcut: m.thresholds.generalMcut,
        characterMcut: m.thresholds.characterMcut,
        artistThreshold: m.thresholds.artist,
      });
      results[k] = { id: m.items[k]!.id, ok: true, ...d };
    });
  }
  send({ type: 'result', reqId: m.reqId, results: results as HostItemResult[], preprocessMs, inferMs });
}

process.on('message', (msg: ParentMsg) => {
  switch (msg.type) {
    case 'init':
      init(msg).catch((err) => send({ type: 'error', reqId: null, message: (err as Error).message, fatal: true }));
      break;
    case 'tag':
      tag(msg).catch((err) => send({ type: 'error', reqId: msg.reqId, message: (err as Error).message, fatal: false }));
      break;
    case 'shutdown':
      void pool?.close();
      void state?.session.release().finally(() => process.exit(0));
      if (!state) process.exit(0);
      break;
  }
});
