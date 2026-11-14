// Evidence about a refused drop: the page reports its own sighting, and the Host
// must keep that sink as closed as the client-log one.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDiagnosticsRoutes } from '../src/studio-controller/routes/diagnostics.mjs';

const BROWSER = { id: 'browser' };

function mount({ admission = () => ({ peer: BROWSER }) } = {}) {
  const routes = [];
  const logged = [];
  createDiagnosticsRoutes({
    ctx: { connection: { admit: admission, browserPeer: BROWSER } },
    log: { info: (event, fields) => logged.push({ event, ...fields }) },
    clientEvents: new Set(['switch-lost']),
    register: route => { routes.push(route); return () => {}; },
    track: dispose => dispose,
  });
  return { route: routes.find(r => r.path === '/api/no996-openfilm/drag-probe'), logged };
}

function post(route, payload) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.destroy = () => {};
  const res = {
    status: 0, writableEnded: false,
    setHeader() {}, writeHead(status) { this.status = status; return this; }, end() { this.writableEnded = true; },
  };
  const done = route.handler(req, res);
  req.emit('data', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  req.emit('end');
  return Promise.resolve(done).then(() => res);
}

test('a drag sighting is logged with the layer and what the transfer carried', async () => {
  const { route, logged } = mount();
  const res = await post(route, { layer: 'host', type: 'dragenter', types: 'Files', files: 2, target: 'DIV' });
  assert.equal(res.status, 204);
  assert.deepEqual(logged, [{ event: 'drag-probe', layer: 'host', type: 'dragenter', types: 'Files', files: 2, target: 'DIV' }]);
});

test('a foreign peer is refused, so this stays an in-app diagnostic', async () => {
  const { route, logged } = mount({ admission: () => ({ peer: { id: 'other' } }) });
  const res = await post(route, { layer: 'host', type: 'drop' });
  assert.equal(res.status, 403);
  assert.equal(logged.length, 0);
});

test('a body over the cap is refused and a malformed one is a 400', async () => {
  const { route } = mount();
  assert.equal((await post(route, { layer: 'x'.repeat(600) })).status, 413);
  assert.equal((await post(route, '{nope')).status, 400);
});

test('GET is not a way to write log lines', async () => {
  const { route } = mount();
  const req = new EventEmitter();
  req.method = 'GET';
  const res = { status: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(s) { this.status = s; return this; }, end() {} };
  await route.handler(req, res);
  assert.equal(res.status, 405);
});
