@echo off
REM AI Radar 每日采集（由 Windows 计划任务调用，不依赖 DSH 是否打开）
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs
echo ===== %date% %time% ===== >> logs\collect.log
node collect.mjs >> logs\collect.log 2>&1
echo exit=%ERRORLEVEL% >> logs\collect.log
endlocal
