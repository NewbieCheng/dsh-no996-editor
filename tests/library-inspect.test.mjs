import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryTool } from '../src/tools/library-tool.mjs';
import { buildGradeFilterCss } from '../src/film/library-presets.mjs';

const link = {
  isProjectAgent: agent => agent?.id === 'ok',
  projectOf: () => ({ projectId: 'film123', path: 'C:/films/demo' }),
};

test('no996_library searches wordart, textmotion, filter, motion, layer and hybrid templates offline', async () => {
  const calls = [];
  const http = () => ({
    async post(path, options) {
      calls.push({ path, body: options?.body });
      return { clip: { src: 'saved/openfilm/text-text/text.html' } };
    },
    async get() { return {}; },
  });
  const tool = createLibraryTool({
    ...link,
    http,
    templates: async () => [
      { id: 'vibe-explainer', title: 'Vibe 科普剧场', description: '连续生长动画', tags: ['vibe', '科普'], prompt: 'Use continuous stage.' },
    ],
  });

  assert.equal(tool.name, 'no996_library');

  // 1. Wordart search (41 flower-text styles, zero Studio HTTP calls)
  const wa = await tool.execute({ kind: 'wordart', query: '鎏金' }, { agent: { id: 'ok' } });
  assert.equal(calls.length, 0);
  assert.match(wa.text, /openfilm\/text\/looks\/gold/);
  assert.match(wa.text, /本地免联网/);

  // 2. Textmotion & Motion & Layer search
  const tm = await tool.execute({ kind: 'textmotion', query: 'fade' }, { agent: { id: 'ok' } });
  assert.match(tm.text, /openfilm\/text\/motions\/in-fade/);

  const mot = await tool.execute({ kind: 'motion', query: 'push' }, { agent: { id: 'ok' } });
  assert.match(mot.text, /openfilm\/motions\/move-push-/);

  const lay = await tool.execute({ kind: 'layer', query: 'rectangle' }, { agent: { id: 'ok' } });
  assert.match(lay.text, /openfilm\/layers\/rectangle/);

  // 3. Hybrid template listing (No996 + OpenFilm 14 built-in templates)
  const tpl = await tool.execute({ kind: 'template', query: 'travel' }, { agent: { id: 'ok' } });
  assert.match(tpl.text, /不加班高阶动效模板/);
  assert.match(tpl.text, /vibe-explainer/);
  assert.match(tpl.text, /内置多轨结构模板/);
  assert.match(tpl.text, /openfilm\/templates\/travel-vlog/);
});

test('no996_library inspect returns complete CSS vars, LUT grade, @keyframes, and multi-track blueprint', async () => {
  const tool = createLibraryTool({
    ...link,
    http: () => ({ get: async () => ({}), post: async () => ({}) }),
    templates: async () => [{ id: 'vibe-explainer', title: 'Vibe', prompt: 'Continuous growth benchmark.' }],
  });

  const gold = await tool.execute({ inspect: 'openfilm/text/looks/gold' }, { agent: { id: 'ok' } });
  assert.match(gold.text, /--fill/);
  assert.match(gold.text, /linear-gradient/);
  assert.match(gold.text, /no996_clip/);

  const filter = await tool.execute({ inspect: 'openfilm/filters/teal-orange' }, { agent: { id: 'ok' } });
  assert.match(filter.text, /RGB LUT/);
  assert.match(filter.text, /no996_clip/);

  const motion = await tool.execute({ inspect: 'openfilm/motions/move-push-left' }, { agent: { id: 'ok' } });
  assert.match(motion.text, /motion-cut-in-push-left/);

  const tpl = await tool.execute({ inspect: 'openfilm/templates/travel-vlog' }, { agent: { id: 'ok' } });
  assert.match(tpl.text, /轨道数/);
  assert.match(tpl.text, /Summer Days/);
});

test('no996_library take on wordart copies base text component and network failure gives local fallback hint', async () => {
  const calls = [];
  const tool = createLibraryTool({
    ...link,
    http: () => ({
      async post(path, options) {
        calls.push({ path, body: options?.body });
        if (options?.body?.path?.startsWith('openfilm/audio/')) {
          throw new Error('fetch failed');
        }
        return { clip: { src: 'saved/openfilm/text-text/text.html' } };
      },
      async get() { return {}; },
    }),
  });

  const taken = await tool.execute({ take: 'openfilm/text/looks/gold' }, { agent: { id: 'ok' } });
  assert.equal(calls[0].body.path, 'openfilm/text/text');
  assert.match(taken.text, /no996_clip/);
  assert.match(taken.text, /--fill/);

  await assert.rejects(
    tool.execute({ take: 'openfilm/audio/music/calm-piano.mp3' }, { agent: { id: 'ok' } }),
    /openfilm\.dev\/library.*no996_sfx/,
  );
});

test('buildGradeFilterCss produces upstream-compatible #openfilm-look SVG LUT data URI', () => {
  const css = buildGradeFilterCss('openfilm/filters/warm-film', { mix: [1.05, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.95, 0], sat: 0.95, all: [0.04, 0.5, 0.97] }, 0.8);
  assert.match(css, /^url\("data:image\/svg\+xml,.*#openfilm-look"\)$/);
  const decoded = decodeURIComponent(css);
  assert.match(decoded, /data-look='filters\/warm-film 0\.8'/);
  assert.match(decoded, /feColorMatrix/);
  assert.match(decoded, /feComponentTransfer/);
});
