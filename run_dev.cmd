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
rem Clear injected env inherited from the parent shell:
rem  - ESBUILD_BINARY_PATH: forces this process to use the project dependency
rem  - ELECTRON_RUN_AS_NODE: makes electron run as plain node, which fails with
rem    "does not provide an export named 'BrowserWindow'"
set "ESBUILD_BINARY_PATH="
set "ELECTRON_RUN_AS_NODE="
echo [INFO] Starting Percho dev server...
echo [INFO] Close this window or press Ctrl+C to stop.
echo.

rem "npm run dev" runs predev -> build:lan-web first (src/main/lan.ts imports the built
rem lan-web/index.html). Calling electron-vite directly skips that step and fails with
rem "Could not resolve ../lan-web/dist/lan-web/index.html?raw".
call npm run dev

if errorlevel 1 (
    echo.
    echo [ERROR] Percho dev exited with error code %ERRORLEVEL%.
    pause
)
