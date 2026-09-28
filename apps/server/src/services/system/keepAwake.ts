import { spawn, type ChildProcess } from 'node:child_process';
import type { Job, KeepAwakeStatus } from '@emaki/shared';
import type { EventBus } from '../../core/events.ts';

/**
 * 后台任务运行时不让电脑休眠（用户 2026-09-28：识别跑了一夜，电脑 5 点睡着，停了 5 个多小时）。
 *
 * 有任务在跑 → 起一个小的守护子进程向系统声明「需要保持运行」；全部任务结束后再等 grace 毫秒才放开
 * （扫描 → 缩略图 → 识别是一串接力，中间有空档）。
 * - Windows：PowerShell 调 SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)，并盯着本进程，
 *   本进程没了（崩溃、被结束）它也在 20 秒内自己退出，不会一直挡着休眠。
 *   现代待机（S0 低电量待机，近几年的笔记本大多是）的电脑上，屏幕一灭系统照样进待机，只声明「系统需要」挡不住，
 *   所以在这类电脑上再加 ES_DISPLAY_REQUIRED：任务跑着时屏幕保持亮着（用户朋友 2026-09-28 反馈没生效）。
 *   守护进程第一行输出结果（ok <是否现代待机> / fail <原因>），设置页据此显示状态。
 * - macOS：caffeinate -i -w <pid>，同样随本进程退出。
 * - 其他平台：不做。
 * 合上笔记本盖子、按电源键的睡眠挡不住（那是用户自己要睡）。
 */
let current: KeepAwakeStatus = { state: 'off', screenOn: false, detail: null };
/** 给 /api/health：设置页显示「正在阻止休眠 / 没生效」 */
export const keepAwakeStatus = (): KeepAwakeStatus => current;

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
    current = { state: 'idle', screenOn: false, detail: null };
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
        void this.opts.enabled().then((on) => !on && this.release('off'), () => undefined);
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
      if (!(await this.opts.enabled().catch(() => false))) {
        current = { state: 'off', screenOn: false, detail: null };
        return;
      }
      if (this.child || !this.running.size) return;
      const child = (this.opts.spawnInhibitor ?? spawnInhibitor)();
      if (!child) {
        current = { state: 'unsupported', screenOn: false, detail: null };
        return;
      }
      this.child = child;
      current = { state: 'active', screenOn: false, detail: null };
      // 守护进程报告结果：ok 1 = 现代待机、屏幕保持亮着；fail … = 没生效
      let reported = false;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (reported) return;
        reported = true;
        const line = chunk.trim().split(/\r?\n/)[0] ?? '';
        if (line.startsWith('ok')) {
          const screenOn = line.split(' ')[1] === '1';
          current = { state: 'active', screenOn, detail: null };
          this.opts.log?.(screenOn ? '后台任务运行中：已阻止系统休眠（现代待机的电脑，屏幕会保持亮着）' : '后台任务运行中：已阻止系统休眠');
        } else {
          current = { state: 'failed', screenOn: false, detail: line.replace(/^fail\s*/, '') || '未知原因' };
          this.opts.log?.(`没能阻止系统休眠：${current.detail}`);
        }
      });
      child.once('exit', () => {
        if (this.child !== child) return;
        this.child = null;
        if (!reported) current = { state: 'failed', screenOn: false, detail: '守护进程意外退出（PowerShell 被禁用或被安全软件拦截？）' };
      });
      child.once('error', (err) => {
        if (this.child !== child) return;
        this.child = null;
        current = { state: 'failed', screenOn: false, detail: err.message };
      });
    } finally {
      this.acquiring = false;
    }
  }

  release(state: 'idle' | 'off' = 'idle') {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (current.state !== 'failed' && current.state !== 'unsupported') current = { state, screenOn: false, detail: null };
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
    // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED，再加 ES_DISPLAY_REQUIRED(2) = 0x80000003。
    // PowerShell 5.1 里十六进制字面量会变成负的 Int32，所以写十进制 uint32。
    // 现代待机：GetPwrCapabilities 的 SYSTEM_POWER_CAPABILITIES 第 20 个字节 AoAc。输出只用英文（管道按系统代码页编码）
    const script = [
      `try {`,
      `  $k = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f); [DllImport("powrprof.dll")] public static extern bool GetPwrCapabilities(byte[] c);' -Name K -Namespace EmakiAwake -PassThru`,
      `  $c = New-Object byte[] 128; $aoac = 0; if ($k::GetPwrCapabilities($c)) { $aoac = [int]$c[20] }`,
      `  $flags = [uint32]2147483649; if ($aoac) { $flags = [uint32]2147483651 }`,
      `  if ($k::SetThreadExecutionState($flags) -eq 0) { [Console]::Out.WriteLine('fail SetThreadExecutionState returned 0') } else { [Console]::Out.WriteLine("ok $aoac") }`,
      `} catch { [Console]::Out.WriteLine('fail ' + $_.Exception.Message) }`,
      `[Console]::Out.Flush()`,
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
    ].join('\n');
    return spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
  }
  if (process.platform === 'darwin') return spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
  return null;
}
