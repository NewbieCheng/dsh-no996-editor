#Requires -Version 5.1
<#
  Publish the current package.json version to npmjs.org.
  Reads token from .npmjs-token.tmp (local) or env NPM_TOKEN.
  The token must be a granular token with "Bypass two-factor authentication (2FA)"
  and Read and write (publish and stage) permissions; see docs/playbooks/publish.md.

  Usage (repo root):
    powershell -ExecutionPolicy Bypass -File .\scripts\npmjs-publish.ps1
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$pkg.version
$Name = [string]$pkg.name
$Registry = 'https://registry.npmjs.org/'

$token = $env:NPM_TOKEN
if (-not $token) {
  $tokenFile = Join-Path $Root '.npmjs-token.tmp'
  if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
}
if (-not $token) { throw 'Set NPM_TOKEN or create .npmjs-token.tmp' }

$npmrc = Join-Path ([System.IO.Path]::GetTempPath()) ("no996-npmjs-" + [guid]::NewGuid().ToString('N') + ".npmrc")
@(
  "$($Registry.TrimEnd('/') -replace '^https:','')/:_authToken=$token"
) | Set-Content -Path $npmrc -Encoding utf8

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("no996-npmjs-publish-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  Write-Host "Building…"
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  Write-Host "Packing…"
  node scripts/pack-tgz.mjs
  if ($LASTEXITCODE -ne 0) { throw 'pack failed' }

  $tgz = Join-Path $Root "dist\$($Name -replace '^@','' -replace '/','-')-$Version.tgz"
  if (-not (Test-Path $tgz)) { throw "missing tarball for $Name@$Version" }

  # The packed manifest pins publishConfig.registry to another registry; repack a
  # temp copy with npmjs so `npm publish <dir>` cannot route elsewhere.
  $unpacked = Join-Path $stage 'package'
  & tar -xzf $tgz -C $stage
  if ($LASTEXITCODE -ne 0) { throw 'tar extract failed' }
  # Never let PowerShell rewrite a manifest: Windows PowerShell 5.1 emits UTF-8
  # *with BOM* for -Encoding utf8 (and ConvertTo-Json uses CRLF), which makes
  # the packed package.json unparseable for strict JSON readers such as the
  # DSH plugin manager ("Unexpected token '﻿'"). Node writes BOM-free LF.
  $manifestPath = Join-Path $unpacked 'package.json'
  node -e "const fs=require('fs');const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,'utf8'));m.publishConfig={access:'public',registry:'https://registry.npmjs.org/'};fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n')" $manifestPath
  if ($LASTEXITCODE -ne 0) { throw 'manifest repack failed' }

  Write-Host "Publishing $Name@$Version → $Registry"
  $env:npm_config_userconfig = $npmrc
  node (Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\bin\npm-cli.js') publish $unpacked --registry $Registry --access public --loglevel notice
  $code = $LASTEXITCODE
  Remove-Item Env:npm_config_userconfig -ErrorAction SilentlyContinue
  if ($code -ne 0) { throw "npm publish failed ($code)" }

  Write-Host "`nPublished $Name@$Version"
  Write-Host "Registry: $Registry"
  Write-Host "Install:  dsh plugin --profile desktop add $Name@$Version"
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $npmrc -Force -ErrorAction SilentlyContinue
}
