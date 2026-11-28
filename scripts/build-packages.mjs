import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const entries = [
  ['packages/no996-motion-runtime/browser.mjs', 'packages/no996-motion-runtime/browser/no996-motion.js', 'No996 Motion runtime'],
  ['packages/no996-scene-kit/browser.mjs', 'packages/no996-scene-kit/browser/no996-scene.js', 'No996 Scene runtime'],
];
for (const [entry, output, name] of entries) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: output, bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', legalComments: 'inline', write: false,
    banner: { js: `'use strict';/* Generated from ${entry}. ${name}; GPL-3.0-or-later. */` },
  });
  const bytes = result.outputFiles[0].contents;
  const path = resolve(root, output);
  if (check) {
    if (!readFileSync(path).equals(bytes)) throw new Error(`${output} is stale; run npm run packages:build`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}
// The template kit keeps its historical global name and path. This emitted copy
// is checked in, while the package source is the single implementation.
const runtime = readFileSync(resolve(root, entries[0][1]));
const legacy = resolve(root, 'vendor/templates/_kit/motion/motion.js');
const emitted = Buffer.from(`/* Generated from @newbiecheng/no996-motion-runtime. Do not edit. */\n${runtime}`);
if (check) {
  if (!readFileSync(legacy).equals(emitted)) throw new Error('vendor/templates/_kit/motion/motion.js is stale');
} else writeFileSync(legacy, emitted);
console.log(`${check ? 'checked' : 'built'} ${entries.length} browser runtimes and the template compatibility copy`);
