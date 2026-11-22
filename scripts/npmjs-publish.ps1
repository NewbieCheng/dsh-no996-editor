#Requires -Version 7.0
<#
  Publish the current package.json version to npmjs.org.
  Reads token from NPM_TOKEN env, .npmjs-token.tmp (local), or global ~/.npmrc
  (//registry.npmjs.org/:_authToken=...). Never prints or logs the token.

  Usage (repo root):
    pwsh -ExecutionPolicy Bypass -File .\scripts\npmjs-publish.ps1
    pwsh -ExecutionPolicy Bypass -File .\scripts\npmjs-publish.ps1 -PackageDir packages\no996-models-vision
#>
param(
  [string]$PackageDir = ''
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$TargetPath = if ($PackageDir) { (Resolve-Path $PackageDir).Path } else { $Root }
$IsMainPackage = ($TargetPath.TrimEnd('\','/') -eq $Root.TrimEnd('\','/'))

$pkg = Get-Content (Join-Path $TargetPath 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$pkg.version
$Name = [string]$pkg.name
$Registry = 'https://registry.npmjs.org/'

$token = $env:NPM_TOKEN
if (-not $token) {
  $tokenFile = Join-Path $Root '.npmjs-token.tmp'
  if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
}
if (-not $token) {
  $globalNpmrc = Join-Path $HOME '.npmrc'
  if (Test-Path $globalNpmrc) {
    foreach ($line in Get-Content $globalNpmrc) {
      if ($line -match '^\s*//registry\.npmjs\.org/:_authToken\s*=\s*"?([^"\r\n]+)"?\s*$') {
        $token = $Matches[1].Trim()
        break
      }
    }
  }
}
if (-not $token) { throw 'Set NPM_TOKEN, create .npmjs-token.tmp, or configure //registry.npmjs.org/:_authToken in ~/.npmrc' }

$npmrc = Join-Path ([System.IO.Path]::GetTempPath()) ("no996-npmjs-" + [guid]::NewGuid().ToString('N') + ".npmrc")
@(
  "$($Registry.TrimEnd('/') -replace '^https:','')/:_authToken=$token"
) | Set-Content -Path $npmrc -Encoding utf8

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("no996-npmjs-publish-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  if ($IsMainPackage) {
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
    $manifestPath = Join-Path $unpacked 'package.json'
    node -e "const fs=require('fs');const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,'utf8'));m.publishConfig={access:'public',registry:'https://registry.npmjs.org/'};fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n')" $manifestPath
    if ($LASTEXITCODE -ne 0) { throw 'manifest repack failed' }
    $publishTarget = $unpacked
  } else {
    $publishTarget = $TargetPath
  }

  Write-Host "Publishing $Name@$Version → $Registry"
  $env:npm_config_userconfig = $npmrc
  node (Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\bin\npm-cli.js') publish $publishTarget --registry $Registry --access public --loglevel notice
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
