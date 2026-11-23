@echo off
set ELECTRON_RUN_AS_NODE=
pushd "%~dp0"

if not exist "dist\index.html" (
  call npm run build
)
if not exist "dist-electron\electron\main.js" (
  call npm run build
)

powershell -NoProfile -WindowStyle Hidden -Command "$dir = (Get-Location).Path; $exe = Join-Path $dir 'node_modules\electron\dist\electron.exe'; Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 250; (New-Object -ComObject Shell.Application).ShellExecute($exe, '.', $dir, 'open', 1)"

popd
exit /b 0
