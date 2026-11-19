import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { startStudioProxy } from '../src/studio/studio-proxy.mjs';

/*
 * The desktop frame authenticates with this proxy's own cookie. That cookie used
 * to lapse every half hour, and the panel's recovery gate answered the resulting
 * refusals by reloading the frame: the editor "kept disconnecting". Renewal has
 * to extend the session the frame already holds — minting a second token would
 * leave the cookie header captured by an open WebSocket unauthenticated, and the
 * per-socket recheck would then close the editor's own event stream.
 *
 * These calls use node:http with an explicit one-off agent, not fetch: this
 * machine exports NODE_USE_ENV_PROXY with a NO_PROXY list that does not cover the
 * rotated 127.0.0.2 loopback the proxy binds to, so a proxied request would leave
 * for the system proxy instead of reaching the proxy under test.
 */
const KEY = 'c'.repeat(48);
const COOKIE = 'dsh_openfilm_session=';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One request against the proxy's own loopback origin. */
function call(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(origin + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method,
      agent: false, // never the environment's HTTP proxy
      headers: { ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function start(options = {}) {
  const editorUp = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const filmUp = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(''); });
  const editorPort = await listen(editorUp);
  const filmPort = await listen(filmUp);
  const previous = process.env.NO996_OPENFILM_EDITOR_PORT;
  process.env.NO996_OPENFILM_EDITOR_PORT = '0';
  let proxy;
  try {
    proxy = await startStudioProxy({
      upstream: { origin: `http://127.0.0.1:${editorPort}`, filmOrigin: `http://localhost:${filmPort}`, key: KEY },
      authenticateBrowser: () => true,
      ...options,
    });
  } catch (error) {
    await Promise.all([close(editorUp), close(filmUp)]); // never leave a listener behind
    throw error;
  } finally {
    if (previous === undefined) delete process.env.NO996_OPENFILM_EDITOR_PORT;
    else process.env.NO996_OPENFILM_EDITOR_PORT = previous;
  }
  const origin = proxy.bootstrapData().editorOrigin;
  return {
    proxy,
    origin,
    async close() { await proxy.close(); await Promise.all([close(editorUp), close(filmUp)]); },
  };
}

const desktop = (extra = {}) => start({ webOrigin: 'dsh-app://app', desktop: true, officialShell: true, ...extra });

/** Redeem a one-time grant the way the frame's own page does. */
async function redeem(origin, ticket, cookie) {
  const headers = { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  if (cookie) headers.cookie = `${COOKIE}${cookie}`;
  const response = await call(origin, '/__dsh/session', { method: 'POST', headers, body: JSON.stringify({ ticket }) });
  const setCookie = String(response.headers['set-cookie'] || '');
  return { status: response.status, setCookie, token: new RegExp(`${COOKIE}([^;]+)`).exec(setCookie)?.[1] ?? null };
}

/** Ask whether this cookie still authenticates, exactly as the panel's health probe would. */
async function admitted(origin, token) {
  if (!token) return false;
  const response = await call(origin, '/__dsh/session', { headers: { cookie: `${COOKIE}${token}`, 'sec-fetch-site': 'same-origin' } });
  return response.status === 204;
}

test('bootstrap tells the panel when the frame credential lapses', async (t) => {
  const studio = await desktop();
  t.after(() => studio.close());
  const data = studio.proxy.bootstrapData();
  assert.equal(data.sessionExpiresIn, 1800);
  const { status, token } = await redeem(studio.origin, data.ticket);
  assert.equal(status, 204);
  assert.ok(token && /^[A-Za-z0-9_-]{43}$/.test(token));
  assert.equal(await admitted(studio.origin, token), true);
  assert.equal(await admitted(studio.origin, undefined), false);
});

test('a grant is single use', async (t) => {
  const studio = await desktop();
  t.after(() => studio.close());
  const { ticket } = studio.proxy.bootstrapData();
  assert.equal((await redeem(studio.origin, ticket)).status, 204);
  assert.equal((await redeem(studio.origin, ticket)).status, 403);
});

test('renewal extends the session the frame already holds instead of minting a second one', async (t) => {
  // Short lifetime so a renewal and the original deadline both fit in one test.
  const studio = await desktop({ sessionLifetimeMs: 1200 });
  t.after(() => studio.close());
  const first = await redeem(studio.origin, studio.proxy.bootstrapData().ticket);
  assert.equal(first.status, 204);
  await sleep(600);
  const renewal = studio.proxy.renewalData();
  assert.ok(renewal && renewal.sessionExpiresIn === 1, 'renewal reports the refreshed lifetime');
  const second = await redeem(studio.origin, renewal.ticket, first.token);
  assert.equal(second.status, 204);
  assert.equal(second.token, first.token, 'the cookie value must not change: an open WebSocket still carries it');
  // Past the deadline the original grant would have set...
  await sleep(1000);
  assert.equal(await admitted(studio.origin, first.token), true);
});

test('without a live session a grant mints a fresh token', async (t) => {
  const studio = await desktop({ sessionLifetimeMs: 1200 });
  t.after(() => studio.close());
  const first = await redeem(studio.origin, studio.proxy.bootstrapData().ticket);
  await sleep(1400); // past the lifetime: the old session is gone
  assert.equal(await admitted(studio.origin, first.token), false);
  const replacement = await redeem(studio.origin, studio.proxy.renewalData().ticket, first.token);
  assert.equal(replacement.status, 204);
  assert.notEqual(replacement.token, first.token);
  assert.equal(await admitted(studio.origin, replacement.token), true);
});

test('only a desktop frame has a proxy-owned credential to renew', async (t) => {
  // Browser mode authenticates with DSH's own session cookie, which this proxy
  // neither mints nor extends.
  const studio = await start({ webOrigin: 'http://127.0.0.1:5999' });
  t.after(() => studio.close());
  assert.equal(studio.proxy.renewalData(), null);
  assert.equal(studio.proxy.bootstrapData().sessionExpiresIn, undefined);
});

test('the lifetime is bounded rather than silently accepted', async () => {
  await assert.rejects(desktop({ sessionLifetimeMs: 10 }), /sessionLifetimeMs/);
  await assert.rejects(desktop({ sessionLifetimeMs: 25 * 60 * 60_000 }), /sessionLifetimeMs/);
});
