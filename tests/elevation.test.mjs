// A file drag into an elevated window is refused by Windows before any page code
// runs; the log must say so, or the failure looks like a missing handler.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElevationProbe } from '../src/elevation.mjs';

test('a failing `net session` means the window is not elevated', () => {
  const probe = createElevationProbe({ exec: () => { throw new Error('Access is denied.'); }, platform: 'win32' });
  assert.equal(probe(), false);
});

test('a succeeding `net session` means the window is elevated', () => {
  const probe = createElevationProbe({ exec: () => Buffer.from(''), platform: 'win32' });
  assert.equal(probe(), true);
});

test('the answer is asked once and remembered', () => {
  let calls = 0;
  const probe = createElevationProbe({ exec: () => { calls += 1; }, platform: 'win32' });
  probe(); probe(); probe();
  assert.equal(calls, 1);
});
