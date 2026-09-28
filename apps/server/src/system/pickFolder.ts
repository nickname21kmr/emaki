/**
 * 由后端弹出 Windows 原生「选择文件夹」对话框（浏览器拿不到绝对路径）。
 * PowerShell 5.1 + WinForms：必须 -STA；输出编码设成 UTF-8，否则中文路径乱码；
 * 用 TopMost 的 owner 窗体，避免对话框被浏览器挡住。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BadRequestError, ConflictError } from '../http/errors.ts';

let busy = false;

export async function pickFolder(): Promise<string | null> {
  if (process.platform !== 'win32') throw new BadRequestError('当前系统不支持，请直接粘贴文件夹路径');
  if (busy) throw new ConflictError('已经打开了一个选择窗口');
  busy = true;
  try {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '选择存放插画的文件夹'",
      '$d.ShowNewFolderButton = $false',
      'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
      '$owner.Dispose()',
    ].join('; ');
    // -EncodedCommand 要 UTF-16LE 的 Base64：中文和引号都不用转义
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10 * 60_000,
    });
    return stdout.trim() || null;
  } finally {
    busy = false;
  }
}
