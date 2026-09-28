import { spawn } from 'node:child_process';
import path from 'node:path';

/** 在系统文件管理器里选中文件 */
export async function revealInFileManager(abs: string): Promise<void> {
  if (process.platform === 'win32') {
    const p = path.win32.normalize(abs);
    // explorer 用自己的规则解析命令行，逗号是分隔符。必须带引号且 windowsVerbatimArguments，
    // 否则「插画, 测试.png」这种文件名会打开错误的目录。Windows 路径里不可能有 "，拼引号是安全的
    await new Promise<void>((resolve, reject) => {
      const child = spawn('explorer.exe', [`/select,"${p}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      // 不要等退出码：explorer 成功时也经常返回非 0
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [path.dirname(abs)], { detached: true, stdio: 'ignore' }).unref();
}
