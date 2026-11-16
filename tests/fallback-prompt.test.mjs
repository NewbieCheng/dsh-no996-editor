import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackPayload, createFallbackPrompt } from '../src/host/fallback-prompt.mjs';

test('ffmpeg prompt names the platform artifact and asks for full-access confirmation', () => {
  const text = createFallbackPrompt('tools', {
    platform: 'darwin',
    arch: 'arm64',
    error: 'npmmirror timeout',
  });
  assert.match(text, /完全访问/);
  assert.match(text, /征得我确认后再执行/);
  assert.match(text, /macOS · arm64/);
  assert.match(text, /ffmpeg-darwin-arm64\.gz/);
  assert.match(text, /npmmirror/);
  assert.match(text, /npmmirror timeout/);
  assert.match(text, /Homebrew|brew install ffmpeg/);
});

test('windows prompt lists WinGet-style dirs and win32 artifact', () => {
  const text = createFallbackPrompt('tools', {
    platform: 'win32',
    arch: 'x64',
    env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
  });
  assert.match(text, /Windows · x64/);
  assert.match(text, /ffmpeg-win32-x64\.gz/);
  assert.match(text, /WinGet\\Links/);
});

test('asr prompt lists SenseVoice files and library path', () => {
  const text = createFallbackPrompt('asr', {
    platform: 'win32',
    arch: 'x64',
    asrDir: 'C:\\Users\\x\\.openfilm\\library\\models\\sensevoice-small',
  });
  assert.match(text, /sensevoice-small/);
  assert.match(text, /model\.int8\.onnx/);
  assert.match(text, /tokens\.txt/);
  assert.match(text, /hf-mirror|huggingface/);
  assert.match(text, /sensevoice-small/);
});

test('path-fix prompt carries the user directory as data only', () => {
  const text = createFallbackPrompt('path-fix', {
    platform: 'darwin',
    arch: 'arm64',
    directory: '/opt/homebrew/bin',
  });
  assert.match(text, /\/opt\/homebrew\/bin/);
  assert.match(text, /仅作数据/);
  assert.match(text, /PATH/);
});

test('buildFallbackPayload returns a ready-to-copy prompt for both', () => {
  const payload = buildFallbackPayload('both', {
    platform: 'darwin',
    arch: 'arm64',
    error: 'all sources failed',
    home: '/tmp/nof-home',
    env: {},
  });
  assert.equal(payload.kind, 'both');
  assert.match(payload.title, /本机依赖/);
  assert.match(payload.prompt, /FFmpeg/);
  assert.match(payload.prompt, /SenseVoice/);
  assert.equal(payload.diag.modelId, 'sensevoice-small');
  assert.match(payload.diag.ffmpegArtifact, /darwin-arm64/);
});

test('unknown kind falls back to tools', () => {
  const payload = buildFallbackPayload('nope', { platform: 'linux', arch: 'x64' });
  assert.equal(payload.kind, 'tools');
  assert.match(payload.prompt, /FFmpeg/);
});
