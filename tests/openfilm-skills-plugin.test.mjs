import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply as applySkills } from '../src/native/openfilm-skills.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('openfilm-skills plugin registers only this package skills and disposes them cleanly', () => {
  const registered = [];
  const disposed = [];
  const ctx = {
    skills: {
      register(skill) {
        registered.push(skill);
        return () => disposed.push(skill.name);
      },
    },
  };

  const dispose = applySkills(ctx);
  assert.deepEqual(
    registered.map(item => item.name).sort(),
    ['openfilm-director', 'openfilm-editing', 'openfilm-motion'],
  );
  for (const item of registered) {
    assert.ok(item.description.length > 0);
    assert.ok(item.content.length > 0);
    assert.equal(item.resourceBase?.kind, 'directory');
  }
  dispose();
  assert.equal(disposed.length, 3);
});

test('cordis.patch.yml links preset-openfilm-video-editing with persona, root markers, and isolated skills', () => {
  const yaml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(yaml, /id: openfilm-video-editing/);
  assert.match(yaml, /@deepseek-ai\/dsh-persona/);
  assert.match(yaml, /剪辑导演/);
  assert.match(yaml, /projectRootMarkers:/);
  assert.match(yaml, /- \.film/);
  assert.match(yaml, /- film\.html/);
  assert.match(yaml, /includeDefaultRoots: false/);
  assert.match(yaml, /dsh-openfilm\/openfilm-skills/);
});
