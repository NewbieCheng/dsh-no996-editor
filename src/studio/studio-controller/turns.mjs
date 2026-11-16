// Per-project turn logs for the panel's "what happened in this turn" viewer.
//
// Bounded on purpose: the panel shows recent turns, not history. Stream frames
// are counted, not stored — a single long-thinking turn can emit thousands of
// deltas, and letting them share the event cap used to push `tool_call` rows
// out of the log (2026-11-16: deltas≈8k vs TURN_LOG_EVENTS=2000).
export function createTurnLog({ maxTurns = 4, maxEvents = 2000, maxProjects = 8 } = {}) {
  const turnLogs = new Map();

  const bucketOf = (projectId, turnId) => {
    let turns = turnLogs.get(projectId);
    if (!turns) turnLogs.set(projectId, turns = new Map());
    let bucket = turns.get(turnId);
    if (!bucket) {
      turns.set(turnId, bucket = { events: [], counts: Object.create(null) });
      while (turns.size > maxTurns) turns.delete(turns.keys().next().value);
    }
    while (turnLogs.size > maxProjects) turnLogs.delete(turnLogs.keys().next().value);
    return bucket;
  };

  const bump = (counts, name) => {
    if (typeof name !== 'string' || !name) return;
    counts[name] = (counts[name] || 0) + 1;
  };

  const recordTurnEvent = (projectId, event) => {
    if (typeof projectId !== 'string' || !projectId || !event || typeof event !== 'object') return;
    const turnId = typeof event.key === 'string' ? event.key : '';
    if (!turnId) return;
    const bucket = bucketOf(projectId, turnId);

    // Live frames: count only. Storing them would crowd out tool_call / thought
    // updates that the diagnose path needs to answer "did tools run this turn?".
    if (event.kind === 'stream') {
      bump(bucket.counts, 'stream');
      const frame = event.stream && typeof event.stream === 'object' ? event.stream : null;
      if (frame?.seal === true) bump(bucket.counts, 'stream_seal');
      else if (frame?.sync === true) bump(bucket.counts, 'stream_sync');
      else bump(bucket.counts, 'stream_delta');
      if (frame?.kind === 'thought' || frame?.kind === 'text') bump(bucket.counts, `stream_${frame.kind}`);
      return;
    }

    const update = event.update && typeof event.update === 'object' ? event.update : {};
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate
      : event.kind === 'done' ? 'done' : (typeof event.kind === 'string' ? event.kind : 'update');
    bump(bucket.counts, kind);

    // Slim rows: enough to see order and tool names, not full payloads.
    const row = { t: Date.now(), kind };
    if (typeof update.toolCallId === 'string') row.toolCallId = update.toolCallId.slice(0, 80);
    if (typeof update.toolName === 'string') row.toolName = update.toolName.slice(0, 80);
    if (typeof update.title === 'string') row.title = update.title.slice(0, 120);
    if (event.kind === 'done') {
      row.ok = event.ok === true;
      if (typeof event.error === 'string') row.error = event.error.slice(0, 120);
      if (typeof event.stopReason === 'string') row.stopReason = event.stopReason.slice(0, 40);
    }
    bucket.events.push(row);
    if (bucket.events.length > maxEvents) bucket.events.splice(0, bucket.events.length - maxEvents);
  };

  const turnLogOf = (projectId, turnId) => {
    const bucket = turnLogs.get(projectId)?.get(turnId);
    if (!bucket) return null;
    const counts = { ...bucket.counts };
    const toolCalls = Number(counts.tool_call) || 0;
    // `whole` says these events are the log's, so the viewer replaces rather than appends.
    return {
      file: 'dsh-turn',
      cut: false,
      whole: true,
      events: [...bucket.events],
      counts,
      calls: [],
      callsWhole: true,
      callsCut: false,
      at: { events: bucket.events.length, calls: toolCalls, callsFile: 0, stream: Number(counts.stream) || 0 },
    };
  };

  return { recordTurnEvent, turnLogOf };
}
