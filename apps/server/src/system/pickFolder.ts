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
      // 放最前面：Add-Type 出错时报错信息也是 UTF-8
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      `Add-Type -LiteralPath '${fileURLToPath(new URL('./FolderPicker.cs', import.meta.url)).replace(/'/g, "''")}'`,
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
    try {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        // 让 PowerShell 隐藏控制台，保留 WinForms 窗口的正常显示。
        windowsHide: false,
        timeout: 10 * 60_000,
      });
      return stdout.trim() || null;
    } catch (err) {
      // execFile 的报错开头是整条命令行（几 KB 的 Base64），不能原样显示在界面上
      const e = err as { killed?: boolean; code?: unknown; stderr?: string };
      if (e.killed) throw new Error('选择窗口开得太久，已经自动关掉了，请重新选择', { cause: err });
      const detail = psErrorLine(e.stderr ?? '') || (e.code === 'ENOENT' ? '找不到 powershell.exe' : '');
      throw new Error(`打不开选择文件夹的窗口，请直接粘贴文件夹路径${detail ? `。原因：${detail}` : ''}`, { cause: err });
    }
  } finally {
    busy = false;
  }
}

/** PowerShell 的报错取第一行。用 -EncodedCommand 时 stderr 是 CLIXML，要先把 <S S="Error"> 里的文字拼回来 */
export function psErrorLine(stderr: string): string {
  const text = stderr.startsWith('#< CLIXML')
    ? [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
        .map((m) => m[1]!)
        .join('')
        .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
    : stderr;
  const line = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
