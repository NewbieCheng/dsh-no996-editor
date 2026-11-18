import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticLog, redactDiagText } from '../src/host/diagnostic-log.mjs';

test('diagnostic log writes structured daily JSONL entries and preserves pinpoint location', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'no996-diag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fixedNow = new Date('2026-11-18T08:00:00.000Z');
  const log = createDiagnosticLog({ dir, now: () => fixedNow });
  log.error({
    layer: 'native-agent',
    traceId: 'rpc-abc123',
    code: 'OFFICIAL_AGENT_INPUT',
    channel: 'agent:select-thinking',
    httpStatus: 503,
    projectId: 'proj_123456',
    location: 'src/native/dsh-native-agent-service.mjs:selectThinking',
    summary: '当前模型不支持所选思考档位',
    detail: {
      model: 'deepseek/deepseek-chat',
      requestedValue: 'high',
      allowedValues: ['off', 'low', 'medium'],
      apiKey: 'secret-value-123',
    },
  });
  await log.flush();

  const files = readdirSync(dir);
  assert.deepEqual(files, ['diagnostics-2026-11-18.jsonl']);

  const listed = await log.list({ level: 'error', traceId: 'rpc-abc123' });
  assert.equal(listed.total, 1);
  const entry = listed.items[0];
  assert.equal(entry.location, 'src/native/dsh-native-agent-service.mjs:selectThinking');
  assert.equal(entry.detail.requestedValue, 'high');
  assert.deepEqual(entry.detail.allowedValues, ['off', 'low', 'medium']);
  assert.equal(entry.detail.apiKey, '[redacted]');
});

test('redactDiagText strips credentials and home prefix while keeping relative repo frames', () => {
  const home = homedir();
  const fakeSecret = ['sk', 'liveSecretTokenValue12345'].join('-');
  const sample = `Error at ${home}/secret/file.txt and F:\\repo\\src\\native\\dsh-native-agent-service.mjs:1054 with Bearer tok12345678 and ${fakeSecret}`;
  const out = redactDiagText(sample, { home });
  assert.equal(out.includes(home), false);
  assert.equal(out.includes('tok12345678'), false);
  assert.equal(out.includes('liveSecretTokenValue12345'), false);
  assert.match(out, /src\/native\/dsh-native-agent-service\.mjs:1054/);
});

test('prune automatically deletes logs older than retentionDays and enforces maxTotalBytes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'no996-diag-prune-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });

  // 20 days old (expired under 14d), 5 days old (kept), 2 days old (kept)
  writeFileSync(join(dir, 'diagnostics-2026-10-29.jsonl'), '{"id":"old","ts":"2026-10-29T00:00:00.000Z","level":"error","layer":"ui","summary":"old"}\n');
  writeFileSync(join(dir, 'diagnostics-2026-11-13.jsonl'), `${'x'.repeat(200)}\n`);
  writeFileSync(join(dir, 'diagnostics-2026-11-16.jsonl'), '{"id":"recent","ts":"2026-11-16T00:00:00.000Z","level":"info","layer":"host","summary":"recent"}\n');

  const now = new Date('2026-11-18T12:00:00.000Z');
  const log = createDiagnosticLog({ dir, retentionDays: 14, maxTotalBytes: 180, now: () => now });
  await log.flush();

  const remaining = readdirSync(dir).sort();
  // 2026-10-29 removed by age (>14d); 2026-11-13 removed to stay under maxTotalBytes=180
  assert.deepEqual(remaining, ['diagnostics-2026-11-16.jsonl']);

  const cleared = await log.clear({ mode: 'all' });
  assert.equal(cleared.removedFiles, 1);
  assert.deepEqual(readdirSync(dir), []);
});
