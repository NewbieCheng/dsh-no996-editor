import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { NO996_SETTINGS_CSS, createNo996SettingsSection, injectSettingsCss } from '../src/ui/settings-section.mjs';

// The workbench's Settings page (`settings.section` list slot), verified against
// the working references on this host (dsh-agy-link, dsh-codex-subscription):
// - exactly one slot registration (`settings.section`), additive, never a replace;
// - NO `settings.section.icon` registration (row icon comes from bundle `icon`);
// - NEVER touch `ctx.styles` (the host throws on undeclared-service access and
//   optional chaining does NOT save it) — styles go in as a plain document
//   <style> tag with an id guard;
// - factory requires only react; entry inject stays exactly ['slots', 'locale'];
// - the plugin detail seat (plugins.bundle.config) renders the SAME new
//   component; the old EnvSection wall is deleted, only one surface remains;
// - disclosure sections default to collapsed.

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Comments may name forbidden APIs to explain the rule; strip them so the
// assertions pin the code, not the prose.
// Strip line comments FIRST: a `/*` inside a // comment (e.g. `/api/*`) is
// not a block comment, but a block-first regex would treat it as one and eat
// everything up to the next `*/` — including the code under test.
const codeOf = file => read(file)
  .split('\n')
  .filter(line => !line.trim().startsWith('//'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('settings CSS is token-only and scoped to the settings container', () => {
  assert.doesNotMatch(NO996_SETTINGS_CSS, /#[0-9a-fA-F]{3,8}\b/);
  const withoutOverlay = NO996_SETTINGS_CSS.replace(/rgba\(0,0,0,\.(?:55|35)\)/g, '');
  assert.doesNotMatch(withoutOverlay, /\b(?:rgb|rgba|hsl|hsla)\(/);
  for (const line of NO996_SETTINGS_CSS.split('\n')) {
    const rule = line.trim();
    if (!rule || rule.startsWith('/*') || rule.startsWith('@')) continue;
    if (!rule.includes('{') && !rule.includes('}')) continue;
    if (rule.includes('{')) assert.match(rule, /\[data-no996-settings/, `unscoped rule: ${rule}`);
  }
  for (const token of ['--dsw-alias-bg-layer-1', '--dsw-alias-border-l1', '--dsw-alias-label-primary', '--dsw-alias-brand-primary']) {
    assert.ok(NO996_SETTINGS_CSS.includes(token), `missing token ${token}`);
  }
});

test('the settings section factory builds a component without a browser', () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  };
  const Component = createNo996SettingsSection(React);
  assert.equal(typeof Component, 'function');
  const tree = Component();
  assert.ok(tree && typeof tree === 'object');
  assert.equal(typeof injectSettingsCss, 'function');
});

test('styles go through the document, never through ctx.styles', () => {
  assert.doesNotMatch(codeOf('src/ui/settings-section.mjs'), /ctx\.styles/);
  assert.doesNotMatch(codeOf('src/ui/settings-section.mjs'), /createPortal|react-dom/);
  assert.match(codeOf('src/ui/settings-section.mjs'), /document\.createElement\(['"]style['"]\)/);
  assert.doesNotMatch(codeOf('src/studio/studio-entry.js'), /ctx\.styles/);
});

test('the settings page is an additive slot with the official brand icon', () => {
  const entry = codeOf('src/studio/studio-entry.js');
  assert.match(entry, /ctx\.slots\.inject\('settings\.section'/);
  // The row icon uses the official brand mark through `settings.section.icon`,
  // exactly like the working dsh-codex-subscription on this host. Still no
  // replace anywhere: no priority on either registration.
  assert.match(entry, /inject\('settings\.section\.icon'/);
  assert.match(entry, /brandSvgMarkup/);
  assert.doesNotMatch(entry, /register\(\{[^}]*name: 'settings\.section[^}]*priority:/);
  assert.doesNotMatch(entry, /register\(\{[^}]*name: 'settings\.section\.icon[^}]*priority:/);
});

test('the client entry declares only what the working reference declares', () => {
  const entry = codeOf('src/studio/studio-entry.js');
  assert.match(entry, /return \{\s*\n?\s*inject: \['slots', 'locale'\]/);
  assert.doesNotMatch(entry, /require\(['"]react-dom['"]\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dsh?.client?.inject, [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-chat',
    '@deepseek-ai/dsh-client-ui-model-selection',
  ]);
  assert.equal(pkg.icon, './icon.svg');
  assert.ok(read('icon.svg').includes('<svg'), 'bundle icon file must exist');
});

test('no leftover dev-stage copy in user-facing strings', () => {
  for (const file of ['locale/zh.json', 'locale/en.json']) {
    const text = read(file);
    assert.doesNotMatch(text, /开发中|in development|beta/i, `${file} must not carry dev-stage copy`);
  }
});

test('the old detail wall is gone; the detail seat reuses the new component', () => {
  assert.ok(!existsSync(new URL('../src/ui/env-section.mjs', import.meta.url)), 'old EnvSection module must be deleted');
  const entry = codeOf('src/studio/studio-entry.js');
  assert.doesNotMatch(entry, /EnvSection|env-section|LegacyEnvCard/);
  assert.match(entry, /plugins\.bundle\.config[\s\S]{0,400}SettingsSection/);
});
