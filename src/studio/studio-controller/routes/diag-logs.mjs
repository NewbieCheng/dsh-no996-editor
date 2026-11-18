// Unified diagnostic log RPC & Host HTTP routes.
//
// Exposes the persistent, pinpointed diagnostic log store (`diagnostic-log.mjs`)
// to both the OpenFilm in-app Diagnostic Log Center (`/__dsh/official-rpc`
// channels `diag:*`) and the DSH outer panel (`/api/no996-openfilm/logs`,
// `/api/no996-openfilm/client-diag`). Secrets and user prompts are never stored
// or returned.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonBody } from '../http-body.mjs';

const VALID_MODES = new Set(['expired', 'all']);

async function readStudioProblems(limit = 30) {
  const home = process.env.OPENFILM_HOME || join(homedir(), '.openfilm');
  const file = join(home, 'logs', 'problems.jsonl');
  try {
    const raw = await readFile(file, 'utf8');
    const items = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.t === 'string' && typeof parsed.what === 'string') items.push(parsed);
      } catch { /* ignore */ }
    }
    return items.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export function formatDiagnosticMarkdown({
  exportedAt,
  environment,
  studio,
  preset,
  turns,
  stats,
  entries,
  studioProblems,
}) {
  const lines = [
    '# No996 Studio / OpenFilm 诊断报告',
    `- 导出时间: ${exportedAt}`,
    `- 插件版本: ${environment.pluginVersion} | OpenFilm: ${environment.openfilmVersion} | Node: ${environment.node} | 平台: ${environment.platform}/${environment.arch}`,
    `- Studio 状态: ${studio?.running ? `运行中 (port ${studio.port ?? '?'})` : '未运行'} | 预设 (${preset?.id ?? 'openfilm-video-editing'}): ${preset?.ok ? '正常' : `异常 (${preset?.detail ?? 'unknown'})`}`,
    `- 日志目录: ${stats?.dir ?? 'unknown'} (保留 ${stats?.retentionDays ?? 14} 天 · 已用 ${((stats?.totalBytes ?? 0) / 1024).toFixed(1)} KiB)`,
    '',
  ];
  if (turns) {
    lines.push('## 当前会话状态');
    lines.push(`- model: ${turns.model ?? 'none'} | effort: ${turns.effort ?? 'none'} | source: ${turns.modelSource ?? 'none'} | stream: ${turns.stream?.connected ? 'connected' : 'disconnected'}`);
    lines.push('');
  }
  lines.push(`## 近期诊断日志 (${entries.length} 条)`);
  if (entries.length === 0) {
    lines.push('- （无异常或诊断记录）');
  } else {
    for (const entry of entries.slice(0, 40)) {
      const head = `- [${entry.ts}] [${String(entry.level).toUpperCase()}] [${entry.layer}]`;
      const meta = [entry.code, entry.channel, entry.httpStatus ? `HTTP ${entry.httpStatus}` : '', entry.traceId ? `trace=${entry.traceId}` : ''].filter(Boolean).join(' · ');
      lines.push(`${head} ${meta}`);
      if (entry.summary) lines.push(`  摘要: ${entry.summary}`);
      if (entry.location) lines.push(`  定位: ${entry.location}`);
      if (entry.detail) lines.push(`  详情: ${JSON.stringify(entry.detail)}`);
    }
  }
  if (Array.isArray(studioProblems) && studioProblems.length > 0) {
    lines.push('');
    lines.push(`## OpenFilm Studio 内置问题记录 (${studioProblems.length} 条)`);
    for (const p of studioProblems.slice(0, 15)) {
      lines.push(`- [${p.t}] ${p.area || 'studio'}${p.step ? ` · ${p.step}` : ''}: ${p.what}`);
    }
  }
  return lines.join('\n');
}

export function createDiagLogsController({
  ctx,
  register,
  track,
  diagLog,
  pluginLog,
  preferences,
  runtime,
  agentService,
  pluginVersion,
  openfilmVersion,
  officialShell,
}) {
  async function readPreset() {
    try {
      const registry = ctx.get?.('agentPresets');
      const roster = typeof registry?.list === 'function' ? await registry.list() : [];
      const found = roster.find(item => item?.id === 'openfilm-video-editing');
      return found
        ? { id: 'openfilm-video-editing', ok: !found.error && !found.failure, detail: String(found.error ?? found.failure ?? 'ok').slice(0, 200) }
        : { id: 'openfilm-video-editing', ok: false, detail: 'not registered' };
    } catch (error) {
      return { id: 'openfilm-video-editing', ok: false, detail: String(error?.message || error).slice(0, 200) };
    }
  }

  async function buildExport(payload = {}) {
    const projectId = typeof payload?.projectId === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(payload.projectId) ? payload.projectId : '';
    const conversation = typeof payload?.conversation === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.conversation) ? payload.conversation : '';
    const limit = Math.max(1, Math.min(300, Number(payload?.limit) || 120));
    const [listed, studio, preset, studioProblems] = await Promise.all([
      diagLog.list({ level: typeof payload?.level === 'string' ? payload.level : 'all', layer: typeof payload?.layer === 'string' ? payload.layer : 'all', limit }),
      runtime?.health ? runtime.health().catch(() => ({ running: false })) : Promise.resolve({ running: false }),
      readPreset(),
      readStudioProblems(30),
    ]);
    const turns = agentService && projectId ? agentService.diagnose(projectId, conversation) : null;
    const exportedAt = new Date().toISOString();
    const environment = {
      pluginVersion: String(pluginVersion || 'unknown'),
      openfilmVersion: String(openfilmVersion || 'unknown'),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      mode: officialShell ? 'official' : 'dsh',
    };
    const hostLogTail = typeof pluginLog?.tail === 'function' ? pluginLog.tail(25) : [];
    const markdown = formatDiagnosticMarkdown({
      exportedAt,
      environment,
      studio,
      preset,
      turns,
      stats: listed.stats,
      entries: listed.items,
      studioProblems,
    });
    return {
      exportedAt,
      environment,
      studio,
      preset,
      turns,
      stats: listed.stats,
      entries: listed.items,
      studioProblems,
      hostLogTail,
      markdown,
    };
  }

  async function handleRpc(channel, payload = {}) {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    if (channel === 'diag:list') {
      return diagLog.list({
        level: typeof body.level === 'string' ? body.level : 'all',
        layer: typeof body.layer === 'string' ? body.layer : 'all',
        search: typeof body.search === 'string' ? body.search : '',
        traceId: typeof body.traceId === 'string' ? body.traceId : '',
        limit: Number(body.limit) || 100,
      });
    }
    if (channel === 'diag:export') {
      return buildExport(body);
    }
    if (channel === 'diag:clear') {
      const mode = VALID_MODES.has(body.mode) ? body.mode : 'expired';
      return diagLog.clear({ mode });
    }
    if (channel === 'diag:prefs') {
      if (body.retentionDays !== undefined && preferences) {
        const updated = await preferences.set({ logRetentionDays: Number(body.retentionDays) });
        diagLog.setRetentionDays(updated.logRetentionDays);
        await diagLog.prune();
      }
      return { retentionDays: diagLog.getRetentionDays(), stats: await diagLog.stats() };
    }
    throw Object.assign(new Error('Unknown diagnostic channel'), { code: 'OFFICIAL_CHAT_UNAVAILABLE' });
  }

  const disposers = [];
  if (typeof register === 'function' && typeof track === 'function') {
    const unregisterLogs = track(register({
      kind: 'exact',
      path: '/api/no996-openfilm/logs',
      async handler(req, res) {
        res.setHeader('cache-control', 'no-store');
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
        const admission = ctx.connection.admit({ headers: req.headers });
        if ('rejection' in admission || admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('{}'); return; }
        const body = await readJsonBody(req, 16 * 1024);
        const action = typeof body?.action === 'string' ? body.action : 'list';
        const channelMap = { list: 'diag:list', export: 'diag:export', clear: 'diag:clear', prefs: 'diag:prefs' };
        const rpcChannel = channelMap[action];
        if (!rpcChannel) { res.writeHead(400).end(JSON.stringify({ error: 'INVALID_ACTION' })); return; }
        try {
          const result = await handleRpc(rpcChannel, body);
          const json = JSON.stringify(result);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) }).end(json);
        } catch (error) {
          const status = Number(error?.status) || 400;
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: String(error?.code || 'DIAG_ERROR') }));
        }
      },
    }));

    let panelWindowStart = Date.now();
    let panelWindowCount = 0;
    const unregisterPanelDiag = track(register({
      kind: 'exact',
      path: '/api/no996-openfilm/client-diag',
      async handler(req, res) {
        res.setHeader('cache-control', 'no-store');
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
        const admission = ctx.connection.admit({ headers: req.headers });
        if ('rejection' in admission || admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end(); return; }
        const now = Date.now();
        if (now - panelWindowStart > 60_000) { panelWindowStart = now; panelWindowCount = 0; }
        if (panelWindowCount >= 60) { res.writeHead(429).end(); return; }
        panelWindowCount += 1;
        const body = await readJsonBody(req, 8 * 1024);
        if (!body || typeof body !== 'object') { res.writeHead(400).end(); return; }
        diagLog.record({
          level: body.level === 'warn' || body.level === 'info' ? body.level : 'error',
          layer: typeof body.layer === 'string' ? body.layer : 'ui',
          traceId: typeof body.traceId === 'string' ? body.traceId : '',
          code: typeof body.code === 'string' ? body.code : 'PANEL_ERROR',
          channel: typeof body.channel === 'string' ? body.channel : '',
          httpStatus: Number.isInteger(body.httpStatus) ? body.httpStatus : null,
          projectId: typeof body.projectId === 'string' ? body.projectId : '',
          location: typeof body.location === 'string' ? body.location : '',
          summary: typeof body.summary === 'string' ? body.summary : '',
          detail: body.detail && typeof body.detail === 'object' ? body.detail : null,
        });
        res.writeHead(204).end();
      },
    }));

    disposers.push(unregisterLogs, unregisterPanelDiag);
  }

  return Object.freeze({ handleRpc, buildExport, disposers });
}
