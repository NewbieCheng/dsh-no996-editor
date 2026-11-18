// Release-vs-developer boundary detector.
//
// Shipped `.tgz` builds both strip `src/dev/` AND stamp `dsh.releaseBuild = true`
// inside `package.json`. If either indicator says this is a shipped user
// package (or the manifest cannot be verified), fail closed: developer-only
// ports and flags must never activate.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Return `true` when running from a shipped user release package (or whenever
 * the package boundary cannot be verified as a developer workspace).
 */
export function isReleasePackage(root = DEFAULT_ROOT) {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== 'object' || pkg?.dsh?.releaseBuild === true) {
      return true;
    }
  } catch {
    return true;
  }
  return !existsSync(join(root, 'src', 'dev', 'index.mjs'));
}
