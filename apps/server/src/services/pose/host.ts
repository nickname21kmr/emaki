/**
 * 姿势检测子进程入口（child_process.fork）：YOLOX-L 找人，DWPose-L 出关键点。
 * 和识别子进程一样放在子进程里：session.run 会占住 JS 线程，DirectML 偶尔原生崩溃，崩了主进程只要重开。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import type * as Ort from 'onnxruntime-node';
import { cropFrame, cropInput, decodeSimcc, decodeYolox, letterbox, loadRgb, PH, personsOrFallback, PW, DET } from './image.ts';
import type { PoseChildMsg, PoseDevice, PoseInitMsg, PoseItemResult, PoseParentMsg } from './protocol.ts';

const ort = createRequire(import.meta.url)('onnxruntime-node') as typeof Ort;

process.on('disconnect', () => process.exit(0));
const send = (m: PoseChildMsg) => process.send?.(m);

let det: Ort.InferenceSession | null = null;
let pose: Ort.InferenceSession | null = null;

function options(device: PoseDevice, deviceId: number): Ort.InferenceSession.SessionOptions {
  if (device === 'dml')
    return {
      executionProviders: [{ name: 'dml', deviceId } as Ort.InferenceSession.ExecutionProviderConfig],
      enableMemPattern: false,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    };
  return { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: Math.max(1, os.availableParallelism() - 1), logSeverityLevel: 3 };
}

async function warm() {
  await det!.run({ [det!.inputNames[0]!]: new ort.Tensor('float32', new Float32Array(3 * DET * DET), [1, 3, DET, DET]) });
  await pose!.run({ [pose!.inputNames[0]!]: new ort.Tensor('float32', new Float32Array(3 * PW * PH), [1, 3, PH, PW]) });
}

async function init(m: PoseInitMsg) {
  const t0 = performance.now();
  let device: PoseDevice = 'cpu';
  let fallbackReason: string | null = null;
  if (m.device === 'dml') {
    try {
      det = await ort.InferenceSession.create(m.yoloxPath, options('dml', m.dmlDeviceId));
      pose = await ort.InferenceSession.create(m.dwposePath, options('dml', m.dmlDeviceId));
      await warm();
      device = 'dml';
    } catch (err) {
      fallbackReason = `DirectML 不可用（${(err as Error).message.split('\n')[0]}）`;
      await det?.release();
      await pose?.release();
      det = pose = null;
    }
  }
  if (!det || !pose) {
    det = await ort.InferenceSession.create(m.yoloxPath, options('cpu', 0));
    pose = await ort.InferenceSession.create(m.dwposePath, options('cpu', 0));
    await warm();
  }
  send({ type: 'ready', device, fallbackReason, loadMs: Math.round(performance.now() - t0) });
}

const GONE = new Set(['ENOENT', 'ENOTDIR']);
const PERMANENT = new Set(['EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENAMETOOLONG', 'ERR_FS_FILE_TOO_LARGE']);

async function detectOne(id: number, path: string): Promise<PoseItemResult> {
  let img;
  try {
    img = await loadRgb(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    const msg = (err as Error).message;
    if (GONE.has(code)) return { id, ok: false, code: 'ENOENT', message: '文件不存在' };
    if (code && !PERMANENT.has(code)) return { id, ok: false, code: 'IO', message: `读取失败（${code}），下次再试` };
    if (/timeout/i.test(msg)) return { id, ok: false, code: 'IO', message: `解码超时，下次再试（${msg}）` };
    return { id, ok: false, code: /unsupported image format/i.test(msg) ? 'UNSUPPORTED' : 'DECODE', message: msg };
  }
  const { input, ratio } = letterbox(img);
  const out = await det!.run({ [det!.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, DET, DET]) });
  const found = decodeYolox(out[det!.outputNames[0]!]!.data as Float32Array, ratio);
  const people = personsOrFallback(img, found);
  const n = people.length;
  const batch = new Float32Array(n * 3 * PW * PH);
  const frames = people.map((p, k) => {
    const f = cropFrame(p.box);
    cropInput(img, f.center, f.scale, batch, k);
    return f;
  });
  const r = await pose!.run({ [pose!.inputNames[0]!]: new ort.Tensor('float32', batch, [n, 3, PH, PW]) });
  const sx = r.simcc_x!;
  const sy = r.simcc_y!;
  const dims = { k: sx.dims[1]!, nx: sx.dims[2]!, ny: sy.dims[2]! };
  const persons = people.map((p, k) => {
    const { kp, ks } = decodeSimcc(sx.data as Float32Array, sy.data as Float32Array, dims, k, frames[k]!.center, frames[k]!.scale);
    return { box: p.box, score: p.score, fallback: p.fallback, kp, ks };
  });
  return { id, ok: true, w: img.w, h: img.h, persons };
}

process.on('message', (m: PoseParentMsg) => {
  void (async () => {
    if (m.type === 'shutdown') {
      await det?.release();
      await pose?.release();
      process.exit(0);
    }
    if (m.type === 'init') {
      try {
        await init(m);
      } catch (err) {
        send({ type: 'error', reqId: null, message: (err as Error).message, fatal: true });
      }
      return;
    }
    if (m.type === 'detect') {
      try {
        const results: PoseItemResult[] = [];
        for (const it of m.items) results.push(await detectOne(it.id, it.path));
        send({ type: 'result', reqId: m.reqId, results });
      } catch (err) {
        send({ type: 'error', reqId: m.reqId, message: (err as Error).message, fatal: false });
      }
    }
  })();
});
