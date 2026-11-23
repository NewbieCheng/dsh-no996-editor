// The microphone grant has two layers: what this plugin delegates to the frame
// (ours to prove) and the OS/desktop-app getUserMedia grant (the user's to give).
// These tests keep the single source of truth honest so diagnose and the iframe
// cannot drift, and so nobody "fixes" a micDenied by silently removing the grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STUDIO_FRAME_ALLOW, micDelegation } from '../src/studio/mic-delegation.mjs';

test('the delegate report states what we own and what we cannot grant', () => {
  const report = micDelegation();
  assert.equal(report.frameAllowsMicrophone, true, 'the Studio frame must be granted microphone');
  assert.equal(report.systemGrantControlledByPlugin, false, 'OS/app mic consent is out of our control');
});

test('the panel frame uses the shared allow string, not a copy that can drift', () => {
  const panel = readFileSync(new URL('../src/studio/studio-panel.mjs', import.meta.url), 'utf8');
  assert.match(panel, /allow:\s*STUDIO_FRAME_ALLOW/);
  assert.doesNotMatch(panel, /allow:\s*['"][^'"]*microphone/, 'no inlined second copy of the grant');
  assert.match(STUDIO_FRAME_ALLOW, /(^|;)\s*microphone\s*(;|$)/);
  assert.match(STUDIO_FRAME_ALLOW, /fullscreen/, 'the preview fullscreen delegation must survive');
});
