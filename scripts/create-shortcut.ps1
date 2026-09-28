# 在桌面建「Emaki 絵巻」快捷方式：用应用窗口打开 Emaki（没有地址栏），黑色的后台窗口最小化；关掉 Emaki 窗口就退出。
# 用法：双击仓库根目录的「创建桌面快捷方式.cmd」，或 powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Emaki 絵巻.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = Join-Path $root 'start.bat'
$s.Arguments = '--app'
$s.WorkingDirectory = $root
$s.IconLocation = (Join-Path $root 'scripts\emaki.ico') + ',0'
$s.WindowStyle = 7   # 最小化：后台窗口只在任务栏上
$s.Description = 'Emaki 絵巻：本地插画收藏'
$s.Save()
Write-Host "已在桌面创建快捷方式：$lnk"
