// Does the *installed* plugin still start Studio? A local `file:` install can
// prune dependencies the tarball bundled (see docs/playbooks/incident.md); this
// probe loads Studio exactly as the Host does, from the profile's copy, in a
// throwaway OPENFILM_HOME, and never touches a person's projects.
//
//   node scripts/installed-studio-probe.mjs [profile]
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const profile = process.argv[2] || 'desktop';
const pkgDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile, 'node_modules/@newbiecheng/no996-editor');
const temp = mkdtempSync(join(tmpdir(), 'openfilm-installed-probe-'));
process.env.OPENFILM_HOME = join(temp, 'home');
process.env.OPENFILM_SHARED_HOME = join(temp, 'home');

let studio;
try {
  const runtime = await import(pathToFileURL(join(pkgDir, 'src/studio/studio-runtime.mjs')).href);
  const start = await runtime.loadPinnedStudio();
  studio = await start({ port: 0, advertise: false, stays: true, openBrowser: () => {} });
  const health = await (await fetch(`http://127.0.0.1:${studio.port}/api/health`, { signal: AbortSignal.timeout(5000) })).json();
  console.log(JSON.stringify({ profile, packageDir: pkgDir, version: runtime.OPENFILM_VERSION, port: studio.port, health }, null, 1));
  if (health.product !== 'openfilm-studio' || health.app !== true) throw new Error('Studio answered, but not as a running app');
} finally {
  if (studio) await studio.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
