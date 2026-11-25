# Auto-pilot: wait for a level to go live, then run the whole offline pipeline on it.
#
#   powershell -File watch.ps1                 # 3 solver orderings per level, 600 s cap
#   powershell -File watch.ps1 -MaxSec 900 -Workers 4
#
# One attempt per levelKey. A level that cannot be solved in the budget is left alone
# (nothing is clicked); tap 下一关 / restart the level and the watcher picks up whatever
# level is live next. Every stage is gated, so a stale seed can never reach the board.
param(
  [int]$MaxSec = 600,
  [int]$Workers = 3,
  [int]$PollSec = 4,
  [string]$Ws = 'ws://[::1]:62000'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CDP_WS = $Ws
$env:EVAL_WAIT_MS = '8000'

$done = @{}
Write-Host ('[watch] polling every ' + $PollSec + 's; waiting for a live board')

while ($true) {
  try {
    Remove-Item (Join-Path $PSScriptRoot 'watch_state.json') -ErrorAction SilentlyContinue
    node eval_cdp.js --file probe_state.js --out watch_state.json 2>&1 | Out-Null
    $s = Get-Content (Join-Path $PSScriptRoot 'watch_state.json') -Raw | ConvertFrom-Json
  } catch {
    Start-Sleep -Seconds $PollSec
    continue
  }
  if (-not $s -or -not $s.board) { Start-Sleep -Seconds $PollSec; continue }

  $lk = [string]$s.board.levelKey
  $n = [int]$s.board.blocks
  $init = [bool]$s.board.init
  $win = [bool]$s.level.gameIsWin

  if ($win -or -not $init -or $n -le 0) {
    Start-Sleep -Seconds $PollSec
    continue
  }
  if ($done.ContainsKey($lk)) {
    Start-Sleep -Seconds $PollSec
    continue
  }

  $done[$lk] = $true
  Write-Host ('[watch] level ' + $lk + ' live with ' + $n + ' blocks -> solving')
  $t0 = Get-Date
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run_offline.ps1') -MaxSec $MaxSec -Workers $Workers -Ws $Ws
  $code = $LASTEXITCODE
  $sec = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  Write-Host ('[watch] level ' + $lk + ' finished exit=' + $code + ' in ' + $sec + 's')
  if ($code -ne 0) {
    Write-Host '[watch] that level was not played. Tap NEXT LEVEL / retry to load a new board.'
  }
  Start-Sleep -Seconds 3
}
