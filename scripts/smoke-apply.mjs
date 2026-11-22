// Activation smoke: `apply()` must get through assembly without throwing.
//
// Why this exists: a `const` created near the end of the controller was read while
// building the diagnose route — a TDZ ReferenceError no unit test saw, failing the
// whole plugin at load time (every RPC then answers 503).
//
// The fake ctx is a proxy, but `effect(fn)` really runs fn (Cordis calls effect
// callbacks during activation), so a swallowed callback would prove nothing. Only the
// few values the controller validates are real; everything else stays a stub.
// The warm-up `apply` starts is fire-and-forget; we exit right after assembly.
process.env.NO996_OPENFILM_EDITOR_PORT = '0';
process.env.NO996_STUDIO_CLI_GUARD = 'off';

const stub = () => {
  const fn = () => proxy;
  const proxy = new Proxy(fn, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* () { /* empty list */ };
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
};

const any = stub();
const ctx = new Proxy(any, {
  get: (target, key) => {
    if (key === 'effect') return fn => { const out = fn(); return typeof out === 'function' ? out : () => {}; };
    if (key === 'get') return () => undefined;
    if (key === 'connection') return { allowsRemoteAuthorities: false };
    if (key === 'webServer') return { getOrigin: () => 'http://127.0.0.1:1', register: () => () => {} };
    return Reflect.get(target, key);
  },
});

const { apply } = await import('../index.js');
try {
  apply(ctx);
  console.log('smoke: plugin assembly is clean');
  process.exit(0);
} catch (error) {
  console.error('smoke: plugin assembly threw:');
  console.error(error?.stack ?? error);
  process.exit(1);
}
