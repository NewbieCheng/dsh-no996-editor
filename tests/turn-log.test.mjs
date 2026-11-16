// Stream frames must not crowd tool_call rows out of the per-turn log.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnLog } from '../src/studio/studio-controller/turns.mjs';

test('stream frames are counted without taking event slots from tool updates', () => {
  const { recordTurnEvent, turnLogOf } = createTurnLog({ maxEvents: 10 });
  const projectId = 'projTurn01';
  const key = 'turn-a';

  recordTurnEvent(projectId, {
    key,
    kind: 'update',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', toolName: 'openfilm_transcribe', title: 'Transcribe' },
  });
  for (let i = 0; i < 50; i += 1) {
    recordTurnEvent(projectId, {
      key,
      kind: 'stream',
      stream: { kind: 'thought', text: 'x', seal: i % 10 === 0, sync: i % 10 === 5 },
    });
  }
  recordTurnEvent(projectId, {
    key,
    kind: 'update',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', toolName: 'openfilm_transcribe' },
  });
  recordTurnEvent(projectId, { key, kind: 'done', ok: false, error: 'ACP_REQUEST_FAILED' });

  const log = turnLogOf(projectId, key);
  assert.ok(log);
  assert.equal(log.counts.stream, 50);
  assert.equal(log.counts.tool_call, 1);
  assert.equal(log.counts.tool_call_update, 1);
  assert.equal(log.counts.done, 1);
  assert.equal(log.at.stream, 50);
  assert.equal(log.at.calls, 1);
  assert.equal(log.events.length, 3, 'only durable updates and done are stored');
  assert.equal(log.events[0].toolName, 'openfilm_transcribe');
  assert.equal(log.events[2].ok, false);
});

test('a flood of updates still keeps the newest rows within the cap', () => {
  const { recordTurnEvent, turnLogOf } = createTurnLog({ maxEvents: 5 });
  const projectId = 'projTurn02';
  const key = 'turn-b';
  for (let i = 0; i < 12; i += 1) {
    recordTurnEvent(projectId, {
      key,
      kind: 'update',
      update: { sessionUpdate: 'agent_thought_chunk' },
    });
  }
  const log = turnLogOf(projectId, key);
  assert.equal(log.events.length, 5);
  assert.equal(log.counts.agent_thought_chunk, 12);
});
