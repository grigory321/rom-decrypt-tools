@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ROM Studio: http://localhost:4188
echo ブラウザで上のURLを開いてください。終了するには Ctrl+C を押します。
node scripts/start.mjs
pause
