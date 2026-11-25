# Pre-flight check: run this BEFORE spending the one daily attempt.
#
#   powershell -File preflight.ps1
#
# Verifies, in order:
#   1  the CDP proxy is listening (62000 + 9421)
#   2  the game process actually executes JS right now (pause/eval works)
#   3  the seed hook is installed and the transport wrapper is active
# Prints READY only when all three pass. Exit 0 = ready, 1 = not ready.
param([string]$Ws = 'ws://[::1]:62000')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CDP_WS = $Ws
$env:EVAL_WAIT_MS = '8000'

$ok = $true
$note = @()

# --- 1) proxy ports -----------------------------------------------------------
foreach ($port in 62000, 9421) {
  $l = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($l) { Write-Host ('[preflight] port ' + $port + ' .......... listen (pid ' + $l.OwningProcess + ')') }
  else { Write-Host ('[preflight] port ' + $port + ' .......... MISSING'); $ok = $false }
}

# --- 2) the client is running JS ----------------------------------------------
node eval_cdp.js --file read_mapinfo.js --out preflight.json 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Host ('[preflight] eval ............... ' + $_) }
if ($LASTEXITCODE -ne 0) {
  Write-Host '[preflight] eval ............... FAIL'
  $ok = $false
  $note += 'The client is idle (win screen / paused / game not opened). Tap NEXT LEVEL or open the game, then rerun.'
}

# --- 3) hook + transport -------------------------------------------------------
if ($ok) {
  node inject.js hook_map.js $Ws 15000 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Host ('[preflight] hook ............... ' + $_) }
  Start-Sleep -Milliseconds 1200
  node eval_cdp.js --file read_mapinfo.js --out preflight2.json 2>&1 | Out-Null
  if (Test-Path (Join-Path $PSScriptRoot 'preflight2.json')) {
    $mi = (Get-Content (Join-Path $PSScriptRoot 'preflight2.json') -Raw | ConvertFrom-Json).mapInfo
    if ($mi) {
      $wxOn = [bool]$mi.wx
      $has = [bool]$mi.hasServerInfo
      Write-Host ('[preflight] transport .......... ' + $(if ($wxOn) { 'wx.request wrapped (raw response capture on)' } else { 'wrapper not installed yet; polling fallback is authoritative' }))
      Write-Host ('[preflight] level data ......... ' + $(if ($has) { 'present (seed already captured)' } else { 'not loaded yet' }))
      if ($mi.mapSeed) {
        Write-Host ('[preflight] seed ............... ' + ($mi.mapSeed -join ','))
        $note += 'A level is already live - the attempt may already be spent.'
      }
    }
  }
  Remove-Item (Join-Path $PSScriptRoot 'preflight.json') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $PSScriptRoot 'preflight2.json') -ErrorAction SilentlyContinue
}

# --- verdict -------------------------------------------------------------------
Write-Host ''
if ($ok) {
  Write-Host '[preflight] verdict ............ READY - tap the game start button now'
  if ($note.Count) { $note | ForEach-Object { Write-Host ('[preflight] note: ' + $_) } }
  exit 0
} else {
  Write-Host '[preflight] verdict ............ NOT READY - do not tap start yet'
  $note | ForEach-Object { Write-Host ('[preflight] note: ' + $_) }
  exit 1
}
