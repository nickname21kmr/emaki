import { spawn, type ChildProcess } from 'node:child_process';
import type { Job } from '@emaki/shared';
import type { EventBus } from '../../core/events.ts';

/**
 * 后台任务运行时不让电脑休眠（用户 2026-09-28：识别跑了一夜，电脑 5 点睡着，停了 5 个多小时）。
 *
 * 有任务在跑 → 起一个小的守护子进程向系统声明「需要保持运行」；全部任务结束后再等 grace 毫秒才放开
 * （扫描 → 缩略图 → 识别是一串接力，中间有空档）。只阻止系统睡眠，不阻止关屏。
 * - Windows：PowerShell 调 SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)，并盯着本进程，
 *   本进程没了（崩溃、被结束）它也在 20 秒内自己退出，不会一直挡着休眠。
 * - macOS：caffeinate -i -w <pid>，同样随本进程退出。
 * - 其他平台：不做。
 */
export class KeepAwake {
  private readonly running = new Set<string>();
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    bus: EventBus,
    private readonly opts: {
      /** 设置里的开关；每次要起守护进程时读一次 */
      enabled: () => Promise<boolean>;
      graceMs?: number;
      /** 测试注入 */
      spawnInhibitor?: () => ChildProcess | null;
      log?: (msg: string) => void;
    },
  ) {
    this.unsubscribe = bus.subscribe((e) => {
      if (e.type === 'job') this.onJob(e.job);
    });
  }

  get holding(): boolean {
    return this.child !== null;
  }

  private lastCheck = 0;
  private onJob(job: Job) {
    if (job.status === 'running') this.running.add(job.id);
    else this.running.delete(job.id);
    if (this.running.size) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (!this.child) void this.acquire();
      // 任务进度事件很密：顺便每 10 秒看一眼开关，设置里关掉后很快放开
      else if (Date.now() - this.lastCheck > 10_000) {
        this.lastCheck = Date.now();
        void this.opts.enabled().then((on) => !on && this.release(), () => undefined);
      }
    } else if (this.child && !this.timer) {
      this.timer = setTimeout(() => this.release(), this.opts.graceMs ?? 60_000);
      this.timer.unref();
    }
  }

  private acquiring = false;
  private async acquire() {
    if (this.acquiring) return;
    this.acquiring = true;
    this.lastCheck = Date.now();
    try {
      if (!(await this.opts.enabled().catch(() => false)) || this.child || !this.running.size) return;
      const child = (this.opts.spawnInhibitor ?? spawnInhibitor)();
      if (!child) return;
      this.child = child;
      child.once('exit', () => {
        if (this.child === child) this.child = null;
      });
      child.once('error', () => {
        if (this.child === child) this.child = null;
      });
      this.opts.log?.('后台任务运行中：已阻止系统休眠');
    } finally {
      this.acquiring = false;
    }
  }

  release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.opts.log?.('后台任务都结束了：允许系统休眠');
  }

  close() {
    this.unsubscribe();
    this.release();
  }
}

function spawnInhibitor(): ChildProcess | null {
  const pid = process.pid;
  if (process.platform === 'win32') {
    // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED；PowerShell 5.1 里十六进制字面量会变成负的 Int32，所以写十进制 uint32
    const script = [
      `$k = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace EmakiAwake -PassThru`,
      `[void]$k::SetThreadExecutionState([uint32]2147483649)`,
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
    ].join('; ');
    return spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true },
    );
  }
  if (process.platform === 'darwin') return spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
  return null;
}
