import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEditableDeliverable, mergeLayerOverride } from '../src/film/editable-check.mjs';
import { createClipTool } from '../src/tools/clip-tool.mjs';

test('mergeLayerOverride preserves existing overrides and merges style/transform fields non-destructively', () => {
  const initial = [{ at: '#hero-title', t: [10, 20], style: { color: '#111', fontSize: 32 } }];
  const next = mergeLayerOverride(initial, { at: '#hero-title', s: 1.25, style: { color: '#fff' } });
  assert.equal(next.length, 1);
  assert.deepEqual(next[0], {
    at: '#hero-title',
    t: [10, 20],
    s: 1.25,
    style: { color: '#fff', fontSize: 32 },
  });
  // Existing list untouched (pure)
  assert.equal(initial[0].s, undefined);
  assert.equal(initial[0].style.color, '#111');
});

test('checkEditableDeliverable verifies DOM/SVG layers + requiredObjects and blocks Canvas-baked text cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-check-'));
  try {
    writeFileSync(join(dir, 'page-ok.html'), `<!doctype html><body>
      <h1 data-element-id="title-1">Headline</h1>
      <img data-element-id="avatar-1" src="portrait.png" />
    </body>`);
    writeFileSync(join(dir, 'film.html'), `<film><section><iframe id="slide-1" src="page-ok.html" at="0"></iframe></section></film>`);

    const pass = await checkEditableDeliverable(dir, {
      requiredObjects: [{ clipId: 'slide-1', elementId: 'avatar-1' }, { clipId: 'slide-1', elementId: 'title-1' }],
    });
    assert.equal(pass.ok, true);
    assert.equal(pass.roundtripVerified, true);

    // Canvas fillText with zero DOM elements -> blocked!
    writeFileSync(join(dir, 'page-bad.html'), `<!doctype html><body>
      <canvas id="c" width="1280" height="720"></canvas>
      <script>ctx.fillText('Baked text', 100, 100);</script>
    </body>`);
    writeFileSync(join(dir, 'film.html'), `<film><section><iframe id="slide-bad" src="page-bad.html" at="0"></iframe></section></film>`);

    const fail = await checkEditableDeliverable(dir, {
      requiredObjects: [{ clipId: 'slide-bad', elementId: 'title-1' }],
    });
    assert.equal(fail.ok, false);
    assert.ok(fail.issues.some((i) => i.includes('Canvas fillText')));
    assert.ok(fail.issues.some((i) => i.includes('elementId="title-1"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no996_clip op="layer" merges overrides non-destructively via /edit with base rev', async () => {
  const calls = [];
  const tool = createClipTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'proj123', path: 'ignored', available: true }),
    http: () => ({
      get: async (url) => {
        calls.push({ method: 'GET', url });
        return {
          rev: 'rev-7',
          doc: {
            tracks: [{ index: 0, locked: false, clips: [{ id: 'clip-1', loc: 'track:0/clip:0', overrides: [{ at: '.t', text: '旧标题', style: { color: '#000' } }] }] }],
          },
        };
      },
      post: async (url, opts) => {
        calls.push({ method: 'POST', url, opts });
        return { rev: 'rev-8' };
      },
    }),
  });

  const out = await tool.execute({
    operations: [{
      op: 'layer',
      clip: 'clip-1',
      selector: '.t',
      t: [20, -10],
      layerStyle: { fontSize: 48 },
    }],
  }, { agent: {} });

  const editCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/edit'));
  assert.ok(editCall);
  const body = editCall.opts.body;
  assert.equal(body.base, 'rev-7');
  assert.equal(body.ops[0].op, 'props');
  assert.equal(body.ops[0].edits[0].clip, 'clip-1');
  assert.equal(body.ops[0].edits[0].prop, 'overrides');
  assert.deepEqual(body.ops[0].edits[0].value, [{
    at: '.t',
    text: '旧标题',
    t: [20, -10],
    style: { color: '#000', fontSize: 48 },
  }]);
  assert.ok(out.text.includes('rev-8'));
});
