@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORTABLE_MODE=1
start "" "%~dp0UdiskAI.exe"
