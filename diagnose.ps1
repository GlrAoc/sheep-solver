# Decide whether a board can be cleared with the client's 7-slot hand at all.
#
#   powershell -File diagnose.ps1                      # last captured board, 120 s at cap 7
#   powershell -File diagnose.ps1 -Board x.board.json -Sec7 300
#
# Why this exists: a no-prop win is impossible exactly when every clearing order needs an
# 8th card in the hand, and the client refuses a click while getCrushBlockNum() >= 7
# (script-bundle-game.js: removeCardNode). No amount of extra search time crosses that line,
# so the honest answer for such a board is "this level wants the move-out prop", and it is
# better to hear it in three minutes than after half a night of restarts.
#
# The probe is a relaxation ladder: cap 8 and cap 9 accept a strict superset of the legal
# moves, so a plan they produce is a real plan - it just has to be re-checked at cap 7.
#   * ladder finds a plan whose pre-click hand never reaches 7  -> solvable, verified
#   * ladder finds a plan only at cap 8/9                       -> needs that many slots
#   * nothing at any cap                                        -> unknown, keep searching
#
# exit 0 = verified 7-slot plan (path printed)
# exit 2 = needs props (cap that worked + the offending step printed)
# exit 3 = no verdict, search again with a bigger -Sec7
# exit 1 = bad input
param(
  [string]$Board = '',
  [int]$Sec7 = 120,
  [int]$Sec8 = 120,
  [int]$Sec9 = 90,
  [int]$RandSeed = 424242
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $Board) {
  $lb = Join-Path $PSScriptRoot 'last_board.txt'
  if (Test-Path $lb) { $Board = [System.IO.File]::ReadAllText($lb, (New-Object System.Text.UTF8Encoding($false))).Trim() }
  if (-not $Board -or $Board.Contains('?') -or -not (Test-Path $Board)) {
    $cand = Get-ChildItem $PSScriptRoot -Filter 'leveldata.seed_*.board.json' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($cand) { $Board = $cand.FullName }
  }
}
if (-not $Board -or -not (Test-Path $Board)) {
  Write-Host 'missing input: board json (pass -Board, or capture a board first)'
  exit 1
}
$Board = (Resolve-Path $Board).Path
Write-Host ('board  : ' + (Split-Path $Board -Leaf))
Write-Host 'client : 7 slots (a click is refused once the hand already holds 7)'
Write-Host ''

function Invoke-Cap {
  param([int]$Cap, [int]$Sec, [string]$PlanOut)
  if ($Sec -gt 60) { $env:SLICE_MS = '30000' } else { $env:SLICE_MS = '0' }
  $env:HAND_MAX = "$Cap"
  $env:PLAN_OUT = $PlanOut
  Remove-Item Env:PREFIX -ErrorAction SilentlyContinue
  Remove-Item Env:PREFIX_STEPS -ErrorAction SilentlyContinue
  $line = & node dfs_nopark.js $Board $Sec 3000000000 $RandSeed 2>&1 | Select-Object -Last 1
  Write-Host ('  cap ' + $Cap + ' (' + $Sec + ' s): ' + $line)
  return $line
}

function Test-PlanAt7 {
  param([string]$Plan)
  $stats = & node plan_stats.js $Plan 2>&1
  $peak = ($stats | Select-String 'peak hand') -join ''
  $legalLine = ($stats | Select-String '7-slot legal') -join ''
  Write-Host ('  ' + $peak.Trim())
  Write-Host ('  ' + $legalLine.Trim())
  if (-not ($legalLine -match 'YES')) { return $false }
  & node verify_plan3.js $Board $Plan 2>&1 | Select-Object -Last 1
  return ($LASTEXITCODE -eq 0)
}

# ---- step 1: the real question ----
$p7 = Join-Path $PSScriptRoot 'diag_h7.plan.json'
Remove-Item $p7 -ErrorAction SilentlyContinue
Invoke-Cap -Cap 7 -Sec $Sec7 -PlanOut $p7 | Out-Null
if (Test-Path $p7) {
  if (Test-PlanAt7 -Plan $p7) {
    Write-Host ''
    Write-Host ('VERDICT: SOLVABLE at 7 slots - plan: ' + $p7)
    exit 0
  }
  Write-Host '  cap-7 solver wrote a plan that does not replay; treating as not found'
  Remove-Item $p7 -Force -ErrorAction SilentlyContinue
}

# ---- step 2/3: relaxation ladder, looking for a plan that happens to be 7-legal ----
$found = @()
foreach ($cap in 8, 9) {
  $sec = if ($cap -eq 8) { $Sec8 } else { $Sec9 }
  $p = Join-Path $PSScriptRoot ("diag_h$cap.plan.json")
  Remove-Item $p -ErrorAction SilentlyContinue
  Invoke-Cap -Cap $cap -Sec $sec -PlanOut $p | Out-Null
  if (-not (Test-Path $p)) { continue }
  if (Test-PlanAt7 -Plan $p) {
    Write-Host ''
    Write-Host ('VERDICT: SOLVABLE at 7 slots - found through the cap-' + $cap + ' relaxation')
    Write-Host ('plan: ' + $p)
    exit 0
  }
  $found += $cap
}

Write-Host ''
if ($found.Count -gt 0) {
  Write-Host ('VERDICT: NEEDS PROPS - no 7-slot plan in this budget, while cap ' + $found[0] +
    ' produced one immediately; that plan itself asks for more than 7 cards.')
  Write-Host 'This is strong evidence, not a proof: raise -Sec7 once before calling the shuffle dead,'
  Write-Host 'and do not spend the daily attempt on it with board clicks only.'
  exit 2
}

Write-Host 'VERDICT: UNKNOWN - no plan at cap 7/8/9 in this budget.'
Write-Host ('Retry with -Sec7 600 (or a different -RandSeed ' + ($RandSeed + 7919) + '); a cap-9 win is still worth a look.')
exit 3
