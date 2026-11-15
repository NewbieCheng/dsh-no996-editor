// A stand-in for `dsh --profile acp`: the same newline-delimited JSON-RPC the
// real agent speaks, without a model. Used by tests/acp-client.test.mjs so the
// transport can be exercised without spending a turn.
//
// It can also act as the tap inside the child (FAKE_ACP_STREAM=1): the real one
// dials the Host's loopback port and forwards provider deltas, so the transport and
// the service are tested against the same frame contract the real child speaks.
import { connect } from 'node:net';

const mode = process.env.FAKE_ACP_MODE || 'normal';
const imageEnabled = process.env.FAKE_ACP_IMAGE === '1';
const streamEnabled = process.env.FAKE_ACP_STREAM === '1';

/** `--patch <file>` values, in order. */
const patchFiles = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--patch' && process.argv[index + 1] !== undefined) patchFiles.push(process.argv[index + 1]);
}

/**
 * Whether this spawn should be refused like a model overlay the profile cannot serve.
 * FAKE_ACP_REFUSE_PATCH_FILE narrows the refusal to one file, which is what lets a
 * test prove the tap overlay survives the retry (the model one is refused, the tap is not).
 */
function refusesPatch() {
  if (process.env.FAKE_ACP_REFUSE_PATCH !== '1') return false;
  const only = process.env.FAKE_ACP_REFUSE_PATCH_FILE;
  return only ? patchFiles.includes(only) : patchFiles.length > 0;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });

let permissionWait = null;
let streamSocket = null;
let modelValue = process.env.FAKE_ACP_START_MODEL || '["p","m1"]';
let effortValue = 'high';
let sendResume = false;
/** How many Sessions this process has created (each is a distinct id). */
let created = 0;
let pendingPrompt = null;
let mcpNames = [];
const queued = [];
const configState = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelValue, options: [
    { group: 'p', name: 'P Group', options: [{ value: '["p","m1"]', name: 'm1' }, { value: '["p","m2"]', name: 'm2' }] },
    { group: 'q', name: 'Q Group', options: [{ value: '["q","q1"]', name: 'q1' }] },
  ] },
  { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: effortValue, options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }] },
];

/**
 * Play the tap: dial the Host's loopback port and speak the frame contract
 * (hello / start / delta / sync / seal) before the committed update arrives.
 * @param sessionId - the Session this attempt belongs to.
 */
function openStream(sessionId) {
  if (!streamEnabled || streamSocket !== null) return;
  const port = Number.parseInt(process.env.NO996_OPENFILM_STREAM_PORT ?? '', 10);
  const token = process.env.NO996_OPENFILM_STREAM_TOKEN ?? '';
  if (!Number.isInteger(port) || port <= 0 || token === '') return;
  const socket = connect({ port, host: '127.0.0.1' });
  streamSocket = socket;
  socket.on('error', () => { /* the Host went away; the turn still works */ });
  socket.once('connect', () => {
    const line = frame => socket.write(`${JSON.stringify(frame)}\n`);
    line({ token });
    line({ t: 'hello', v: 1, pid: process.pid });
    // The real attemptId is a branded string (`<session>:<n>`), so the stand-in uses one too.
    const attempt = `${sessionId}:1`;
    line({ t: 'start', attempt, turn: 1, step: 1, sessionId });
    line({ t: 'delta', attempt, index: 0, kind: 'thought', sessionId, text: 'think' });
    line({ t: 'delta', attempt, index: 1, kind: 'text', sessionId, text: 'a' });
    line({ t: 'delta', attempt, index: 2, kind: 'text', sessionId, text: 'b' });
    line({ t: 'sync', attempt, kind: 'text', sessionId, text: 'ab' });
    line({ t: 'seal', attempt, kind: 'text', sessionId, text: 'abc' });
  });
}

function handle(message) {
  if (message.method === undefined && permissionWait !== null && message.id === permissionWait.id) {
    permissionWait.resolve(message.result);
    permissionWait = null;
    return;
  }
  switch (message.method) {
    case 'initialize':
      return result(message.id, {
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp', version: '1' },
        agentCapabilities: { promptCapabilities: { image: imageEnabled, audio: false, embeddedContext: false }, sessionCapabilities: { resume: {}, close: {}, list: {} } },
        authMethods: [],
      });
    case 'session/new':
    case 'session/resume':
      // A model overlay naming a provider this agent has no adapter for: the real
      // DSH acp profile answers -32603, so the service must retry without it.
      if (refusesPatch()) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error', data: { details: 'no adapter registered for provider "opencode-go"' } } });
        return;
      }
      mcpNames = (message.params?.mcpServers ?? []).map(server => server.name);
      sendResume = false;
      // Each `session/new` is a different Session: the panel keeps several
      // conversations per project, and a fake that answered one id for all of them
      // would hide a Host that mixes them up.
      created += 1;
      return result(message.id, { sessionId: message.params?.sessionId || `session-fake-${created}`, configOptions: configState() });
    case 'session/list':
      if (process.env.FAKE_ACP_EMPTY_LIST === '1') return result(message.id, { sessions: [] });
      return result(message.id, { sessions: [{ sessionId: 'session-fake-1', cwd: 'C:\\fake' }, { sessionId: 'session-fake-2', cwd: 'C:\\fake' }] });
    case 'session/set_config_option': {
      const { configId, value } = message.params;
      if (configId === 'model') modelValue = value;
      if (configId === 'reasoning_effort') effortValue = value;
      return result(message.id, { configOptions: configState() });
    }
    case 'session/cancel':
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'usage_update', used: 0 } } });
      if (pendingPrompt !== null) { result(pendingPrompt, { stopReason: 'cancelled' }); pendingPrompt = null; queued.forEach(id => result(id, { stopReason: 'cancelled' })); queued.length = 0; }
      return;
    case 'session/prompt': {
      if (mode === 'exit-on-prompt') { process.exit(7); }
      if (mode === 'hang-on-prompt') { pendingPrompt = message.id; return; }
      const sessionId = message.params.sessionId;
      openStream(sessionId);
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } } } });
      const kinds = (message.params.prompt ?? []).map(block => block.type).join(',');
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'blocks:' + kinds + (process.env.FAKE_ACP_MCP === '1' ? ' mcp:' + mcpNames.join(',') : '') } } } });
      const permission = new Promise(resolve => { permissionWait = { id: 9001, resolve }; });
      send({ jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: { sessionId, toolCall: { title: 'write' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
      pendingPrompt = message.id;
      permission.then(answer => {
        if (pendingPrompt === message.id) pendingPrompt = null;
        result(message.id, { stopReason: answer?.outcome?.outcome === 'selected' ? 'end_turn' : 'cancelled' });
      });
      return;
    }
    default:
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
  }
}
