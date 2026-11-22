/**
 * Pure mapping helpers translating DSH native tool calls and content blocks
 * into the ACP event shapes expected by OpenFilm's compiled chat UI.
 */

export function parseToolArgs(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { return value; }
}

/**
 * Map DSH native tool names onto the ACP `title` / `kind` / `rawInput` shapes
 * that OpenFilm's compiled `localToolActivity` promotes to persistent rows
 * (instead of collapsing into ephemeral `working`).
 */
export function mapToolCallForUi(name, rawInput) {
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
  const lower = String(name || '').toLowerCase();
  if (lower.startsWith('no996_') || lower.startsWith('openfilm_')) {
    return { title: name, toolName: name, kind: 'other', rawInput: input };
  }
  if (lower === 'pwsh' || lower === 'bash' || lower === 'shell' || lower === 'terminal') {
    const cmd = input.command ?? input.cmd ?? input.script ?? '';
    return {
      title: 'bash',
      toolName: name,
      kind: 'execute',
      rawInput: { ...input, ...(typeof cmd === 'string' && cmd ? { command: cmd } : {}) },
    };
  }
  if (lower === 'read' || lower === 'read_image' || lower === 'read_file' || lower === 'view_file') {
    const p = input.path ?? input.file_path ?? input.file ?? '';
    return {
      title: 'read',
      toolName: name,
      kind: 'read',
      rawInput: { ...input, ...(typeof p === 'string' && p ? { path: p } : {}) },
    };
  }
  if (lower === 'glob' || lower === 'grep' || lower === 'search') {
    const q = input.pattern ?? input.query ?? input.path ?? '';
    return {
      title: 'grep',
      toolName: name,
      kind: 'search',
      rawInput: { ...input, ...(typeof q === 'string' && q ? { pattern: q, query: q } : {}) },
    };
  }
  if (lower === 'write' || lower === 'edit' || lower === 'write_file' || lower === 'edit_file') {
    const p = input.path ?? input.file_path ?? input.file ?? '';
    return {
      title: 'edit',
      toolName: name,
      kind: 'edit',
      rawInput: { ...input, ...(typeof p === 'string' && p ? { path: p } : {}) },
    };
  }
  if (lower === 'web_search' || lower === 'no996_web_search' || lower === 'web_fetch') {
    const queries = Array.isArray(input.queries) ? input.queries.filter(value => typeof value === 'string').slice(0, 8) : [];
    const q = String(input.query ?? input.url ?? queries.join(' · ')).slice(0, 600);
    return {
      title: name,
      toolName: name,
      kind: lower === 'web_fetch' ? 'fetch' : 'search',
      rawInput: { ...input, ...(typeof q === 'string' && q ? { query: q } : {}) },
    };
  }
  if (lower === 'skill') {
    const s = input.name ?? input.skill ?? '';
    return {
      title: 'read',
      toolName: 'skill',
      kind: 'read',
      rawInput: { ...input, ...(typeof s === 'string' && s ? { path: `skill:${s}` } : {}) },
    };
  }
  return { title: name, toolName: name, kind: 'other', rawInput: input };
}

export function convertToolContent(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'content', content: { type: 'text', text: block.text } });
    }
  }
  return out;
}
