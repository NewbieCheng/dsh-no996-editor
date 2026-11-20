/**
 * OpenFilm added-provider bridging to the Host's logged-in 不加班 account.
 * Installed to `<OPENFILM_SHARED_HOME>/providers/no996/provider.mjs` on start.
 * Tokens stay in the Host (`workbench-auth`); this file holds none.
 */

const BRIDGE = Symbol.for('no996.openfilm.voice');

function bridge() {
  const instance = globalThis[BRIDGE];
  if (!instance || typeof instance.run !== 'function') {
    throw new Error('不加班媒体桥接尚未就绪，请重启 DSH 或刷新 Studio 后重试。');
  }
  return instance;
}

const DEFAULT_IMAGE_MODELS = [{
  id: 'auto',
  name: '不加班默认生图 (Auto)',
  spec: {
    ratios: ['16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '1:1', '21:9'],
    sizes: ['1k', '2k'],
    qualities: ['low', 'medium', 'high', 'xhigh', 'max'],
    refs: 3,
  },
}];

const provider = {
  id: 'no996',
  name: '不加班',
  env: 'NO996_WORKBENCH',
  keysUrl: '',
  billingUrl: '',
  verbs: ['voice', 'tts', 'image', 'web-search', 'video'],
  models: {
    tts: [{ id: 'workbench-tts', name: '不加班配音' }],
    image: [...DEFAULT_IMAGE_MODELS],
    'web-search': [{ id: 'auto', name: '不加班联网搜索' }],
    video: [{
      id: 'auto',
      name: '不加班生视频 (预留)',
      spec: { ratios: ['16:9', '9:16', '1:1'], seconds: [4, 10] },
    }],
  },
  ready: () => {
    try {
      return Boolean(globalThis[BRIDGE]?.ready?.());
    } catch {
      return false;
    }
  },
  async refresh() {
    try {
      const fn = globalThis[BRIDGE]?.listImageModels;
      if (typeof fn !== 'function') return;
      const list = await fn();
      if (Array.isArray(list) && list.length > 0) {
        provider.models.image = list;
      }
    } catch {
      // Keep default auto entry on offline or signed-out states.
    }
  },
  async run(verb, args, ctx) {
    return bridge().run(verb, args, ctx);
  },
};

export default provider;
