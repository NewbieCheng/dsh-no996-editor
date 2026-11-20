import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditingArchiveBatch } from '../src/project/editing-archive-batch.mjs';
import { studioFailureSummary } from '../src/studio/panel-failure.mjs';

test('only verified idle conversations enter the recoverable archive batch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'no996-editing-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = ['idle', 'busy', 'manual', 'foreign'].map(projectId => ({ projectId, sessionId: `session-${projectId}` }));
  const archived = new Set(['session-manual']);
  const calls = [];
  const create = () => createEditingArchiveBatch({ file: join(dir, 'receipt.json'), bindings: { all: () => rows },
    verify: async id => id !== 'foreign', isBusy: row => row.projectId === 'busy',
    archive: { available: true, state: id => archived.has(id) ? 'archived' : 'live',
      archive: async (...args) => { calls.push(args); archived.add(args[0]); },
      unarchive: async id => archived.delete(id),
    },
  });
  assert.equal((await create()('preview')).eligible, 1);
  assert.deepEqual(calls, []);
  const result = await create()('archive');
  assert.equal(result.changed, 1);
  assert.deepEqual(calls, [['session-idle']]);
  assert.equal((await create()('restore')).changed, 1);
  assert.deepEqual([...archived], ['session-manual']);
});

test('shareable startup report never includes raw error or request data', () => {
  const summary = studioFailureSummary({ code: 'IFRAME_SILENT_TIMEOUT', httpStatus: 503, message: 'private token', url: 'private path' });
  assert.match(summary, /shell-boot/);
  assert.match(summary, /HTTP: 503/);
  assert.doesNotMatch(summary, /private/);
  assert.doesNotMatch(studioFailureSummary({ code: 'private token' }), /private/);
});
