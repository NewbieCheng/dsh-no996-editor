import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellUiInjection, shellUiVersion } from '../src/ui/shell-extras.mjs';

const html = shellUiInjection();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const body = scripts.join('\n');

test('the injected shell UI is balanced scripts that parse as JavaScript', () => {
  // Spliced into an existing <head>; a stray </script> or broken expression
  // would break the whole page rather than just the overlays.
  assert.match(html, /^<script>/);
  assert.match(html, /<\/script>$/);
  // Only the UI overlay is still injected; the login gate ships in the bundle.
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.equal(scripts.length, 1);
  assert.match(body, /\/__dsh\/official-rpc/);
  assert.match(body, /__dsh\/shell-version/);
  assert.match(body, /function watchVersion\(\)/);
  assert.match(body, /auth:status/);
  // The hand-written block must not contain unresolved placeholders.
  assert.doesNotMatch(body, /\$\{/);
  for (const script of scripts) new Function(script);
});

test('the login city module is generated and mountable', () => {
  const city = readFileSync(new URL('../assets/login-city.js', import.meta.url), 'utf8');
  assert.match(city, /window\.__NOF_MOUNT_CITY__ = async function \(root\)/);
  assert.match(city, /const renderAt = async \(t\) =>/);
  // 登录页要隐藏内置太阳/光芒，改画会东升西落的日与月。
  assert.match(city, /id', 'nof-sun'/);
  assert.match(city, /id', 'nof-rays'/);
  // file:// 与 dsh-app:// 下都没有可 fetch 的源，cues 必须内联。
  assert.doesNotMatch(city, /fetch\(/);
});

test('the template picker left the injection; the upstream card is still stopped', () => {
  // The picker is React now (TemplatePicker.tsx, shipped in the vendored build):
  // the clone-and-place code is gone from here for good.
  for (const gone of [/cloneNode\(true\)/, /wrap=buildEntry\(card\)/, /el\.textContent='选择模板'/, /no996-template-modal/, /no996-bay-in/, /no996-template-picker/, /items\.forEach/, /aria-checked/]) {
    assert.doesNotMatch(body, gone);
  }
  // What stays: upstream's own 视频复刻 card is visible but inert; unknown skill
  // entries are stopped the same way. About branding is SettingsModal (A1).
  assert.match(body, /视频复刻暂不可用/);
  assert.match(body, /data-no996-disabled/);
  assert.match(body, /stopImmediatePropagation/);
  assert.doesNotMatch(body, /function tuneAbout\(\)/);
  assert.doesNotMatch(body, /基于 OpenFilm 开发/);
  assert.doesNotMatch(body, /兼容 OpenFilm /);
  // The project/example entry and the skill library are real flows now: the
  // injection must not disable those links, or "参考" could never be reached.
  assert.doesNotMatch(body, /'更多技能','从示例开始'/);
  assert.doesNotMatch(body, /function disableExtras\(\)/);
  assert.doesNotMatch(body, /data-no996-off/);
});

test('a dead Studio is answered by the shell source, not by an injected overlay', () => {
  // The overlay moved out of the injection and into the shell app itself
  // (apps/desktop/shell/RecoveryGate.tsx, shipped in the vendored build). The
  // injection must no longer carry it; the shipped bundle must.
  assert.doesNotMatch(body, /no996-stopped/);
  assert.doesNotMatch(body, /重新启动工作台/);
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'official-shell', 'ui', 'assets');
  const bundle = readdirSync(dir)
    .filter(name => name.endsWith('.js'))
    .map(name => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(bundle, /重新启动工作台/);
  assert.match(bundle, /no996-openfilm:restart/);
  // Health is local; /api/version hits npm and used to false-trigger restart loops.
  assert.match(bundle, /\/api\/health/);
  assert.doesNotMatch(bundle, /fetch\('\/api\/version'/);
});

test('a foreign plugin probing this page cannot throw in the console', () => {
  assert.match(body, /typeof window\.__dshEsSetShortcut!=='function'/);
});

test('About branding lives in SettingsModal (source or patch), not the injection', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(fileURLToPath(new URL('..', import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dep = String(pkg.dependencies.openfilm || '');
  const pinned = (/openfilm-([0-9][0-9.]*)\.tgz/.exec(dep) || /^([0-9]+\.[0-9]+\.[0-9]+)$/.exec(dep))[1];
  const modal = join(root, '.upstream/openfilm/packages/openfilm/studio/ui/src/components/settings/SettingsModal.tsx');
  const zh = join(root, '.upstream/openfilm/packages/openfilm/studio/ui/src/i18n/zh-CN.ts');
  // The recorded patch is the authoritative copy and is always in the repo; a
  // local upstream checkout may be stale or on another pin, so prefer the patch.
  const recorded = join(root, 'vendor/official-shell/patch.diff');
  const text = existsSync(recorded)
    ? readFileSync(recorded, 'utf8')
    : `${readFileSync(modal, 'utf8')}\n${readFileSync(zh, 'utf8')}`;
  assert.match(text, /settings\.links\.compat|links\.compat/);
  assert.match(text, /embedded: '基于 OpenFilm 开发'/);
  assert.match(text, /不加班剪辑 界面使用的语言/);
  assert.ok(text.includes(`OPENFILM_PIN = '${pinned}'`) || text.includes(pinned), `pin ${pinned} must appear`);
});

test('the overlay version is the file mtime the page polls', () => {
  assert.match(shellUiVersion(), /^\d+$/);
});

test('the overlay is re-read from disk so editing it needs only a refresh', async () => {
  const { readFileSync, writeFileSync, utimesSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const file = fileURLToPath(new URL('../assets/shell-ui.js', import.meta.url));
  const original = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, `${original}\n// probe ${Date.now()}\n`, 'utf8');
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);
    assert.match(shellUiInjection(), /\/\/ probe/);
  } finally {
    writeFileSync(file, original, 'utf8');
  }
});
