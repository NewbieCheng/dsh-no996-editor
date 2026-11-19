#Requires -Version 5.1
<#
  Publish current package.json version to GitLab Package Registry.
  Reads token from .gitlab-npm-token.tmp (local) or env NPM_TOKEN.

  Usage (repo root):
    powershell -ExecutionPolicy Bypass -File .\scripts\gitlab-npm-publish.ps1
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$pkg.version
$Name = [string]$pkg.name
$Registry = [string]$pkg.publishConfig.registry
if (-not $Registry) { throw 'package.json publishConfig.registry missing' }

$token = $env:NPM_TOKEN
if (-not $token) {
  $tokenFile = Join-Path $Root '.gitlab-npm-token.tmp'
  if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
}
if (-not $token) { throw 'Set NPM_TOKEN or create .gitlab-npm-token.tmp' }

$npmrc = Join-Path $Root '.npmrc.gitlab'
@(
  "@newbiecheng:registry=$Registry"
  "$($Registry.TrimEnd('/') -replace '^https:','')/:_authToken=$token"
  # npm wants host-form auth line:
  "//gitlab.com/api/v4/projects/89041706/packages/npm/:_authToken=$token"
) | Set-Content -Path $npmrc -Encoding utf8

Write-Host "Building…"
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

Write-Host "Packing…"
node scripts/pack-tgz.mjs
if ($LASTEXITCODE -ne 0) { throw 'pack failed' }

$safeName = ($Name -replace '^@','' -replace '/','-')
$tgz = Join-Path $Root "dist\$safeName-$Version.tgz"
if (-not (Test-Path $tgz)) {
  # fallback: unscoped historical name
  $alt = Join-Path $Root "dist\dsh-no996-editor-$Version.tgz"
  if (Test-Path $alt) { $tgz = $alt } else { throw "missing tarball for $Name@$Version" }
}

Write-Host "Publishing $Name@$Version → $Registry"
# Avoid hung npm pack path: publish the tarball we already built.
$env:npm_config_userconfig = $npmrc
$env:npm_config_proxy = ''
$env:npm_config_https_proxy = ''
npm publish $tgz --access public --registry $Registry
$code = $LASTEXITCODE
Remove-Item Env:npm_config_userconfig -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "npm publish failed ($code)" }

Write-Host @"

Published $Name@$Version
Registry: $Registry
Install:  dsh plugin --profile desktop add $Name@$Version
"@
