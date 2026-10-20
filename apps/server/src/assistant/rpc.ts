import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
/** 还活着的 agent 进程，关窗时一次性结束 */
const live = new Set<ChildProcessWithoutNullStreams>();

/**
 * 关控制台窗口时 Windows 约 5 秒后强杀后端，来不及走异步的 close()，
 * 所以同步结束所有 agent 进程树（后端一退，孙进程就脱离了树，taskkill /T 找不到）。
 */
export function killAgentTreesSync() {
  if (process.platform !== 'win32') return;
  const pids = [...live].filter(c => c.pid && c.exitCode === null && c.signalCode === null).flatMap(c => ['/PID', String(c.pid)]);
  if (pids.length) spawnSync(taskkill, ['/T', '/F', ...pids], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
}

/** Windows 上 kill() 只结束 agent 本身，它开的 shell 和脚本会在后台继续跑，所以按进程树结束。 */
function killTree(pid: number) {
  return new Promise<void>(resolve => {
    const child = spawn(taskkill, ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('exit', done); child.once('error', done);
  });
}

/** JSONL subprocess transport for agent protocols. No shell interpolation. */
export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  onEvent: (message: any) => void = () => {};
  onExit: (message: string) => void = () => {};
  private stderr = '';
  private exited: Promise<void>;
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command, args, { cwd, env, stdio: 'pipe', windowsHide: true });
    const child = this.child; live.add(child);
    child.once('exit', () => live.delete(child)); child.once('error', () => { if (!child.pid) live.delete(child); });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdin.on('error', () => {}); // A cancelled process may close stdin during a write.
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg: any; try { msg = JSON.parse(line); } catch { return; }
      const pending = msg.id != null ? this.pending.get(String(msg.id)) : undefined;
      if (pending && (msg.result !== undefined || msg.error !== undefined || msg.type === 'response')) {
        this.pending.delete(String(msg.id)); clearTimeout(pending.timer);
        if (msg.error || msg.success === false) pending.reject(new Error(typeof msg.error === 'string' ? msg.error : msg.error?.message ?? 'Agent 请求失败'));
        else pending.resolve(msg.result ?? msg.data ?? {});
      } else this.onEvent(msg);
    });
    this.child.stderr.on('data', (data) => { this.stderr = (this.stderr + String(data)).slice(-3000); });
    this.child.on('error', (err) => this.fail(err.message));
    this.child.on('exit', () => this.fail('Agent 进程已退出' + (this.stderr ? `：${this.stderr.slice(-700)}` : '')));
  }
  private fail(message: string) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear(); this.onExit(message);
  }
  send(message: unknown) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(message: Record<string, unknown>, timeout = 30000): Promise<any> {
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      // Long-lived ACP prompts settle at completion and are cancelled explicitly.
      const timer = timeout > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error('Agent 响应超时')); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer }); this.send({ ...message, id });
    });
  }
  async close() {
    this.onExit = () => {}; this.fail('会话连接已关闭');
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // 趁 agent 还活着结束整棵树；它退出后子进程就脱离了树，taskkill /T 找不到
      if (process.platform === 'win32' && this.child.pid) await killTree(this.child.pid);
      this.child.stdin.end(); this.child.kill();
    }
    // 孙进程继承了 stdout 时 'close' 会一直等它们，所以等待有上限
    let wait: NodeJS.Timeout | undefined;
    const force = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    await Promise.race([this.exited, new Promise<void>(resolve => { wait = setTimeout(resolve, 5000); })]);
    clearTimeout(force); clearTimeout(wait);
  }
}
