import { describe, expect, it, vi } from 'vitest';
import { JsonProcess, killAgentTreesSync } from './rpc.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('JsonProcess.close', () => {
  it('rejects pending requests and waits for the agent to exit', async () => {
    const agent = new JsonProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd());
    const pending = expect(agent.request({ type: 'never' }, 0)).rejects.toThrow('会话连接已关闭');
    await agent.close(); await pending;
    expect(agent.child.exitCode !== null || agent.child.signalCode !== null).toBe(true);
  });
  it.runIf(process.platform === 'win32')('ends commands the agent started and does not hang on their inherited stdout', async () => {
    // agent 再开一个继承 stdout 的子进程，模拟 shell 里还在跑的脚本
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
console.log(JSON.stringify({ pid: c.pid })); setInterval(() => {}, 1000);`;
    const agent = new JsonProcess(process.execPath, ['-e', script], process.cwd());
    const pid = await new Promise<number>(resolve => { agent.onEvent = message => resolve(message.pid); });
    try {
      expect(alive(pid)).toBe(true);
      const started = Date.now();
      await agent.close();
      expect(Date.now() - started).toBeLessThan(4000);
      await vi.waitFor(() => expect(alive(pid)).toBe(false));
    } finally { if (alive(pid)) process.kill(pid); }
  });
});

describe('killAgentTreesSync', () => {
  it.runIf(process.platform === 'win32')('ends every live agent and the commands it started without waiting for close()', async () => {
    // 模拟关控制台窗口：来不及走异步 close()，同步结束 cmd→ping 这类孙进程
    const script = `const c = require('node:child_process').spawn('cmd.exe', ['/c', 'ping -n 60 127.0.0.1 > nul'], { stdio: 'ignore', windowsHide: true });
console.log(JSON.stringify({ pid: c.pid })); setInterval(() => {}, 1000);`;
    const agents = [0, 1].map(() => new JsonProcess(process.execPath, ['-e', script], process.cwd()));
    const shells = await Promise.all(agents.map(agent => new Promise<number>(resolve => { agent.onEvent = message => resolve(message.pid); })));
    try {
      for (const pid of shells) expect(alive(pid)).toBe(true);
      killAgentTreesSync();
      await vi.waitFor(() => { for (const pid of [...shells, ...agents.map(a => a.child.pid!)]) expect(alive(pid)).toBe(false); }, { timeout: 2000 });
    } finally {
      for (const pid of shells) if (alive(pid)) process.kill(pid);
      await Promise.all(agents.map(agent => agent.close()));
    }
  });
});
