@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem 免安装版自带 runtime\node.exe，优先用它
if exist "%~dp0runtime\node.exe" (
  set "PATH=%~dp0runtime;%PATH%"
  goto run
)
where node >nul 2>nul
if errorlevel 1 (
  echo [Emaki] 没有找到 Node.js。
  echo [Emaki] 请到 https://nodejs.org/ 安装 Node.js 24 LTS 后再双击运行；
  echo [Emaki] 或者到 GitHub Releases 下载免安装版，解压后直接双击「启动 Emaki.cmd」。
  pause
  exit /b 1
)
:run
node scripts\start.mjs %*
if errorlevel 1 pause
