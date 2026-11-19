import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKitTool } from '../src/tools/kit-tool.mjs';

test('openfilm_kit lists, searches inspiration, and installs reusable vibe/motion runtimes into any project', async t => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'openfilm-kit-tool-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  const tool = createKitTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'p1', path: projectRoot }),
  });

  const listed = await tool.execute({ action: 'list' }, { agent: { session: { id: 's1' } } });
  assert.ok(listed.text.includes('vibe-canvas') && listed.text.includes('vibe-overlay') && listed.text.includes('motion'));

  const inspired = await tool.execute({ action: 'inspire', query: 'opening' }, { agent: { session: { id: 's1' } } });
  assert.ok(inspired.text.includes('镜头卡') || inspired.text.includes('动效风格'));

  const installed = await tool.execute({ action: 'install', kit: 'vibe-canvas' }, { agent: { session: { id: 's1' } } });
  assert.ok(installed.text.includes('assets/kit/vibe-canvas.js'));
  assert.ok(existsSync(join(projectRoot, 'assets', 'kit', 'motion.js')), 'installing vibe-canvas should also ensure motion.js dependency');
  assert.ok(existsSync(join(projectRoot, 'assets', 'kit', 'vibe-canvas.js')));
  assert.ok(readFileSync(join(projectRoot, 'assets', 'kit', 'vibe-canvas.js'), 'utf8').includes('VibeKit'));
});
