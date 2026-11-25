# Full offline pipeline: capture seed -> rebuild board -> match live -> solve (no props) -> play.
#
#   powershell -File run_offline.ps1                     # 3 parallel restarts, 600 s each
#   powershell -File run_offline.ps1 -MaxSec 900 -Jobs 4
#   powershell -File run_offline.ps1 -AnalyzeOnly        # stop after the solver verdict
#
# Gates, in order - any failure stops before a single click reaches the game:
#   1 seed captured from the running client (hook_map.js)
#   2 board rebuilt offline from (nowLevelData, map_seed)
#   3 rebuilt board identical to the live board (id:type on every block)
#   4 solver returns a WIN plan using board clicks only (no props, no parking)
#   5 verify_plan3 replays that plan and reaches an empty table
param(
  [int]$MaxSec = 600,
  [int]$Workers = 3,
  [int]$RandSeed = 12345,
  [switch]$AnalyzeOnly,
  [string]$Ws = 'ws://[::1]:62000'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CDP_WS = $Ws

# The hook lives inside the mini program process: any WeChat restart, account switch or
# mini program reload wipes it. Re-install every run - it is idempotent and takes ~1 s.
Write-Host '[0/5] install seed hook'
node inject.js hook_map.js $Ws 25000 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) {
  Write-Host 'stop: could not inject into the mini program. Open the game window, then rerun.'
  exit 7
}

Write-Host '[1/5] capture map_seed + level data'
powershell -NoProfile -ExecutionPolicy Bypass -File gen_from_seed.ps1 -Ws $Ws
if ($LASTEXITCODE -ne 0) { Write-Host 'stop: no seed captured'; exit 1 }
# Read the pointer as UTF-8: under a non-ASCII install path (Chinese folder name),
# PowerShell 5.1's default ANSI read and -Encoding ascii writes both mangle it.
$lb = Join-Path $PSScriptRoot 'last_board.txt'
$board = ''
if (Test-Path $lb) { $board = [System.IO.File]::ReadAllText($lb, (New-Object System.Text.UTF8Encoding($false))).Trim() }
if (-not $board -or $board.Contains('?') -or -not (Test-Path $board)) {
  $cand = Get-ChildItem $PSScriptRoot -Filter 'leveldata.seed_*.board.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($cand) { $board = $cand.FullName; Write-Host ('[1/5] pointer unusable, using newest board: ' + $cand.Name) }
}
if (-not $board -or -not (Test-Path $board)) { Write-Host ('stop: board file missing -> ' + $board); exit 2 }
Write-Host ('[1/5] board = ' + (Split-Path $board -Leaf))

Write-Host '[2/5] dump live board'
node eval_cdp.js --file dump_board_raw.js --out live_gen.json | Out-Null

Write-Host '[3/5] generated vs live'
node diff_board.js $board live_gen.json
if ($LASTEXITCODE -ne 0) { Write-Host 'stop: generated board does not match the live board'; exit 3 }

# The 246-card board is solvable without props, but not in seconds: 100-210 s of search per
# ordering is typical. Each job keeps its own failure table, so parallel orderings multiply
# the reach instead of duplicating it, and the first verified plan wins.
Write-Host "[4/5] solve with board clicks only (no props), $Workers parallel orderings, $MaxSec s cap"
$dir = $PSScriptRoot
Get-ChildItem (Join-Path $dir 'nopark_*.plan.json') -ErrorAction SilentlyContinue | Remove-Item -Force
$jobList = @()
for ($k = 1; $k -le $Workers; $k++) {
  $jobList += Start-Job -ScriptBlock {
    param($d, $b, $sec, $sd, $k)
    Set-Location $d
    $env:PLAN_OUT = "nopark_$k.plan.json"
    $env:HAND_MAX = '7'
    Remove-Item Env:PREFIX -ErrorAction SilentlyContinue
    Remove-Item Env:PREFIX_STEPS -ErrorAction SilentlyContinue
    if ($sec -gt 60) { $env:SLICE_MS = '30000' } else { $env:SLICE_MS = '0' }
    & node dfs_nopark.js $b $sec 1200000000 $sd 2>&1 | Select-Object -Last 1
  } -ArgumentList $dir, $board, $MaxSec, ($RandSeed + $k * 7919), $k
}
$jobList | Wait-Job -Timeout ($MaxSec + 180) | Out-Null
foreach ($j in $jobList) { Write-Output (Receive-Job $j) }
$jobList | Remove-Job -Force -ErrorAction SilentlyContinue

$plan = $null
for ($k = 1; $k -le $Workers; $k++) {
  $p = Join-Path $dir "nopark_$k.plan.json"
  if (Test-Path $p) { $plan = $p; break }
}
if (-not $plan) {
  Write-Host 'stop: no no-prop win found in this budget. The board is untouched.'
  Write-Host 'next: powershell -File diagnose.ps1   # separates "search was too short" from "this shuffle needs props"'
  exit 4
}
Write-Host ('plan -> ' + (Split-Path $plan -Leaf))

Write-Host '[5/5] independent replay'
node verify_plan3.js $board $plan 2>&1 | Select-Object -Last 2
if ($LASTEXITCODE -ne 0) { Write-Host 'stop: replay failed'; exit 5 }

if ($AnalyzeOnly) { Write-Host 'analyze-only: plan verified, board untouched'; exit 0 }

Write-Host '[play] inject bot + load plan + start'
node inject.js hold_on.js $Ws 30000 | Out-Null
node inject.js bot.js $Ws 30000 | Out-Null
node apply_plan.js (Split-Path $plan -Leaf)
if ($LASTEXITCODE -ne 0) { Write-Host 'stop: plan could not be loaded onto the live board'; exit 6 }
node eval_cdp.js --file start_bot.js
