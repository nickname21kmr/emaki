import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function queryLibrary(file: string, sql: string, params: unknown[] = [], limit = 200, timeout = 5000): Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    // A worker thread cannot interrupt SQLite's native C loop. A subprocess can be killed.
    const worker = fork(fileURLToPath(new URL('./query-worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let result: any, error: Error | undefined;
    const timer = setTimeout(() => { error = new Error('查询超时，请缩小范围或优化 SQL'); worker.kill('SIGKILL'); }, timeout);
    worker.once('message', (message) => { result = message; });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
    worker.once('exit', () => { clearTimeout(timer); if (error || result?.error || !result) reject(error ?? new Error(result?.error ?? '查询进程已停止')); else resolve(result); });
    worker.send({ file, sql, params, limit });
  });
}
