// The film agent's system prompt is the only always-on instruction. These lines are
// the two behaviours that regressed in the field: films that only flash (no emotion
// arc, no paid-off hook) and an agent shelling out to the packaged CLI, which started
// a second Studio and opened a browser page the person never asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/native/openfilm-prompt.mjs';

const promptText = () => {
  let text;
  apply({ systemPrompt: { section: section => { text = section.text; } } });
  return text;
};

test('the prompt asks for an audience first, then effects', () => {
  const text = promptText();
  assert.match(text, /AUDIENCE FIRST/, 'the emotion/hook rule is on every turn');
  assert.match(text, /must be paid off by a later shot/i, 'a promised hook has to be paid off');
  const audience = text.indexOf('AUDIENCE FIRST');
  const motion = text.indexOf('MANDATORY MOTION STANDARD');
  assert.ok(audience >= 0 && motion >= 0 && audience < motion, 'the audience comes before the effect vocabulary');
});

test('the prompt keeps the agent off the packaged CLI and out of film.html under a live Studio', () => {
  const text = promptText();
  assert.match(text, /never run the packaged openfilm cli/i);
  assert.match(text, /openfilm look/, 'the verb is named, not implied');
  assert.match(text, /no996_frame/, 'the supported way to see the film is named');
  assert.match(text, /do not rewrite film\.html/i);
  assert.match(text, /no996_clip \/ no996_draft/, 'the safe writers are named');
});
