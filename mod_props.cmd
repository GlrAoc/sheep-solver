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
  echo Install Node.js 22+ or add its folder to PATH.
  pause
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
:nodeok

if /i "%~1"=="--off" goto off
if /i "%~1"=="--status" goto status

echo [mod] installing unlimited remove / cancel / shuffle ...
node eval_cdp.js --file mod_infinite_props.js
if errorlevel 1 goto failed
echo [mod] done. The prop buttons no longer run out.
goto end

:off
echo [mod] restoring original counters and handlers ...
node eval_cdp.js "(function(){var G=(typeof document!=='undefined'&&document&&document.gameContext)?document.gameContext:null;return G&&G.__sheepInf?G.__sheepInf.off():'no_mod';})()"
goto end

:status
node eval_cdp.js "(function(){var G=(typeof document!=='undefined'&&document&&document.gameContext)?document.gameContext:null;return G&&G.__sheepInf?G.__sheepInf.status():'no_mod';})()"
goto end

:failed
echo [mod] injection failed - is the proxy up and the game open?
echo        run: oneclick.cmd --diagnose

:end
echo.
pause
