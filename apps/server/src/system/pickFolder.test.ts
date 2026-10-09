import { describe, expect, it, vi } from 'vitest';

// 真的跑会弹窗：换成一个失败的 PowerShell
const failure = vi.hoisted(() => ({ err: null as unknown }));
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: object, cb: (err: unknown) => void) => cb(failure.err),
}));
const { pickFolder, psErrorLine } = await import('./pickFolder.ts');

// -EncodedCommand 时 PowerShell 的 stderr 长这样（实测，节选）
const CLIXML =
  '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Object</T></TN></Obj>' +
  '<S S="Error">Add-Type : 未能找到路径“F:\\nope\\不存在.cs”的一部分。_x000D__x000A_</S><S S="Error">所在位置 行:1 字符: 34_x000D__x000A_</S>' +
  '<S S="Error">+ ... &apos;Stop&apos;; Add-Type -LiteralPath &apos;F:/nope/不存在.cs&apos; &amp;_x000D__x000A_</S></Objs>';

describe('psErrorLine', () => {
  it('CLIXML 取第一行错误', () => expect(psErrorLine(CLIXML)).toBe('Add-Type : 未能找到路径“F:\\nope\\不存在.cs”的一部分。'));
  it('普通文本取第一个非空行，太长截断', () => {
    expect(psErrorLine('\r\n  出错了 \r\n第二行')).toBe('出错了');
    expect(psErrorLine('x'.repeat(300))).toHaveLength(201);
    expect(psErrorLine('')).toBe('');
  });
});

describe.skipIf(process.platform !== 'win32')('pickFolder 出错', () => {
  const commandLine = `Command failed: powershell.exe -NoProfile -STA -WindowStyle Hidden -EncodedCommand ${'JABFAHIAcgBvAHIA'.repeat(200)}`;

  it('不把命令行带给界面，只给 PowerShell 的错误', async () => {
    failure.err = Object.assign(new Error(commandLine), { code: 1, killed: false, stderr: CLIXML });
    const err = (await pickFolder().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('打不开选择文件夹的窗口，请直接粘贴文件夹路径。原因：Add-Type : 未能找到路径“F:\\nope\\不存在.cs”的一部分。');
    expect(err.message).not.toContain('EncodedCommand');
  });

  it('超时被杀、找不到 powershell.exe', async () => {
    failure.err = Object.assign(new Error(commandLine), { killed: true, stderr: '' });
    await expect(pickFolder()).rejects.toThrow('选择窗口开得太久');
    failure.err = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
    await expect(pickFolder()).rejects.toThrow('打不开选择文件夹的窗口，请直接粘贴文件夹路径。原因：找不到 powershell.exe');
  });
});
