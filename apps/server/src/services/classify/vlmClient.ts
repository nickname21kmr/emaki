import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { VlmFiles, VlmKind } from './vlmDecision.ts';

export interface VlmClient {
  classify(file: string, sha256: string): Promise<{ kind: VlmKind; fileError?: string }>;
  dispose(): Promise<void>;
}

/** One job owns one supervisor and one llama.cpp server. Nothing stays resident after the job. */
export async function startVlm(files: VlmFiles, signal: AbortSignal): Promise<VlmClient> {
  signal.throwIfAborted();
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './vlmHost.ts' : './vlmHost.js', import.meta.url));
  const child = fork(entry, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  let serverPid: number | undefined;
  let nextId = 0;
  let closing: Promise<void> | undefined;
  let fatal: Error | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const killServer = () => {
    if (serverPid) { try { process.kill(serverPid); } catch { /* already exited */ } serverPid = undefined; }
  };
  const fail = (error: Error) => {
    fatal = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.on('message', (m: any) => {
    if (m.type === 'server') { serverPid = m.pid; return; }
    if (m.type === 'server-stopped') { serverPid = undefined; return; }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value);
  });
  child.on('error', (e) => { killServer(); fail(e); });
  child.on('exit', () => { killServer(); fail(new Error('图片分类子进程已退出')); });
  const dispose = (): Promise<void> => closing ??= (async () => {
    signal.removeEventListener('abort', abort);
    fail(new Error('图片分类已停止'));
    if (child.exitCode !== null || child.signalCode !== null) { killServer(); return; }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { killServer(); child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
      else { killServer(); child.kill(); }
    });
  })();
  const abort = () => { void dispose(); };
  signal.addEventListener('abort', abort, { once: true });
  const request = (type: string, args: object, timeout: number) => new Promise<any>((resolve, reject) => {
    if (fatal || signal.aborted || !child.connected) { reject(fatal ?? new Error('图片分类已停止')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      fail(new Error(type === 'init' ? '4B 模型加载超时' : '4B 图片分类超时'));
      void dispose();
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.send({ type, id, ...args }, (error) => { if (error) { fail(error); void dispose(); } });
  });
  try {
    await request('init', { files }, 180_000);
    signal.throwIfAborted();
    return { classify: (file, sha256) => request('classify', { file, sha256 }, 90_000), dispose };
  } catch (error) { await dispose(); throw error; }
}
