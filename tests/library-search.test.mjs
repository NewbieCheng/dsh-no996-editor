// OpenFilm 0.4.0 narrowed the agent-facing `openfilm get` verbs to music, sounds
// and stickers, but the library itself (CC0: transitions, effects, filters, texts,
// templates) is still in the pinned package. The Host searches it in process, so
// the free-material chain keeps working without a Studio route.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_VERBS, searchBuiltInLibrary } from '../src/tools/library-search.mjs';

test('every free kind the agent may search still resolves through the pinned index', async () => {
  const cases = [
    ['transition', 'glitch', /^openfilm\/transitions\//],
    ['effect', 'grain', /^openfilm\/effects\//],
    ['filter', 'film', /^openfilm\/filters\//],
    ['text', 'title', /^openfilm\/text\//],
    ['sticker', 'heart', /^openfilm\/stickers\//],
  ];
  for (const [kind, query, id] of cases) {
    const result = await searchBuiltInLibrary(kind, query, { limit: 3 });
    assert.equal(result.code, 0, `${kind} search must answer`);
    const ids = result.lines.map(line => line.trim()).filter(line => line.startsWith('openfilm/'));
    assert.ok(ids.length > 0, `${kind} must list ids`);
    assert.match(ids[0], id, `${kind} must answer with its own library ids`);
  }
});

test('a search with no match says so instead of inventing a result', async () => {
  const result = await searchBuiltInLibrary('transition', 'zzzzz-not-a-word-zzzzz', { limit: 3 });
  assert.equal(result.code, 0);
  assert.ok(result.lines.join(' ').length > 0);
  for (const line of result.lines) assert.doesNotMatch(line.trim(), /^\d+\.\s*$/);
});

test('music, sounds and stickers stay on the Studio route (0.4.0 still serves them)', () => {
  assert.deepEqual(AGENT_VERBS, { music: 'music-search', sound: 'sfx-search', sticker: 'sticker' });
});
