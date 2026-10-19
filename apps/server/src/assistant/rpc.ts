import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

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
    this.onExit = () => {}; this.child.stdin.end(); this.child.kill(); this.fail('会话连接已关闭');
    await this.exited;
  }
}
