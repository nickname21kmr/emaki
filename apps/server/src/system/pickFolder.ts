/**
 * 由后端弹出 Windows 原生「选择文件夹」对话框（浏览器拿不到绝对路径）。
 * PowerShell 5.1 + Common Item Dialog：必须 -STA；输出编码设成 UTF-8，否则中文路径乱码；
 * 用有任务栏入口的 TopMost owner，方便用户找到独立于浏览器的选择窗口。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BadRequestError, ConflictError } from '../http/errors.ts';

let busy = false;

export async function pickFolder(): Promise<string | null> {
  if (process.platform !== 'win32') throw new BadRequestError('当前系统不支持，请直接粘贴文件夹路径');
  if (busy) throw new ConflictError('已经打开了一个选择窗口');
  busy = true;
  try {
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      `Add-Type -LiteralPath '${fileURLToPath(new URL('./FolderPicker.cs', import.meta.url)).replace(/'/g, "''")}'`,
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $true; Text = 'Emaki — 选择图片文件夹'; Width = 420; Height = 120; StartPosition = 'CenterScreen'; MinimizeBox = $false; MaximizeBox = $false }",
      "$label = New-Object System.Windows.Forms.Label -Property @{ Text = '请在文件夹选择窗口中选择图片目录。'; AutoSize = $true; Left = 20; Top = 20 }",
      '$owner.Controls.Add($label)',
      '$owner.Show()',
      '$owner.BringToFront()',
      '$owner.Activate()',
      'try { $selected = [EmakiFolderPicker]::Show($owner.Handle); if ($selected) { [Console]::Out.Write($selected) } } finally { $owner.Dispose() }',
    ].join('; ');
    // -EncodedCommand 要 UTF-16LE 的 Base64：中文和引号都不用转义
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      // 让 PowerShell 隐藏控制台，保留 WinForms 窗口的正常显示。
      windowsHide: false,
      timeout: 10 * 60_000,
    });
    return stdout.trim() || null;
  } finally {
    busy = false;
  }
}
