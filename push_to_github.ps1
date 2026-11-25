# 一键推送到 GitHub。需要 GitHub CLI (gh) 且已登录。
#
#   powershell -File push_to_github.ps1
#   powershell -File push_to_github.ps1 -Repo my-name -Visibility private
#
# 没装 gh 就先装：https://cli.github.com/   然后 gh auth login
param(
  [string]$Repo = 'sheep-solver',
  [ValidateSet('public', 'private')][string]$Visibility = 'public'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host 'GitHub CLI (gh) 未安装。'
  Write-Host '  安装：https://cli.github.com/'
  Write-Host '  登录：gh auth login'
  Write-Host ''
  Write-Host '或者手动上传：在 github.com 新建空仓库，然后执行：'
  Write-Host ('  git remote add origin https://github.com/<你的用户名>/' + $Repo + '.git')
  Write-Host '  git push -u origin main'
  exit 1
}

gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'gh 未登录，先执行：gh auth login'
  exit 1
}

if (-not (Test-Path '.git')) {
  git init | Out-Null
  git branch -M main
  git add -A
  git commit -m '羊了个羊离线求解：脚本、文档与验证样本' | Out-Null
}

gh repo create $Repo --$Visibility --source . --remote origin --push
if ($LASTEXITCODE -ne 0) {
  Write-Host 'push 失败。若仓库已存在，改用：'
  Write-Host ('  git remote add origin https://github.com/<你的用户名>/' + $Repo + '.git')
  Write-Host '  git push -u origin main'
  exit 2
}

Write-Host ('done -> https://github.com/<你的用户名>/' + $Repo)
