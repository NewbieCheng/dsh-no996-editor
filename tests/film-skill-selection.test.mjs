import test from 'node:test';
import assert from 'node:assert/strict';
import { filmSkillCatalog, selectedSkillContext, skillListing } from '../src/native/film-skill-selection.mjs';

test('film skill selections keep the preset and OpenFilm installations distinct', async () => {
  let enabled = true;
  const catalog = path => filmSkillCatalog(path, {
    builtin: () => [{ name: 'director', description: 'Preset', resourceBase: { path: '/preset' }, content: 'Preset instructions' }],
    openfilm: async () => ({
      offeredSkills({ project }) {
        assert.equal(project, '/film');
        return { usable: [...(enabled ? [{ uid: 'mine:director', name: 'director', description: 'Installed', source: 'mine' }] : []),
          { uid: 'official:other', name: 'other', source: 'official' }] };
      },
      skillText: () => 'Installed instructions',
    }),
  });
  const listing = skillListing(await catalog('/film'));
  const [preset] = listing.own.skills;
  const [installed] = listing.openfilm;
  assert.equal(preset.title, installed.title);
  assert.notEqual(preset.name, installed.name);
  assert.equal(listing.openfilm.length, 1);
  assert.match(await selectedSkillContext('/film', [preset.name], catalog), /Preset instructions/);
  assert.doesNotMatch(await selectedSkillContext('/film', [installed.name], catalog), /Preset instructions/);
  enabled = false;
  await assert.rejects(selectedSkillContext('/film', [installed.name], catalog), { code: 'OFFICIAL_SKILL_UNAVAILABLE' });
  assert.match(await selectedSkillContext('/film', [preset.name], catalog), /Preset instructions/);
  await assert.rejects(selectedSkillContext('/film', ['../bad'], catalog), { code: 'OFFICIAL_SKILL_UNAVAILABLE' });
});
