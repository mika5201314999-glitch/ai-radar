@echo off
rem AI 情报台 — 双击启动
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 缺少 Electron 运行时，正在安装...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --no-audit --no-fund
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
