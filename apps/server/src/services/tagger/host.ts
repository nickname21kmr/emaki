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
import { parseLabels, type Labels } from './labels.ts';
import { findModel, type TaggerModelSpec } from './models.ts';
import { decodeRow } from './postprocess.ts';
import { perImage, preprocess } from './preprocess.ts';
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

  if (m.device !== 'cpu' && spec.gpu === 'webgpu') {
    try {
      session = await ort.InferenceSession.create(m.modelPath, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      } as Ort.InferenceSession.SessionOptions);
      device = 'webgpu';
    } catch (err) {
      fallbackReason = `WebGPU 不可用（${(err as Error).message.split('\n')[0]}）`;
    }
  } else if (m.device === 'dml') {
    // 适配器 0 不一定是独显（混合显卡笔记本、虚拟显示适配器），探测模式下逐个试，留最快的
    const ids = m.dmlDeviceId === 'probe' ? [0, 1, 2, 3] : [m.dmlDeviceId];
    const errors: string[] = [];
    let best: { id: number; s: Ort.InferenceSession; ms: number } | null = null;
    for (const id of ids) {
      try {
        const s = await ort.InferenceSession.create(m.modelPath, sessionOptions(spec, 'dml', id, batchSize, fixedBatch));
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
      fallbackReason = `DirectML 不可用（${errors.join('；')}）`;
    }
  }
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

async function tag(m: TagMsg): Promise<void> {
  const s = state;
  if (!s) throw new Error('子进程还没初始化');
  const t0 = performance.now();
  const results: (HostItemResult | null)[] = [];
  const inputs: (Float32Array | null)[] = await Promise.all(
    m.items.map(async (item, k) => {
      try {
        await stat(item.path);
      } catch {
        results[k] = { id: item.id, ok: false, code: 'ENOENT', message: '文件不存在' };
        return null;
      }
      try {
        return await preprocess(s.spec, await readFile(item.path));
      } catch (err) {
        const msg = (err as Error).message;
        results[k] = { id: item.id, ok: false, code: /unsupported image format/i.test(msg) ? 'UNSUPPORTED' : 'DECODE', message: msg };
        return null;
      }
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
    const buf = new Float32Array(n * per);
    chunk.forEach((k, j) => buf.set(inputs[k]!, j * per));
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
      void state?.session.release().finally(() => process.exit(0));
      if (!state) process.exit(0);
      break;
  }
});
