import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchAuth } from '../src/auth/workbench-auth.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('dev mode: status is a synthetic local session, no fetch, no file', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-dev-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let called = 0;
  const auth = createWorkbenchAuth({
    dev: true,
    home,
    fetchImpl: () => { called += 1; throw new Error('dev must not reach the network'); },
  });
  const status = await auth.status();
  assert.equal(status.loggedIn, true);
  assert.equal(status.dev, true);
  assert.equal(status.account, 'dev@local');
  assert.equal(status.displayName, 'Dev mode');
  assert.equal(called, 0);
  assert.equal(existsSync(join(home, 'no996-openfilm', 'workbench-auth.json')), false);
  const out = await auth.logout();
  assert.equal(out.loggedIn, true);
  assert.equal(out.dev, true);
});

test('dev mode: captcha still calls the real workbench SVG API', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-dev-captcha-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let seen = '';
  const auth = createWorkbenchAuth({
    dev: true,
    home,
    fetchImpl: async (url) => {
      seen = String(url);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            data: {
              id: 'c-dev',
              type: 'click',
              svg: '<svg data-captcha-id="x"></svg>',
              prompt: 'click_icon',
              icon_target: 'fish',
            },
          });
        },
      };
    },
  });
  const captcha = await auth.captcha('click');
  assert.match(seen, /\/api\/v1\/auth\/captcha\?type=click/);
  assert.equal(captcha.id, 'c-dev');
  assert.equal(captcha.svg, '<svg data-captcha-id="x"></svg>');
  assert.equal(captcha.prompt, 'click_icon');
  assert.equal(captcha.icon_target, 'fish');
});

test('without dig mode and without a session, status is logged out', async (t) => { // dig→dev naming kept in next edit
  const home = mkdtempSync(join(tmpdir(), 'openfilm-nodev-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const auth = createWorkbenchAuth({ dev: false, home, fetchImpl: () => { throw new Error('no network'); } });
  const status = await auth.status();
  assert.equal(status.loggedIn, false);
  assert.equal(status.dev, undefined);
});

test('the environment check is source now, and nothing probes on load', () => {
  const source = readFileSync(join(root, 'assets', 'shell-ui.js'), 'utf8');
  // Moved into the shell source (apps/desktop/shell/EnvironmentNotice.tsx).
  assert.doesNotMatch(source, /__no996CheckTools=/);
  // 页面加载时不得直接调用 run()：旧代码在环境面板 IIFE 末尾就跑了。
  assert.equal(/\n\s{4}run\(\);\n\s{2}\)\(\);/.test(source), false);
});

test('controller enables dig only from the explicit environment flag', () => {
  const source = readFileSync(join(root, 'src', 'studio', 'studio-controller.mjs'), 'utf8');
  assert.match(source, /createWorkbenchAuth\(\{ dev: process\.env\.NO996_OPENFILM_DEV === '1' \}\)/);
  assert.match(source, /dev: status\.dev === true/);
  assert.match(source, /action\.action === 'captcha'/);
});
