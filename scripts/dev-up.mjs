#!/usr/bin/env node
/**
 * One-shot local debug bring-up for Windows desktop:
 *   1. Ensure Vite HMR (`npm run dev:live` on :47825) is running
 *   2. Restart DeepSeek Harness with NO996 DEV_HMR / DEV env
 *   3. Print the public portal URL (:47821)
 *
 * Usage:
 *   npm run dev:up
 *   npm run dev:up -- --dsh-only          # skip starting Vite
 *   npm run dev:up -- --no-kill           # do not stop an already-running GUI
 *   DSH_APP="F:\\apps\\DSH_harness\\DeepSeek Harness.exe" npm run dev:up
 */
import { execFileSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_PORT = Number(process.env.NO996_OPENFILM_VITE_PORT || 47825);
const PORTAL_PORT = Number(process.env.NO996_OPENFILM_DEBUG_PORT || 47821);
const VITE_ORIGIN = process.env.NO996_OPENFILM_VITE_ORIGIN || `http://127.0.0.1:${VITE_PORT}`;
const dshOnly = process.argv.includes('--dsh-only');
const noKill = process.argv.includes('--no-kill');
const styleLab = process.argv.includes('--style-lab');

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolvePort) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => resolvePort(false));
  });
}

function resolveDshExe() {
  if (process.env.DSH_APP) {
    const custom = resolve(process.env.DSH_APP);
    if (!existsSync(custom)) throw new Error(`DSH_APP not found: ${custom}`);
    return custom;
  }
  try {
    const where = execFileSync('where.exe', ['dsh.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (where) {
      // .../resources/runtime/cli/bin/dsh.cmd → install root / DeepSeek Harness.exe
      const candidate = resolve(dirname(where), '..', '..', '..', '..', 'DeepSeek Harness.exe');
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* fall through */ }
  const fallbacks = [
    'F:\\apps\\DSH_harness\\DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ];
  for (const path of fallbacks) if (path && existsSync(path)) return path;
  throw new Error('Cannot find DeepSeek Harness.exe. Set DSH_APP to the full exe path, then retry.');
}

function stopDsh() {
  try {
    execFileSync('taskkill', ['/IM', 'DeepSeek Harness.exe', '/F'], { stdio: 'ignore' });
  } catch { /* not running */ }
}

async function ensureVite() {
  if (await portOpen(VITE_PORT)) {
    console.log(`[dev-up] Vite already listening on ${VITE_ORIGIN}`);
    return;
  }
  if (dshOnly) throw new Error(`Vite is not on :${VITE_PORT}. Run npm run dev:live first, or omit --dsh-only.`);
  console.log(`[dev-up] starting npm run dev:live (Vite :${VITE_PORT})…`);
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:live'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await portOpen(VITE_PORT)) {
      console.log(`[dev-up] Vite ready at ${VITE_ORIGIN}`);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for Vite on :${VITE_PORT}`);
}

function launchDsh(exe) {
  const env = {
    ...process.env,
    NO996_OPENFILM_DEV_HMR: '1',
    NO996_OPENFILM_VITE_ORIGIN: VITE_ORIGIN,
    NO996_OPENFILM_DEV: '1',
  };
  if (styleLab) env.NO996_OPENFILM_STYLE_LAB = '1';
  console.log(`[dev-up] launching ${exe}`);
  console.log('[dev-up] env: NO996_OPENFILM_DEV_HMR=1 NO996_OPENFILM_DEV=1');
  console.log(`[dev-up] env: NO996_OPENFILM_VITE_ORIGIN=${VITE_ORIGIN}`);
  const child = spawn(exe, [], {
    cwd: dirname(exe),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  child.unref();
}

async function waitPortal() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await portOpen(PORTAL_PORT)) return true;
    await sleep(1000);
  }
  return false;
}

const exe = resolveDshExe();
await ensureVite();
if (!noKill) {
  console.log('[dev-up] stopping any running DeepSeek Harness…');
  stopDsh();
  await sleep(1500);
}
launchDsh(exe);
const ok = await waitPortal();
console.log('');
console.log('==============================================================');
console.log(' No996 DEV stack');
console.log('==============================================================');
console.log(` Vite HMR     : ${VITE_ORIGIN}`);
console.log(` Public portal: http://127.0.0.1:${PORTAL_PORT}/`);
console.log(' Desktop panel: 127.0.0.2:47822 (inside DeepSeek Harness)');
if (ok) console.log(' Portal port is listening — open the URL above; look for DEV HMR · 已连接');
else console.log(' Portal :47821 not up yet — wait for Studio warm, then refresh');
console.log('==============================================================');
