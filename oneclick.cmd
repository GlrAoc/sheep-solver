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
  echo Searched PATH and: %%USERPROFILE%%\.workbuddy\binaries\node\versions\22.22.2-6
  echo Install Node.js 22+ or add its folder to PATH.
  echo.
  pause
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
echo [node] using %NODE_DIR%

:nodeok
for /f "delims=" %%V in ('node --version') do echo [node] %%V

echo ==========================================================
echo   One-click Sheep Solver   (local only, no server calls)
echo ==========================================================
echo   What it does:
echo     1. makes sure the CDP proxy on 62000 is running
echo     2. waits until a level is on the board
echo     3. dumps the real board, solves, re-verifies, clicks
echo     4. repeats for the next level automatically
echo.
echo   IMPORTANT: frida needs 20-25s after the proxy starts to load
echo     its hook ("[frida] script loaded ... pid: N"). OneClick now
echo     waits for that line before telling you to open the game.
echo     A game window opened BEFORE the hook is ready never connects,
echo     so always: start script first, open game window second.
echo ----------------------------------------------------------
echo   Options:
echo     oneclick.cmd                  clear levels until the run ends
echo     oneclick.cmd --dry            solve only, do not click
echo     oneclick.cmd --seeds 6        more parallel search seeds
echo     oneclick.cmd --solve-sec 90   longer per-seed budget
echo     oneclick.cmd --park 2         allow the solver to plan 2 "move out" props
echo     oneclick.cmd --allow-props    pre-authorise prop plans (no popup)
echo     oneclick.cmd --no-park        never plan a prop, pure clicking only
echo     oneclick.cmd --wait-sec 120   give up if no level in 120s
echo     oneclick.cmd --diagnose       print proxy/game state and exit
echo     oneclick.cmd --start-proxy    start the proxy and exit
echo     oneclick.cmd --stop-proxy     kill the proxy
echo ----------------------------------------------------------
echo.

rem ---- make sure the proxy is up (visible window, so you can see its state)
netstat -ano | findstr ":62000" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 goto proxyok

echo [proxy] not running, opening a proxy window...
start "WMPF Proxy" cmd /k "%~dp0proxy.cmd"
set /a N=0
:waitproxy
timeout /t 2 >nul
netstat -ano | findstr ":62000" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 goto proxyok
set /a N+=1
if %N% GEQ 60 goto proxytimeout
goto waitproxy

:proxytimeout
echo [proxy] port 62000 still not listening after 120s.
echo         Check the "WMPF Proxy" window for errors.
echo.
pause
exit /b 1

:proxyok
echo [proxy] 62000 is listening.
echo.

node oneclick.js --no-proxy %*
set "RC=%errorlevel%"

echo.
echo ----------------------------------------------------------
echo Exit code: %RC%
echo Logs: %~dp0logs
if "%RC%"=="1" echo Hint: proxy/game not reachable, or not inside a level yet.
if "%RC%"=="2" echo Hint: this board is unsolvable without props. Use the in-game shuffle, then run again.
if "%RC%"=="3" echo Hint: execution aborted. Read the log, nothing was blindly clicked.
echo ----------------------------------------------------------
pause
