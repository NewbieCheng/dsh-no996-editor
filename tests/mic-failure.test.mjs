// Dictation failures are logged by class, never by content: a code the page invented,
// a message, or the transcript itself must not reach the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIC_FAILURES, micFailureCode } from '../src/native/mic-failure.mjs';

test('every failure class the page can report is accepted', () => {
  assert.deepEqual([...MIC_FAILURES], ['micPolicy', 'micDenied', 'micMissing', 'micUnavailable', 'micUnsupported']);
  for (const code of MIC_FAILURES) assert.equal(micFailureCode({ detail: code }), code);
});

test('an unknown code, a message or a transcript is dropped rather than logged', () => {
  assert.equal(micFailureCode({ detail: 'micExploded' }), null, 'only known classes are logged');
  assert.equal(micFailureCode({ detail: 'NotAllowedError: Permission denied' }), null);
  assert.equal(micFailureCode({ detail: '今天录的这句话' }), null);
  assert.equal(micFailureCode({ detail: ['micDenied'] }), null);
  assert.equal(micFailureCode({}), null);
  assert.equal(micFailureCode(null), null);
  assert.equal(micFailureCode(undefined), null);
});
