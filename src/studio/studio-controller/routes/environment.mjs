// The environment route: one read-only JSON answer to "what does the film
// agent actually see?" — preset activation, the ACP child's skill gate, the
// film tools, and (with ?projectId=) that project's instruction chain.
//
// Deliberately evidence, not guesses: no model is called, nothing is written,
// and every probe degrades to a named field instead of failing the route.
// The bundle detail page (`plugins.detail.section`) renders this; per-turn
// evidence stays on /diagnose.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONA, ROOT_MARKERS } from '../../../native/openfilm-persona.mjs';

const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;

/** `name:` + first `description:` line of a SKILL.md frontmatter block. */
function skillMeta(dir, file) {
  try {
    const text = readFileSync(join(dir, file, 'SKILL.md'), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const head = match ? match[1] : '';
    const name = (/^name:\s*(.+)$/m.exec(head)?.[1] ?? file).trim().replace(/^["']|["']$/g, '');
    const description = (/^description:\s*(.+)$/m.exec(head)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
    return { id: name, description: description.slice(0, 300) };
  } catch {
    return { id: file, description: '' };
  }
}

/**
 * @param {object} deps
 * @param {object} deps.ctx - Host context (connection admission + agentPresets roster)
 * @param {Function} deps.register - webServer route register
 * @param {Function} deps.track - disposer tracker
 * @param {string} deps.skillsDir - this package's skills/ directory (the isolated root)
 * @param {() => Array<{name?: string, description?: string}>} [deps.filmTools] - film tool catalog
 * @param {(path: string) => object} [deps.instructions] - per-project chain (same fn as diagnose)
 * @param {(projectId: string) => Promise<string|null>} [deps.projectPathOf] - project dir lookup
 * @param {(projectPath: string) => string[]} [deps.activeTemplatesOf] - active template ids
 */
export function createEnvironmentRoute({
  ctx,
  register,
  track,
  skillsDir,
  filmTools = () => [],
  instructions = null,
  projectPathOf = null,
  activeTemplatesOf = null,
}) {
  const unregister = track(register({
    kind: 'exact', path: '/api/no996-openfilm/environment',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission || admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('{}'); return; }
      const projectId = (() => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const value = url.searchParams.get('projectId');
          return typeof value === 'string' && PROJECT_ID.test(value) ? value : '';
        } catch { return ''; }
      })();
      // The sidebar preset: registered and healthy, or the row says why not.
      let preset = null;
      try {
        const registry = ctx.get?.('agentPresets');
        const roster = typeof registry?.list === 'function' ? await registry.list() : [];
        const found = roster.find(item => item?.id === 'openfilm-video-editing');
        preset = found
          ? { id: 'openfilm-video-editing', ok: !found.error && !found.failure, detail: String(found.error ?? found.failure ?? 'ok').slice(0, 200) }
          : { id: 'openfilm-video-editing', ok: false, detail: 'not registered' };
      } catch (error) { preset = { id: 'openfilm-video-editing', ok: false, detail: String(error?.message || error).slice(0, 200) }; }
      // The film child's skill gate: this package's skills/ only. The ~50-entry
      // global catalog (agentsHome) and the DSH-home roots never enter a film turn;
      // <project>/.agents/skills and <project>/.dsh/skills stay as the escape hatch.
      const skills = (() => {
        try {
          if (typeof skillsDir !== 'string' || !skillsDir || !existsSync(skillsDir)) return { root: skillsDir ?? '', isolated: [], error: 'skills-dir-missing' };
          const folders = readdirSync(skillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
          return { root: 'skills/', isolated: folders.map(folder => skillMeta(skillsDir, folder)), error: null };
        } catch (error) { return { root: 'skills/', isolated: [], error: String(error?.code ?? error?.message ?? error).slice(0, 80) }; }
      })();
      const tools = (() => {
        try {
          const list = typeof filmTools === 'function' ? filmTools() : [];
          return (Array.isArray(list) ? list : [])
            .filter(tool => tool && typeof tool.name === 'string')
            .map(tool => ({ name: tool.name, description: String(tool.description ?? '').slice(0, 200) }));
        } catch { return []; }
      })();
      // Per-project part: the instruction chain of that film folder, if named.
      const project = await (async () => {
        if (!projectId || !instructions || !projectPathOf) return null;
        try {
          const path = await projectPathOf(projectId);
          if (typeof path !== 'string' || !path) return { projectId, error: 'unknown-project' };
          const chain = instructions(path);
          let active = null;
          try { active = typeof activeTemplatesOf === 'function' ? await activeTemplatesOf(path) : null; } catch { active = null; }
          return { projectId, ...chain, activeTemplates: active };
        } catch (error) { return { projectId, error: String(error?.code ?? error?.message ?? error).slice(0, 120) }; }
      })();
      const body = JSON.stringify({
        preset,
        // What the ACP child boots with: identity, instruction boundary, skill gate,
        // and the preset's prompt module reused verbatim (never a copy).
        child: {
          persona: { bytes: Buffer.byteLength(PERSONA, 'utf8'), limit: 400, ok: Buffer.byteLength(PERSONA, 'utf8') <= 400 },
          instructions: { projectRootMarkers: ROOT_MARKERS, maxBytes: 65536 },
          skills: { includeDefaultRoots: false, customSkillDirs: ['<plugin>/skills'], extraSkillDirs: ['<project>/.agents/skills', '<project>/.dsh/skills'] },
          prompt: { module: 'src/acp/openfilm-prompt.mjs', mountedAs: 'openfilm-video-prompt' },
        },
        skills,
        tools,
        project,
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }).end(body);
    },
  }));

  return { disposers: [unregister] };
}
