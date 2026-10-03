/**
 * 预处理工作线程（PreprocessPool 起的，跑在 host 子进程里）。
 * 读文件 → preprocess（sharp 解码、缩放、转成模型输入）→ 把 Float32Array 的底层内存转交给主线程，不复制。
 * 错误分类见 preprocessFile，由主线程写进结果。
 */
import { parentPort } from 'node:worker_threads';
import { findModel } from './models.ts';
import { preprocessFile } from './preprocess.ts';
import type { PreprocessReply, PreprocessRequest } from './preprocessPool.ts';

const port = parentPort;
if (!port) throw new Error('preprocessWorker 只能作为 worker_threads 运行');

port.on('message', async (m: PreprocessRequest) => {
  const spec = findModel(m.repo);
  const r = spec ? await preprocessFile(spec, m.path) : ({ ok: false, code: 'DECODE', message: `未知模型：${m.repo}` } as const);
  const reply: PreprocessReply = { id: m.id, ...r };
  port.postMessage(reply, r.ok ? [r.data.buffer as ArrayBuffer] : []);
});
