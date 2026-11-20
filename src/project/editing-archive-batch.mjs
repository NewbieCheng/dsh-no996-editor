import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createEditingArchiveBatch({ file, bindings, archive, verify, isBusy }) {
  let queue = Promise.resolve();
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function load() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.ids)) throw new Error('Invalid archive receipt');
      return new Set(data.ids.filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(id)));
    } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  }
  async function save(ids) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, ids: [...ids] }), { flag: 'wx' });
    await rename(temporary, file);
  }
  return action => serialize(async () => {
    if (!archive.available) return { available: false };
    const receipts = await load();
    const candidates = [];
    const seen = new Set();
    for (const row of bindings.all()) {
      if (!row.sessionId || seen.has(row.sessionId) || (action === 'restore' && !receipts.has(row.sessionId))) continue;
      seen.add(row.sessionId);
      try {
        const project = await verify(row.projectId);
        if (!project) continue;
        if (row.cwd) {
          const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
          if (typeof project.path !== 'string' || key(row.cwd) !== key(project.path)) continue;
        }
      } catch { continue; }
      candidates.push(row);
    }
    let eligible = 0, changed = 0, skipped = 0, failed = 0;
    for (const row of candidates) {
      const id = row.sessionId;
      const expected = action === 'restore' ? 'archived' : 'live';
      if (archive.state(id) !== expected || (action !== 'restore' && await isBusy(row))) { skipped++; continue; }
      eligible++;
      if (action === 'preview') continue;
      try {
        if (action === 'archive') { await archive.archive(id); receipts.add(id); }
        else { await archive.unarchive(id); receipts.delete(id); }
        changed++;
      } catch { failed++; }
      await save(receipts);
    }
    return { available: true, eligible, changed, skipped, failed, recoverable: receipts.size };
  });
}
