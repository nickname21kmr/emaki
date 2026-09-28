/**
 * U 盘 / 网络盘没有回收站：删除前提前拒绝，给出明确提示（windows-trash.exe 自己也不会永久删除，这里是为了提示文案）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BadRequestError } from '../../http/errors.ts';

const execFileP = promisify(execFile);
const cache = new Map<string, string>();

export async function assertRecyclable(rootPath: string): Promise<void> {
  if (/^(\/\/|\\)/.test(rootPath)) throw new BadRequestError('网络路径没有回收站，已拒绝删除（避免永久删除）');
  if (process.platform !== 'win32') return;
  const letter = /^([a-zA-Z]):/.exec(rootPath)?.[1]?.toUpperCase();
  if (!letter) return;
  let type = cache.get(letter);
  if (!type) {
    try {
      // .NET 枚举名（Fixed / Removable / Network…），不受系统语言影响
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `[System.IO.DriveInfo]::new('${letter}:').DriveType.ToString()`],
        { windowsHide: true, timeout: 10_000 },
      );
      type = stdout.trim();
    } catch {
      type = 'Fixed'; // 查询失败时放行：exe 自己也不会永久删除，删除后还会逐个核实
    }
    cache.set(letter, type);
  }
  if (type !== 'Fixed') throw new BadRequestError(`${letter}: 盘（${type}）没有回收站，已拒绝删除（避免永久删除）`);
}
