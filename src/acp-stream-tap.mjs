// The live token stream, from the one process that can see it.
//
// `dsh --profile acp` reports an assistant message only after it is committed
// (dsh-acp/src/updates.ts runs on the durable `assistant/message` event), and DSH has
// no partial/delta event to subscribe to over ACP: the panel therefore used to receive
// a whole answer at once. The tokens do exist in that child, though — `dsh-agent-loop`
// emits `agent/assistant-stream` frames for every provider chunk — so this plugin rides
// in the child (see the `--patch` overlay in src/studio-controller.mjs) and forwards the
// deltas to the Host that spawned it.
//
// The frame contract (one line of JSON per frame, loopback TCP, see
// docs/decisions/ADR-0010-live-streaming.md):
//
//   { t: 'hello', v: 1, pid }                              once, right after admission
//   { t: 'start', attempt, turn, step, sessionId }         one attempt (one model call)
//   { t: 'delta', attempt, index, kind, text, sessionId }  kind is 'text' | 'thought'
//   { t: 'sync',  attempt, kind, text, sessionId }         whole attempt so far, gap repair
//   { t: 'seal',  attempt, kind, text, sessionId }         final snapshot of that kind
//
// `attempt` is DSH's own attempt id, so the page can claim exactly one row per attempt
// instead of guessing from its own paragraph counter; `index` is DSH's dense per-attempt
// position, so a missing frame is detectable. `sync` bounds the repair window: a lost
// delta is replaced by a full snapshot within ~250 ms instead of at the end of the turn.
//
// Loaded by path (`file:///…/src/acp-stream-tap.mjs`), so it must stay importable on its
// own: node builtins only, no Host modules, no config schema. Without the two environment
// variables below it does nothing — the panel then behaves exactly as before.
import { connect } from 'node:net'

/** Stable Cordis plugin name. */
export const name = 'no996-openfilm-stream-tap'

/** Frames are coalesced: a provider delta is a few characters, a socket write is not free. */
const FLUSH_MS = 30
/** A full snapshot this often (or after this many deltas) repairs a lost frame quickly. */
const SYNC_MS = 250
const SYNC_DELTAS = 32
/** Past this size a periodic snapshot costs more than the gap it repairs; the commit wins. */
const MAX_SYNC_TEXT = 32 * 1024
/** Frames that could not be written yet, bounded so a dead Host cannot grow this child. */
const MAX_QUEUED_FRAMES = 4096
const MAX_DIALS = 40

/**
 * One Cordis plugin: watch the live assistant frames of this process and write their text
 * to the Host's loopback socket as newline-delimited JSON.
 * @param ctx - the child's plugin context (this profile's tree).
 */
export function apply(ctx) {
  const port = Number.parseInt(process.env['NO996_OPENFILM_STREAM_PORT'] ?? '', 10)
  const token = process.env['NO996_OPENFILM_STREAM_TOKEN'] ?? ''
  if (!Number.isInteger(port) || port <= 0 || token === '') return

  let socket = null
  let answer = [] // what could not be written yet
  let pending = [] // coalesced frames waiting for the next flush
  let timer = null
  let dials = 0
  /* Disposed by the plugin fiber: stop dialing and stop flushing. */
  let stopped = false

  const write = (line) => {
    if (socket === null) {
      if (answer.length < MAX_QUEUED_FRAMES) answer.push(line)
      return
    }
    try { socket.write(line) } catch { /* the panel went away; keep the turn working */ }
  }
  const flush = () => {
    timer = null
    if (pending.length === 0) return
    const frames = pending
    pending = []
    write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''))
  }
  const send = (frame) => {
    pending.push(frame)
    if (timer === null) timer = setTimeout(flush, FLUSH_MS)
  }

  const open = () => {
    const candidate = connect({ port, host: '127.0.0.1' })
    candidate.setNoDelay?.(true)
    candidate.once('connect', () => {
      socket = candidate
      socket.setEncoding('utf8')
      socket.on('error', () => { /* never a turn failure */ })
      socket.once('close', () => {
        socket = null
        // The Host may have restarted under us (it owns this child): dial once more, bounded,
        // so a long turn keeps streaming instead of going quiet after the first reconnect.
        if (stopped) return
        dials += 1
        if (dials < MAX_DIALS) setTimeout(open, 500)
      })
      socket.write(`${JSON.stringify({ token })}\n`)
      // Positive evidence that this child runs the tap, so "no streaming" is diagnosable
      // from the Host log instead of inferred from silence.
      socket.write(`${JSON.stringify({ t: 'hello', v: 1, pid: process.pid })}\n`)
      const queued = answer
      answer = []
      for (const line of queued) { try { socket.write(line) } catch { /* gone again */ } }
    })
    candidate.once('error', () => {
      candidate.destroy()
      // The Host listens before it spawns, so this is only a slow loopback socket:
      // retry for a few seconds, then give up quietly.
      dials += 1
      if (socket === null && dials < 20) setTimeout(open, 250)
    })
  }
  open()

  /* The reasoning of this turn and the text of the current attempt. The text is per attempt
     because each attempt is one paragraph in the panel; the reasoning accumulates over the
     turn, because the panel keeps one thought row per turn. */
  let turn = -1
  let attempt = -1
  let sessionId = ''
  let thought = ''
  let text = ''
  let thoughtAt = 0
  let textAt = 0
  let thoughtSince = 0
  let textSince = 0

  /**
   * A whole-value snapshot of one kind, at most every SYNC_MS (or after SYNC_DELTAS new
   * deltas), so a lost frame is repaired quickly without turning the stream into O(n²) bytes.
   * The counters are per kind: a thought delta must not reset the text cadence.
   *
   * It goes through the same queue as the deltas. Writing it immediately is what made the panel
   * show every answer twice: a snapshot overtook the deltas it summarized, so the page appended
   * those deltas on top of the snapshot (ADR-0010 §3.2 "order is part of the contract").
   */
  const sync = (kind, force) => {
    const body = kind === 'thought' ? thought : text
    if (body === '' || body.length > MAX_SYNC_TEXT) return
    const at = kind === 'thought' ? thoughtAt : textAt
    const since = kind === 'thought' ? thoughtSince : textSince
    if (!force && since < SYNC_DELTAS && Date.now() - at < SYNC_MS) return
    if (kind === 'thought') { thoughtAt = Date.now(); thoughtSince = 0 }
    else { textAt = Date.now(); textSince = 0 }
    send({ t: 'sync', attempt, turn, kind, sessionId, text: body })
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame === undefined) return
    // A subagent runs in this same process and streams too; its words belong to its own
    // conversation, so every frame says which Session it came from and the Host keeps only
    // the one it drives over ACP (ACP session ids are DSH session ids, see dsh-acp/session.ts).
    try { sessionId = agent?.session?.id ?? sessionId } catch { /* agent already disposed */ }
    if (frame.type === 'start') {
      // A new turn starts a new thought: the previous turn's reasoning was already sealed at
      // its last attempt end, and sealing it again here would hand it to the *new* turn's row
      // (the page keys the thought by its own turn, not by the frame's). That leak is what
      // put "the user asked …" reasoning at the top of an unrelated new message.
      if (frame.turn !== turn) {
        turn = frame.turn
        thought = ''
      }
      attempt = frame.attemptId ?? frame.attempt ?? attempt
      text = ''
      textAt = 0
      textSince = 0
      send({ t: 'start', attempt, turn: frame.turn, step: frame.step, sessionId })
      return
    }
    if (frame.type === 'end') {
      // The settled values are authoritative: they ride along so a lost delta cannot leave a
      // gap in the row while the committed message is still on its way. Both are queued after
      // the deltas of this attempt, never before them.
      if (text !== '') send({ t: 'seal', attempt, turn, kind: 'text', sessionId, text })
      if (thought !== '' && thought.length <= MAX_SYNC_TEXT) send({ t: 'seal', attempt, turn, kind: 'thought', sessionId, text: thought })
      flush()
      text = ''
      textSince = 0
      return
    }
    const chunk = frame.chunk
    if (chunk === undefined) return
    if (chunk.type === 'reasoning-delta') {
      if (chunk.text === '') return
      thought += chunk.text
      thoughtSince += 1
      send({ t: 'delta', attempt, index: frame.index, kind: 'thought', turn, sessionId, text: chunk.text })
      sync('thought', false)
      return
    }
    if (chunk.type === 'text-delta') {
      if (chunk.text === '') return
      text += chunk.text
      textSince += 1
      send({ t: 'delta', attempt, index: frame.index, kind: 'text', turn, sessionId, text: chunk.text })
      sync('text', false)
    }
  })

  ctx.effect(() => () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    try { socket?.end() } catch { /* already gone */ }
  }, 'no996-openfilm-stream-tap: socket')
}
