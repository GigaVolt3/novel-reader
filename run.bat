@echo off
setlocal
title AI Novel Reader

cd /d "%~dp0"

echo ===================================================
echo               AI Novel Reader
echo ===================================================
echo.

:: 1. Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in your PATH.
    echo Please download and install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 2. Check if node_modules exists, install if missing
if not exist "node_modules\" (
    echo [INFO] Dependencies not found. Running npm install...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo.
)

:: 3. Free port 7777 if already in use by a previous instance
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-NetTCPConnection -LocalPort 7777 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 }; if ($procs) { Write-Host '[INFO] Closing previous server instance on port 7777...'; $procs | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800 }"

:: 4. Launch browser in background after 2 seconds
start "" /b cmd /c "ping 127.0.0.1 -n 3 >nul && start http://localhost:7777"

:: 5. Start the server
echo Starting server on http://localhost:7777 ...
echo Press Ctrl+C in this window to stop the server.
echo.

node server/index.mjs

if %ERRORLEVEL% neq 0 (
    echo.
    echo [INFO] Server stopped with error code %ERRORLEVEL%.
    pause
)
