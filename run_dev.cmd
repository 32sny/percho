@echo off
setlocal EnableExtensions
title Percho (dev)

set "REPO_ROOT=C:\Users\Administrator\Desktop\Percho"
if not exist "%REPO_ROOT%\packages\desktop" (
    echo [ERROR] Cannot find Percho packages/desktop directory!
    echo Looked at: %REPO_ROOT%
    pause
    exit /b 1
)

cd /d "%REPO_ROOT%\packages\desktop"
rem Clear Percho's injected esbuild path so this process uses the project dependency.
set "ESBUILD_BINARY_PATH="
echo [INFO] Starting Percho dev server...
echo [INFO] Close this window or press Ctrl+C to stop.
echo.

call npx electron-vite dev

if errorlevel 1 (
    echo.
    echo [ERROR] Percho dev exited with error code %ERRORLEVEL%.
    pause
)
