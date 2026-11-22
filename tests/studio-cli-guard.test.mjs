// The kernel CLI must not get a second Studio out of this machine. Holding the
// port is not enough on Windows (SO_REUSEADDR lets a second listener in), so the
// guard answers the CLI as the Studio it is looking for and refuses to open a
// project. These tests pin the wire contract the CLI actually reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStudioCliGuard, homeDigest, studioHome } from '../src/studio/studio-cli-guard.mjs';

const logs = () => {
  const lines = [];
  return { lines, log: { info: (event, detail) => lines.push([event, detail]), warn: (event, detail) => lines.push([event, detail]) } };
};

const freePort = () => new Promise(resolve => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

test('studioHome follows OPENFILM_HOME, else ~/.openfilm', () => {
  assert.equal(studioHome({ OPENFILM_HOME: 'C:\\tmp\\home' }), 'C:\\tmp\\home');
  assert.equal(studioHome({}), join(homedir(), '.openfilm'));
});

test('the guard answers the CLI as a Studio, but opening a project is refused', async () => {
  const port = await freePort();
  const { lines, log } = logs();
  const home = createHash('sha256').update('C:\\tmp\\one').digest('hex');
  const guard = createStudioCliGuard({ port, log, version: '0.4.0', home: () => home });
  try {
    assert.deepEqual(await guard.start(), { ok: true, state: 'held' });

    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.product, 'openfilm-studio');
    assert.equal(health.version, '0.4.0', 'a version older than the CLI would be replaced');
    assert.equal(health.home, home, 'the CLI only accepts the home it asked about');
    assert.ok(health.filmOrigin);

    const opened = await (await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-studio-key': 'x' },
      body: JSON.stringify({ path: 'C:\\film', fallback: 0, now: false }),
    })).json();
    assert.deepEqual(opened.project, null, 'the project is not taken over');
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:/);

    const page = await fetch(opened.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /不做|工作台|no996_frame/);

    assert.equal(guard.status().opens, 1);
    assert.ok(lines.some(([event]) => event === 'studio-cli-guard'));
    assert.ok(lines.some(([event]) => event === 'studio-cli-open-blocked'));
  } finally {
    await guard.stop();
  }
});

test('a real Studio already on the port is left alone', async () => {
  const port = await freePort();
  const real = createServer((_request, response) => response.end('real'));
  await new Promise(resolve => real.listen(port, '127.0.0.1', resolve));
  try {
    const { log } = logs();
    const guard = createStudioCliGuard({ port, log });
    assert.deepEqual(await guard.start(), { ok: false, state: 'occupied' });
    await guard.stop();
  } finally {
    await new Promise(resolve => real.close(resolve));
  }
});
