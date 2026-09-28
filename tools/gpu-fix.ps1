#Requires -Version 5.1
# Emaki 显卡诊断 / 修复：
#   1. 列出这台电脑的显卡，以及每个程序正在用哪块显卡（看清楚占核显的是 Emaki 还是浏览器）
#   2. 把 Emaki 用的 node.exe 设成「高性能」显卡（和 Windows 设置 → 系统 → 屏幕 → 显示卡 里改是同一个开关）
# 只改当前用户的设置（HKCU），不需要管理员权限；随时可以撤销。
param([switch]$Undo)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Emaki 显卡诊断'
$PrefKey = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'

# ---------------------------------------------------------------- 显卡列表（DXGI：名字 + LUID）
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Dxgi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DESC1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
    [PreserveSig] int GetDesc1(out DESC1 desc);
  }
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIFactory1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
    [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
    [PreserveSig] bool IsCurrent();
  }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IDXGIFactory1 f);
  public static DESC1[] List() {
    Guid g = typeof(IDXGIFactory1).GUID; IDXGIFactory1 f;
    if (CreateDXGIFactory1(ref g, out f) != 0) return new DESC1[0];
    var list = new System.Collections.Generic.List<DESC1>();
    for (uint i = 0; ; i++) {
      IDXGIAdapter1 a; if (f.EnumAdapters1(i, out a) != 0) break;
      DESC1 d; if (a.GetDesc1(out d) == 0 && (d.Flags & 2) == 0) list.Add(d); // 跳过软件渲染（Microsoft Basic Render Driver）
    }
    return list.ToArray();
  }
}
'@

function LuidKey($high, $low) { '0x{0:x8}_0x{1:x8}' -f $high, $low }

$adapters = @{}
foreach ($d in [Dxgi]::List()) {
  $kind = switch ($d.VendorId) { 0x10DE { 'NVIDIA' } 0x1002 { 'AMD' } 0x8086 { 'Intel' } default { '其他' } }
  $vram = [math]::Round([double]$d.DedicatedVideoMemory.ToUInt64() / 1GB, 1)
  $adapters[(LuidKey $d.LuidHigh $d.LuidLow)] = [pscustomobject]@{ Name = $d.Description.Trim(); Vendor = $kind; VramGB = $vram }
}

# ---------------------------------------------------------------- Emaki 用的 node.exe
# 只认 Emaki 自己的 node.exe，别的软件自带的 node 不碰
$here = Split-Path -Parent $PSScriptRoot
$nodes = @()
$portableNode = Join-Path $here 'runtime\node.exe'
if (Test-Path $portableNode) {
  $nodes += (Resolve-Path $portableNode).Path          # 免安装版
} elseif (Test-Path (Join-Path $here 'scripts\start.mjs')) {
  $sysNode = Get-Command node.exe -ErrorAction SilentlyContinue   # 源码版用系统里装的 Node
  if ($sysNode) { $nodes += $sysNode.Source }
}
# 正在运行、命令行里带着 Emaki 后端 / 识别子进程的 node（工具没放在 Emaki 文件夹里时靠这个找）
foreach ($p in Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue) {
  if ($p.ExecutablePath -and $p.CommandLine -match 'apps[\\/]server|scripts[\\/]start\.mjs|tagger[\\/]host') { $nodes += $p.ExecutablePath }
}
$nodes = @($nodes | Sort-Object -Unique)

function Show-Header($t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }

Show-Header '这台电脑的显卡'
# 同一块显卡有时会被 DXGI 列两次（不同的 LUID），显示时按名字去重
foreach ($a in ($adapters.Values | Sort-Object Name -Unique)) { Write-Host ("  {0}  ({1}，显存 {2} GB)" -f $a.Name, $a.Vendor, $a.VramGB) }
$hasDiscrete = @($adapters.Values | Where-Object { $_.Vendor -in 'NVIDIA', 'AMD' -and $_.VramGB -ge 2 }).Count -gt 0
$hasIntegrated = @($adapters.Values | Where-Object { $_.Vendor -eq 'Intel' -or $_.VramGB -lt 2 }).Count -gt 0

# ---------------------------------------------------------------- 谁在用哪块显卡（采样 3 秒）
Show-Header '正在用显卡的程序（采样 3 秒）'
try {
  $samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 3 -MaxSamples 1).CounterSamples | Where-Object { $_.CookedValue -ge 1 }
  $rows = foreach ($s in $samples) {
    if ($s.InstanceName -notmatch 'pid_(\d+)_luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_.*engtype_(\w+)') { continue }
    $procId = [int]$Matches[1]; $luid = LuidKey ([Convert]::ToInt32($Matches[2], 16)) ([Convert]::ToUInt32($Matches[3], 16))
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    [pscustomobject]@{ 程序 = $proc.ProcessName; PID = $procId; 显卡 = $(if ($adapters[$luid]) { $adapters[$luid].Name } else { $luid }); 引擎 = $Matches[4]; 占用 = [math]::Round($s.CookedValue, 0) }
  }
  $rows = $rows | Group-Object 程序, PID, 显卡 | ForEach-Object { $f = $_.Group[0]; [pscustomobject]@{ 程序 = $f.程序; PID = $f.PID; 显卡 = $f.显卡; '占用%' = ($_.Group | Measure-Object 占用 -Sum).Sum } } | Sort-Object '占用%' -Descending
  if ($rows) { $rows | Select-Object -First 10 | Format-Table -AutoSize | Out-String | Write-Host } else { Write-Host '  现在没有程序在明显使用显卡。' }
  $nodeRows = @($rows | Where-Object { $_.程序 -eq 'node' })
  if ($nodeRows.Count -eq 0) {
    Write-Host '  提示：Emaki（node）现在没在用显卡。可能是还在下载模型 / 生成缩略图，识别还没开始；也可能是显卡加速没成功、退回了 CPU（看 Emaki 黑色窗口里有没有「WebGPU 不可用」）。' -ForegroundColor Yellow
  }
} catch {
  Write-Host "  读取显卡占用失败：$($_.Exception.Message)" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 当前设置
Show-Header 'Emaki 的 node.exe 显卡偏好'
if (-not $nodes) { Write-Host '  没找到 node.exe。请把这个工具放在 Emaki 文件夹里的 tools 目录下再运行。' -ForegroundColor Red }
$prefs = if (Test-Path $PrefKey) { Get-ItemProperty $PrefKey } else { $null }
foreach ($n in $nodes) {
  $v = if ($prefs) { $prefs.$n } else { $null }
  $label = switch -Regex ($v) { 'GpuPreference=2' { '高性能（独显）' } 'GpuPreference=1' { '节能（核显）' } default { '让 Windows 决定（默认）' } }
  Write-Host ("  {0}`n    → {1}" -f $n, $label)
}

# ---------------------------------------------------------------- 修改
if (-not $nodes) { Read-Host "`n按回车关闭"; exit 1 }
if ($Undo) {
  foreach ($n in $nodes) { if ($prefs -and $prefs.$n) { Remove-ItemProperty $PrefKey -Name $n } }
  Write-Host "`n已恢复成「让 Windows 决定」。重新启动 Emaki 后生效。" -ForegroundColor Green
  Read-Host "`n按回车关闭"; exit 0
}
if (-not $hasDiscrete) {
  Write-Host "`n这台电脑没找到独立显卡，不需要改。" -ForegroundColor Green
  Read-Host "`n按回车关闭"; exit 0
}
if (-not $hasIntegrated) { Write-Host "`n这台电脑只有一块显卡，一般不需要改；改了也没有坏处。" }
$ans = Read-Host "`n要把上面的 node.exe 设成「高性能（独显）」吗？输入 Y 回车确认，直接回车取消"
if ($ans -notmatch '^[Yy]') { Write-Host '已取消，什么都没改。'; Read-Host "`n按回车关闭"; exit 0 }
if (-not (Test-Path $PrefKey)) { New-Item $PrefKey -Force | Out-Null }
foreach ($n in $nodes) { New-ItemProperty $PrefKey -Name $n -Value 'GpuPreference=2;' -PropertyType String -Force | Out-Null }
Write-Host "`n已设置为高性能显卡（对新模型 PixAI / WebGPU 生效）。" -ForegroundColor Green

# 旧图用的 WD 模型走 DirectML，不看上面的系统偏好：它第一次运行时自己挑最快的显卡，结果缓存在这里。
# 删掉缓存，下次识别会重新挑一次。
$modelsDir = if ($env:EMAKI_MODELS_DIR) { $env:EMAKI_MODELS_DIR } else { Join-Path $here 'data\models' }
$dmlCache = Join-Path $modelsDir 'dml-device.json'
if (Test-Path $dmlCache) {
  Remove-Item $dmlCache -Force
  Write-Host '已删除显卡探测缓存（旧图模型 WD / DirectML 下次会重新挑最快的显卡）。' -ForegroundColor Green
}
Write-Host '接下来：关掉 Emaki 的黑色窗口，重新双击「启动 Emaki.cmd」，识别开始后再运行一次这个工具，确认 node 用的是独显。'
Write-Host '想撤销的话，双击「恢复显卡设置.cmd」。'
Read-Host "`n按回车关闭"
