# Capture map_seed from the running client and rebuild the board offline - self contained.
#
#   powershell -File gen_from_seed.ps1
#
# Source of truth, in this order:
#   serverMapPlayInfo.map_seed   the exact 4-number array resetMapSeed() feeds to XorShift
#   nowLevelData                 the exact level layout the client decoded (levelData/blockTypeData)
# so neither the .map download nor the rendered nodes are needed.
#
# The board is written next to this script and its path goes to last_board.txt.
param(
  [string]$Info = 'mapinfo.json',
  [string]$Ws   = 'ws://[::1]:62000'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CDP_WS = $Ws
# Fail in 15 s instead of hanging on a frozen client.
$env:EVAL_WAIT_MS = '15000'

node eval_cdp.js --file read_mapinfo.js --out $Info | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'NO CAPTURE: the client is not executing JS right now (win screen / paused level).'
  Write-Host 'Tap NEXT LEVEL / CONTINUE so the level starts, then rerun. Nothing has been clicked.'
  exit 4
}

$j = Get-Content $Info -Raw | ConvertFrom-Json
$mi = $j.mapInfo
if (-not $mi) { Write-Host 'NO CAPTURE: __mapInfo missing - inject hook_map.js first'; exit 1 }

$seed = @($mi.mapSeed)
if ($seed.Count -ne 4) { Write-Host 'NO SEED YET: click 开始游戏 / 再次挑战, then rerun'; exit 2 }

node eval_cdp.js --file dump_leveldata.js --out leveldata.json | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'NO LEVEL DATA: the client stopped executing JS mid-capture. Rerun after tapping NEXT LEVEL.'
  exit 4
}
$ld = Get-Content (Join-Path $PSScriptRoot 'leveldata.json') -Raw | ConvertFrom-Json
if (-not $ld.levelData) { Write-Host 'NO LEVEL DATA: level not loaded yet'; exit 3 }

python (Join-Path $PSScriptRoot 'generate_board.py') (Join-Path $PSScriptRoot 'leveldata.json') $seed[0] $seed[1] $seed[2] $seed[3] | Select-Object -Last 1

$board = Join-Path $PSScriptRoot ('leveldata.seed_' + ($seed -join '_') + '.board.json')
if (-not (Test-Path $board)) { Write-Host 'generator produced no board file'; exit 5 }

# UTF-8, no BOM: the project may live under a non-ASCII path (e.g. a Chinese folder
# name), and -Encoding ascii would turn every such character into '?' and break the
# next stage with ENOENT.
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'last_board.txt'), $board, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('LEVEL = ' + $ld.levelKey)
Write-Host ('SEED  = ' + ($seed -join ','))
Write-Host ('MD5   = ' + (@($mi.mapMd5) -join ','))
Write-Host ('BOARD = ' + $board)
