#!/usr/bin/env node
/**
 * Local tarball packer that mirrors `npm pack` layout without calling npm.
 *
 * Layout: package/<files…> plus bundledDependencies under package/node_modules/,
 * with each bundled package's own dependency tree beside them (npm bundles the
 * whole tree; copying only the named directory left openfilm without
 * `playwright-core`, so Studio could not start after a local install).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const devMode = process.argv.includes('--dev')
const outIndex = process.argv.indexOf('--out-dir')
if (outIndex !== -1 && !process.argv[outIndex + 1]) throw new Error('--out-dir needs a path')
const outDir = outIndex === -1 ? join(ROOT, devMode ? '.dev' : 'dist') : resolve(process.argv[outIndex + 1])
const distDir = resolve(ROOT, 'dist')
if (devMode && (outDir === distDir || outDir.startsWith(`${distDir}\\`) || outDir.startsWith(`${distDir}/`))) {
  throw new Error('pack --dev refuses to write inside dist/ (use .dev/ so dev packages are never published)')
}
const safeName = String(pkg.name || 'package').replace(/^@/, '').replace(/\//g, '-')
const outFile = join(outDir, devMode ? `dev-preview-${safeName}-${version}.tgz` : `${safeName}-${version}.tgz`)

const rawFiles = pkg.files || []
const includes = new Set(['package.json', ...rawFiles.filter(entry => !String(entry).startsWith('!'))])
const DEV_KEPT = new Set([
  'src/dev',
  'src/ui/style-lab.mjs',
  'assets/style-lab.js',
  'src/studio/studio-debug.mjs',
  'src/studio/studio-debug-redirect.mjs',
  'src/studio/studio-controller/routes/debug-url.mjs',
])
const excludes = rawFiles
  .filter(entry => String(entry).startsWith('!'))
  .map(entry => String(entry).slice(1).replace(/\/\*\*$/, '').replace(/^\/+/, ''))
  .filter(rel => !(devMode && DEV_KEPT.has(rel)))
const bundled = pkg.bundledDependencies || pkg.bundleDependencies || []

const stagingRoot = mkdtempSync(join(tmpdir(), 'dsh-openfilm-pack-'))
const pkgDir = join(stagingRoot, 'package')
const modulesDir = join(pkgDir, 'node_modules')
mkdirSync(pkgDir, { recursive: true })

function copyEntry(rel) {
  const src = join(ROOT, rel)
  if (!existsSync(src)) throw new Error(`pack: missing ${rel}`)
  cpSync(src, join(pkgDir, rel), { recursive: true, force: true })
}

for (const rel of includes) copyEntry(rel)
for (const rel of excludes) {
  const target = join(pkgDir, rel)
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
}
// Stamp distribution mode inside the packed manifest only (never modifies git-tracked files).
const stagedPkgPath = join(pkgDir, 'package.json')
const stagedPkg = JSON.parse(readFileSync(stagedPkgPath, 'utf8'))
stagedPkg.dsh = { ...(stagedPkg.dsh || {}) }
if (devMode) delete stagedPkg.dsh.releaseBuild
else stagedPkg.dsh.releaseBuild = true
writeFileSync(stagedPkgPath, `${JSON.stringify(stagedPkg, null, 2)}\n`, 'utf8')

/** The directory a package really lives in (pnpm exposes symlinks at the root). */
const real = path => {
  try { return realpathSync(path) } catch { return null }
}

/**
 * A dependency's installed directory, as seen from the package that needs it:
 * its own node_modules first (pnpm's shared store layout puts siblings there),
 * then whatever Node itself resolves.
 */
function locate(fromDir, name) {
  const local = real(join(fromDir, 'node_modules', name))
  if (local) return local
  const near = real(join(dirname(fromDir), name))
  if (near) return near
  try {
    const require = createRequire(join(fromDir, 'noop.js'))
    return real(dirname(require.resolve(`${name}/package.json`)))
  } catch { return null }
}

const bundledNames = new Set()

/**
 * Give a copied package its own dependency tree, nested the way npm bundles it.
 * pnpm keeps a bundled dependency's own node_modules and prunes top-level ones
 * that the lockfile does not name, so a shared tree would vanish on install.
 */
function fillDeps(packageDir, sourceDir, seen = new Set()) {
  const meta = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const wanted = { ...(meta.dependencies || {}), ...(meta.optionalDependencies || {}) }
  for (const name of Object.keys(wanted)) {
    const key = `${packageDir}|${name}`
    if (seen.has(key)) continue
    seen.add(key)
    let source
    try { source = locate(sourceDir, name) } catch { source = null }
    if (!source) {
      if (meta.optionalDependencies && meta.optionalDependencies[name]) continue
      throw new Error(`pack: cannot find ${name} (needed by ${meta.name || packageDir})`)
    }
    const target = join(packageDir, 'node_modules', ...name.split('/'))
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true, force: true, dereference: true })
    }
    bundledNames.add(name)
    fillDeps(target, source, seen)
  }
}

if (bundled.length) {
  mkdirSync(modulesDir, { recursive: true })
  for (const name of bundled) {
    const src = real(join(ROOT, 'node_modules', name))
    if (!src) throw new Error(`pack: bundledDependency missing node_modules/${name}`)
    const target = join(modulesDir, ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(src, target, { recursive: true, force: true, dereference: true })
    bundledNames.add(name)
    fillDeps(target, src)
  }
}

mkdirSync(outDir, { recursive: true })
if (existsSync(outFile)) rmSync(outFile)

const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
execFileSync(tar, ['-czf', outFile, '-C', stagingRoot, 'package'], { stdio: 'inherit' })
rmSync(stagingRoot, { recursive: true, force: true })

const bytes = readFileSync(outFile).byteLength
process.stdout.write(`packed ${outFile} (${bytes} bytes; modules: ${[...bundledNames].join(', ')})\n`)
