@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

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
  echo [ERROR] node.exe not found.
  echo Install Node.js 18+ or add its folder to PATH.
  pause
  exit /b 1
)
set "PATH=%NODE_DIR%;%PATH%"
:nodeok

node doctor.js
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" echo [doctor] exit code %RC% -- see the arrows above.
pause
exit /b %RC%
