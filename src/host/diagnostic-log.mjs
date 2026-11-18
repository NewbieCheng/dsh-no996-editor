import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_DAY_BYTES = 10 * 1024 * 1024;

const FILE_RE = /^diagnostics-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SECRET_KEY = /^(?:.*(?:key|secret|token|ticket|cookie|password|credential|authorization|prompt|text|messages|content).*)$/i;
const SESSION_KEY = /^(?:.*session.*id.*)$/i;
const VALID_LEVELS = new Set(['error', 'warn', 'info']);
const VALID_LAYERS = new Set(['ui', 'rpc', 'sse', 'host', 'native-agent', 'studio-upstream', 'auth', 'media']);

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function defaultLogDir() {
  return join(dshHome(), 'no996-openfilm', 'logs');
}

export function clampRetentionDays(value, fallback = DEFAULT_RETENTION_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.round(n)));
}

export function shortDigest(value) {
  if (typeof value !== 'string' || !value) return '';
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

/**
 * Redact credentials, emails, and user home prefix while keeping relative repo
 * paths (`src/...`, `packages/openfilm/...`) intact for pinpoint debugging.
 */
export function redactDiagText(input, { home = homedir(), maxLength = 2000 } = {}) {
  let out = String(input ?? '');
  // Normalize plugin / upstream absolute paths to relative frames first so stack
  // traces remain pinpointed without exposing the developer's drive/username.
  out = out
    .replace(/[A-Za-z]:[\\/][^\s:)"']*?[\\/]((?:src|assets|scripts|tests|skills|packages|apps)[\\/][^\s:)"']+)/g, (_, rel) => rel.replace(/\\/g, '/'))
    .replace(/\/[^\s:)"']*?\/((?:src|assets|scripts|tests|skills|packages|apps)\/[^\s:)"']+)/g, '$1');
  if (home && home.length > 1) {
    out = out.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');
  }
  out = out
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA)[-_]?[A-Za-z0-9_-]{10,}/g, '[key-redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|x-studio-key|token|secret|password|authorization|ticket|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,}]{4,}/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|ticket)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

export function sanitizeDiagValue(value, depth = 0, options = {}) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactDiagText(value, options);
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) {
    return value.slice(0, 24).map(item => sanitizeDiagValue(item, depth + 1, options)).filter(v => v !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    let count = 0;
    for (const [key, raw] of Object.entries(value)) {
      if (raw === undefined || count >= 32) continue;
      if (SECRET_KEY.test(key)) {
        out[key] = '[redacted]';
        count += 1;
        continue;
      }
      if (SESSION_KEY.test(key) && typeof raw === 'string') {
        out[key] = raw ? `sess:${shortDigest(raw)}` : '';
        count += 1;
        continue;
      }
      const cleaned = sanitizeDiagValue(raw, depth + 1, options);
      if (cleaned !== undefined) {
        out[key] = cleaned;
        count += 1;
      }
    }
    return out;
  }
  return redactDiagText(String(value), options);
}

function dateKeyOf(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function makeId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `diag_${stamp}_${randomBytes(3).toString('hex')}`;
}

export function createDiagnosticLog({
  dir = defaultLogDir(),
  retentionDays = clampRetentionDays(process.env.NO996_OPENFILM_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxDayBytes = DEFAULT_MAX_DAY_BYTES,
  recent = 400,
  now = () => new Date(),
} = {}) {
  let activeRetentionDays = clampRetentionDays(retentionDays, DEFAULT_RETENTION_DAYS);
  const ring = [];
  let queue = Promise.resolve();
  let lastPruneDay = '';
  let closed = false;

  function normalizeEntry(raw) {
    const at = typeof raw?.ts === 'string' && !Number.isNaN(Date.parse(raw.ts)) ? new Date(raw.ts) : now();
    const level = VALID_LEVELS.has(raw?.level) ? raw.level : 'error';
    const layer = VALID_LAYERS.has(raw?.layer) ? raw.layer : 'host';
    const entry = {
      id: typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 64) : makeId(at),
      ts: at.toISOString(),
      level,
      layer,
      traceId: typeof raw?.traceId === 'string' ? raw.traceId.slice(0, 64) : '',
      code: typeof raw?.code === 'string' ? raw.code.slice(0, 64) : '',
      channel: typeof raw?.channel === 'string' ? raw.channel.slice(0, 80) : '',
      httpStatus: Number.isInteger(raw?.httpStatus) ? raw.httpStatus : null,
      durationMs: typeof raw?.durationMs === 'number' && Number.isFinite(raw.durationMs) ? Math.max(0, Math.round(raw.durationMs)) : null,
      projectId: typeof raw?.projectId === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(raw.projectId) ? raw.projectId : '',
      conversation: typeof raw?.conversation === 'string' ? raw.conversation.slice(0, 64) : '',
      sessionDigest: typeof raw?.sessionId === 'string' && raw.sessionId
        ? `sess:${shortDigest(raw.sessionId)}`
        : (typeof raw?.sessionDigest === 'string' ? raw.sessionDigest.slice(0, 24) : ''),
      location: typeof raw?.location === 'string' ? redactDiagText(raw.location, { maxLength: 240 }) : '',
      summary: typeof raw?.summary === 'string' ? redactDiagText(raw.summary, { maxLength: 400 }) : '',
      detail: raw?.detail && typeof raw.detail === 'object' ? sanitizeDiagValue(raw.detail, 0, { maxLength: 2000 }) : null,
    };
    return entry;
  }

  async function listDailyFiles() {
    let names;
    try { names = await readdir(dir); } catch { return []; }
    const rows = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const full = join(dir, name);
      try {
        const info = await stat(full);
        if (info.isFile()) rows.push({ name, date: m[1], path: full, size: info.size });
      } catch { /* disappeared */ }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  }

  async function runPrune({ days = activeRetentionDays, forceNow } = {}) {
    const current = forceNow instanceof Date ? forceNow : now();
    const keepDays = clampRetentionDays(days, activeRetentionDays);
    const cutoffMs = current.getTime() - keepDays * 86_400_000;
    const cutoffDate = dateKeyOf(new Date(cutoffMs));
    const files = await listDailyFiles();
    const kept = [];
    let removedFiles = 0;
    let freedBytes = 0;

    for (const file of files) {
      if (file.date < cutoffDate) {
        await unlink(file.path).catch(() => {});
        removedFiles += 1;
        freedBytes += file.size;
      } else {
        kept.push(file);
      }
    }

    let totalBytes = kept.reduce((sum, f) => sum + f.size, 0);
    const today = dateKeyOf(current);
    while (totalBytes > maxTotalBytes && kept.length > 0) {
      // Never drop today's active log unless it is the only file left and still
      // exceeds the global cap by itself.
      if (kept.length === 1 && kept[0].date === today) break;
      const oldest = kept.shift();
      if (!oldest) break;
      await unlink(oldest.path).catch(() => {});
      totalBytes -= oldest.size;
      removedFiles += 1;
      freedBytes += oldest.size;
    }

    return { removedFiles, freedBytes, remainingFiles: kept.length, totalBytes };
  }

  function enqueue(fn) {
    queue = queue.then(fn).catch(() => {});
    return queue;
  }

  // Non-blocking startup prune.
  void enqueue(() => runPrune());

  function record(raw) {
    if (closed) return null;
    const entry = normalizeEntry(raw);
    ring.push(entry);
    if (ring.length > recent) ring.splice(0, ring.length - recent);

    const day = entry.ts.slice(0, 10);
    const file = join(dir, `diagnostics-${day}.jsonl`);
    const line = `${JSON.stringify(entry)}\n`;
    void enqueue(async () => {
      await mkdir(dir, { recursive: true });
      const size = await stat(file).then(info => info.size, () => 0);
      if (size + Buffer.byteLength(line) <= maxDayBytes) {
        await appendFile(file, line, 'utf8');
      }
      if (lastPruneDay !== day) {
        lastPruneDay = day;
        await runPrune();
      }
    });
    return entry;
  }

  async function readAllEntries({ days } = {}) {
    await queue;
    const files = await listDailyFiles();
    const current = now();
    const windowDays = clampRetentionDays(days ?? activeRetentionDays, activeRetentionDays);
    const cutoffDate = dateKeyOf(new Date(current.getTime() - windowDays * 86_400_000));
    const byId = new Map();

    for (const file of files) {
      if (file.date < cutoffDate) continue;
      const raw = await readFile(file.path, 'utf8').catch(() => '');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.id === 'string') byId.set(parsed.id, parsed);
        } catch { /* ignore truncated line */ }
      }
    }
    for (const entry of ring) {
      if (entry.ts.slice(0, 10) >= cutoffDate) byId.set(entry.id, entry);
    }
    return [...byId.values()].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  }

  async function computeStats() {
    const files = await listDailyFiles();
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let errorCount = 0;
    let warnCount = 0;
    for (const entry of ring) {
      if (entry.level === 'error') errorCount += 1;
      else if (entry.level === 'warn') warnCount += 1;
    }
    return {
      dir,
      retentionDays: activeRetentionDays,
      maxTotalBytes,
      fileCount: files.length,
      totalBytes,
      oldestDate: files[0]?.date ?? null,
      newestDate: files[files.length - 1]?.date ?? null,
      recentErrors: errorCount,
      recentWarnings: warnCount,
    };
  }

  async function stats() {
    await queue;
    return computeStats();
  }

  async function list({ level = 'all', layer = 'all', search = '', traceId = '', limit = 100, days } = {}) {
    const all = await readAllEntries({ days });
    const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
    const trace = typeof traceId === 'string' ? traceId.trim() : '';
    const filtered = all.filter((entry) => {
      if (level === 'error' && entry.level !== 'error') return false;
      if (level === 'warn+' && entry.level !== 'error' && entry.level !== 'warn') return false;
      if (layer !== 'all' && VALID_LAYERS.has(layer) && entry.layer !== layer) return false;
      if (trace && entry.traceId !== trace) return false;
      if (needle) {
        const hay = `${entry.code} ${entry.channel} ${entry.location} ${entry.summary} ${entry.traceId} ${JSON.stringify(entry.detail ?? '')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    return {
      items: filtered.slice(0, cap),
      total: filtered.length,
      stats: await computeStats(),
    };
  }

  async function clear({ mode = 'expired' } = {}) {
    if (mode === 'all') {
      return enqueue(async () => {
        ring.length = 0;
        const files = await listDailyFiles();
        let removedFiles = 0;
        let freedBytes = 0;
        for (const file of files) {
          await unlink(file.path).catch(() => {});
          removedFiles += 1;
          freedBytes += file.size;
        }
        return { mode: 'all', removedFiles, freedBytes, stats: await computeStats() };
      });
    }
    return enqueue(async () => {
      const pruned = await runPrune();
      return { mode: 'expired', ...pruned, stats: await computeStats() };
    });
  }

  return Object.freeze({
    dir,
    record,
    error: (fields) => record({ ...fields, level: 'error' }),
    warn: (fields) => record({ ...fields, level: 'warn' }),
    info: (fields) => record({ ...fields, level: 'info' }),
    list,
    stats,
    prune: (opts) => enqueue(() => runPrune(opts)),
    clear,
    setRetentionDays(days) {
      activeRetentionDays = clampRetentionDays(days, activeRetentionDays);
      return activeRetentionDays;
    },
    getRetentionDays() {
      return activeRetentionDays;
    },
    tail(count = 25) {
      return ring.slice(Math.max(0, ring.length - count));
    },
    flush: () => queue,
    close() {
      closed = true;
    },
  });
}
