// @ts-check
/**
 * Thin OpenFilm added-provider stub for 不加班 (no996).
 *
 * Host registers the real bridge on `globalThis[Symbol.for('no996.openfilm.voice')]`
 * before Studio serves media. This file must stay free of Host imports so the
 * official added-provider loader can import it from sharedHome/providers/no996/.
 */

const BRIDGE = Symbol.for('no996.openfilm.voice');

function bridge() {
  const value = globalThis[BRIDGE];
  if (!value || typeof value.ready !== 'function' || typeof value.run !== 'function') {
    throw new Error('不加班配音桥未就绪：请重载插件并先登录账号。');
  }
  return value;
}

export default {
  id: 'no996',
  name: '不加班',
  // Official added.mjs rejects empty env (`!p.env`). This name is never read as a
  // real secret: connection is `ready()` via Host workbench-auth, not process.env.
  env: 'NO996_WORKBENCH',
  keysUrl: '',
  billingUrl: '',
  verbs: ['voice', 'tts'],
  models: {
    tts: [{ id: 'workbench-tts', name: '不加班配音' }],
  },
  ready: () => {
    try {
      return bridge().ready() === true;
    } catch {
      return false;
    }
  },
  async run(verb, args, ctx) {
    return bridge().run(verb, args, ctx);
  },
};
