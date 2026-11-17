// Declaration order is not a style question here: a Host-side `const` used before
// its declaration is a TDZ ReferenceError that fails the whole plugin ("application:
// failed", blank panel). Both incidents this repo hit are pinned below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = readFileSync(fileURLToPath(new URL('../src/studio/studio-controller.mjs', import.meta.url)), 'utf8');
const at = needle => source.indexOf(needle);

test('trackRoute is declared before the first route that uses it', () => {
  const declared = at('const trackRoute = ');
  assert.ok(declared > 0, 'trackRoute is declared');
  const firstUse = at('trackRoute(registerRoute(');
  assert.ok(firstUse > 0, 'a route uses trackRoute');
  assert.ok(declared < firstUse, 'trackRoute must be initialized before the first route block');
});

test('nativeSessions is declared before archiveState reads it', () => {
  const declared = at('const nativeSessions = ');
  const read = at('nativeSessions.get(projectId)');
  assert.ok(declared > 0 && read > 0);
  assert.ok(declared < read, 'archiveState runs at request time, but a TDZ read is still a crash');
});

test('the native agent service handle is declared before the RPC handlers read it', () => {
  const declared = at('let nativeAgentService = null;');
  const firstRead = at('nativeAgentService?.reset?.(projectId)');
  assert.ok(declared > 0 && firstRead > 0);
  assert.ok(declared < firstRead);
  assert.equal(source.includes('const nativeAgentService ='), false);
});

test('route registration bindings are initialized before the route modules', () => {
  // Incidents: `registerRoute` was passed to createSystemRoutes 45 lines above its
  // own `const` — the plugin failed to activate with "Cannot access 'registerRoute'
  // before initialization" and the entry showed as 启用失败 in the console.
  const start = at('const router = createRouter(');
  assert.ok(start > 0, 'the router is created in the controller');
  for (const name of ['registerRoute', 'trackRoute', 'rollbackRoutes']) {
    const declared = at(`const ${name} = router.`);
    assert.ok(declared > start, `${name} is bound right after the router`);
    assert.ok(declared < start + 400, `${name} must be bound beside the router, not later in the function`);
  }
  // Every module that receives a binding must come after the binding.
  for (const call of ['createSystemRoutes({', 'createAssetRoutes({', 'createDiagnosticsRoutes({']) {
    const use = at(call);
    assert.ok(use > 0, `${call} is mounted`);
    assert.ok(at('const registerRoute = router.register;') < use, `${call} is mounted after registerRoute is initialized`);
  }
});
