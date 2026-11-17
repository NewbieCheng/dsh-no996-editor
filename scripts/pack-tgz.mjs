#!/usr/bin/env node
/**
 * Local tarball packer that mirrors `npm pack` layout without calling npm
 * (this machine's npm pack exits with "Exit handler never called").
 *
 * Layout: package/<files…> plus bundledDependencies under package/node_modules/.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const outIndex = process.argv.indexOf('--out-dir')
if (outIndex !== -1 && !process.argv[outIndex + 1]) throw new Error('--out-dir needs a path')
const outDir = outIndex === -1 ? join(ROOT, 'dist') : resolve(process.argv[outIndex + 1])
const safeName = String(pkg.name || 'package').replace(/^@/, '').replace(/\//g, '-')
const outFile = join(outDir, `${safeName}-${version}.tgz`)

const entries = new Set(['package.json', ...(pkg.files || [])])
const bundled = pkg.bundledDependencies || pkg.bundleDependencies || []

const stagingRoot = mkdtempSync(join(tmpdir(), 'dsh-openfilm-pack-'))
const pkgDir = join(stagingRoot, 'package')
mkdirSync(pkgDir, { recursive: true })

function copyEntry(rel) {
  const src = join(ROOT, rel)
  if (!existsSync(src)) throw new Error(`pack: missing ${rel}`)
  cpSync(src, join(pkgDir, rel), { recursive: true, force: true })
}

for (const rel of entries) copyEntry(rel)

if (bundled.length) {
  mkdirSync(join(pkgDir, 'node_modules'), { recursive: true })
  for (const name of bundled) {
    const src = join(ROOT, 'node_modules', name)
    if (!existsSync(src)) throw new Error(`pack: bundledDependency missing node_modules/${name}`)
    // npm/pnpm may expose deps as symlinks; dereference so the tarball is self-contained.
    cpSync(src, join(pkgDir, 'node_modules', name), { recursive: true, force: true, dereference: true })
  }
}

mkdirSync(outDir, { recursive: true })
if (existsSync(outFile)) rmSync(outFile)

const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
execFileSync(tar, ['-czf', outFile, '-C', stagingRoot, 'package'], { stdio: 'inherit' })
rmSync(stagingRoot, { recursive: true, force: true })

const bytes = readFileSync(outFile).byteLength
process.stdout.write(`packed ${outFile} (${bytes} bytes)\n`)
