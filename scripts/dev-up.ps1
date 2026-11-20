# One-shot No996 local debug bring-up (Windows).
# Prefer: npm run dev:up
# This script is the copy-paste twin of scripts/dev-up.mjs.

$ErrorActionPreference = 'Stop'
# scripts/dev-up.ps1 → repo root
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.\package.json')) { throw "Run from repo; package.json missing at $(Get-Location)" }

$vitePort = if ($env:NO996_OPENFILM_VITE_PORT) { [int]$env:NO996_OPENFILM_VITE_PORT } else { 47825 }
$portalPort = if ($env:NO996_OPENFILM_DEBUG_PORT) { [int]$env:NO996_OPENFILM_DEBUG_PORT } else { 47821 }
$viteOrigin = if ($env:NO996_OPENFILM_VITE_ORIGIN) { $env:NO996_OPENFILM_VITE_ORIGIN } else { "http://127.0.0.1:$vitePort" }

function Test-Port([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port)
    $c.Close()
    return $true
  } catch { return $false }
}

function Resolve-DshExe {
  if ($env:DSH_APP -and (Test-Path $env:DSH_APP)) { return (Resolve-Path $env:DSH_APP).Path }
  $cmd = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if ($cmd) {
    $candidate = Join-Path $cmd.Source '..\..\..\..\DeepSeek Harness.exe'
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  }
  foreach ($path in @(
    'F:\apps\DSH_harness\DeepSeek Harness.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
  )) {
    if ($path -and (Test-Path $path)) { return $path }
  }
  throw 'Cannot find DeepSeek Harness.exe. Set $env:DSH_APP to the full exe path.'
}

if (-not (Test-Port $vitePort)) {
  Write-Host "[dev-up] starting npm run dev:live…"
  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev:live' -WorkingDirectory (Get-Location) -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Port $vitePort)) {
    if ((Get-Date) -gt $deadline) { throw "Timed out waiting for Vite :$vitePort" }
    Start-Sleep -Seconds 1
  }
} else {
  Write-Host "[dev-up] Vite already on $viteOrigin"
}

Write-Host '[dev-up] stopping DeepSeek Harness (if any)…'
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1.5

$exe = Resolve-DshExe
$env:NO996_OPENFILM_DEV_HMR = '1'
$env:NO996_OPENFILM_VITE_ORIGIN = $viteOrigin
$env:NO996_OPENFILM_DEV = '1'
Write-Host "[dev-up] launching $exe with DEV_HMR"
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe -Parent)

$deadline = (Get-Date).AddSeconds(90)
while (-not (Test-Port $portalPort)) {
  if ((Get-Date) -gt $deadline) {
    Write-Host "[dev-up] portal :$portalPort not up yet — open after Studio warm"
    break
  }
  Start-Sleep -Seconds 1
}

Write-Host ''
Write-Host "Vite HMR      : $viteOrigin"
Write-Host "Public portal : http://127.0.0.1:$portalPort/"
Write-Host 'Look for green badge: DEV HMR · 已连接'
