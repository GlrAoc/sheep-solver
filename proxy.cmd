@echo off
chcp 936 >nul
cd /d "%~dp0..\WMPFDebugger"
echo ==========================================================
echo   WMPFDebugger proxy  -  keep this window open
echo ==========================================================
echo   Watch for:
echo     [frida] script loaded ... pid: 6220
echo     [server] debug server waiting for miniapp to connect...
echo   Then close/reopen the game window once so it connects.
echo ==========================================================
echo.

rem ---- locate node: PATH first, then known install locations
where node >nul 2>nul
if not errorlevel 1 goto nodeok
set "NODE_DIR="
for %%D in (
  "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6"
  "%USERPROFILE%\.workbuddy\binaries\node\current"
  "%ProgramFiles%\nodejs"
  "%LOCALAPPDATA%\nvs\node"
) do (
  if not defined NODE_DIR if exist "%%~D\node.exe" set "NODE_DIR=%%~D"
)
if not defined NODE_DIR (
  echo [ERROR] node.exe not found, cannot start the proxy.
  echo Add Node.js 22+ to PATH, then run again.
  echo.
  pause
  exit /b 1
)
set "PATH=%NODE_DIR%;%PATH%"
echo [node] using %NODE_DIR%
:nodeok

rem ---- let the proxy write its own log file. OneClick reads it to find out
rem ---- which pid frida hooked. stdout redirection is lost for detached
rem ---- children on Windows, so the proxy creates the file by itself.
if not exist "%~dp0logs" mkdir "%~dp0logs"
set "MINIAPP_PROXY_LOG=%~dp0logs\proxy-manual.log"
echo [proxy] log: %MINIAPP_PROXY_LOG%
echo.

npx tsx src/index.ts --auto-detect --debug-main
echo.
echo [proxy] exited with code %errorlevel%
pause
