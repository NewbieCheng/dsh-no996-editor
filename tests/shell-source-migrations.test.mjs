// Two pieces of UI that used to be runtime injections now live in the upstream
// shell source (apps/desktop/shell/{RecoveryGate,EnvironmentNotice}.tsx) and ship in
// the vendored build. Our repo cannot render React in a test, so this asserts the
// two halves that *are* checkable: the injection no longer carries them, and the
// shipped bundle still does. Behavior itself is verified by the manual acceptance
// run (playbooks/manual-acceptance.md).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const injection = readFileSync(join(root, 'assets', 'shell-ui.js'), 'utf8');
const assets = join(root, 'vendor', 'official-shell', 'ui', 'assets');
const bundle = readdirSync(assets)
  .filter(name => name.endsWith('.js'))
  .map(name => readFileSync(join(assets, name), 'utf8'))
  .join('\n');

test('the recovery overlay is source, not injection', () => {
  assert.doesNotMatch(injection, /no996-stopped/);
  // Silent auto-restart: postMessage stays, the blocking card copy is gone.
  assert.doesNotMatch(bundle, /重新启动工作台/);
  assert.match(bundle, /no996-openfilm:restart/);
});

test('the environment notice is source, not injection', () => {
  assert.doesNotMatch(injection, /no996-environment/);
  assert.doesNotMatch(injection, /__no996CheckTools=/);
  assert.match(bundle, /本机依赖检查|视频工具环境检查/);
  assert.match(bundle, /environment:check/);
  assert.match(bundle, /environment:fallback-prompt/);
  assert.match(bundle, /复制兜底提示词|尚未配置或安装/);
});

test('the native examples gallery contains the product templates, not a second picker', () => {
  assert.match(bundle, /template:list/);
  assert.match(bundle, /template:create/);
  assert.doesNotMatch(bundle, /data-no996-template-react/);
  assert.doesNotMatch(injection, /data-no996-template-react/);
  assert.doesNotMatch(injection, /no996-template-modal/);
  const series = JSON.parse(readFileSync(join(root, 'patches', 'series.json'), 'utf8'));
  const gallery = series.patches.find(entry => entry.source.endsWith('studio/ui/src/components/ProjectsLibrary.tsx'));
  assert.ok(gallery);
  const patch = readFileSync(join(root, 'patches', gallery.file), 'utf8');
  assert.match(patch, /supplement=\{<No996Templates/);
  assert.match(patch, /onStart=\{\(example\)/);
});

test('the login gate is a component, not a page script', () => {
  // The gate used to be a 643-line DOM injection that appended itself to
  // documentElement. It is LoginGate.tsx now (same copy, same stylesheet); only the
  // generated city backdrop is still a side-effect import.
  assert.doesNotMatch(injection, /no996-shell-login/);
  assert.doesNotMatch(injection, /__NOF_MOUNT_CITY__/);
  assert.match(bundle, /no996-shell-login/);
  assert.match(bundle, /__NOF_MOUNT_CITY__/);
  assert.match(bundle, /欢迎回来，准点下班。/);
  assert.match(bundle, /登录并继续剪辑/);
  assert.match(bundle, /记住本机账号和密码/);
});

test('workbench palette picker is gone; header brand DOM sync is gone', () => {
  // Brand marks belong in OpenFilm source (ADR-0009 A1). The old header SVG
  // scanner mis-replaced search icons and fought React remounts — do not bring it back.
  assert.doesNotMatch(injection, /syncStudioBrand/);
  assert.doesNotMatch(injection, /data-no996-studio-brand/);
  assert.doesNotMatch(injection, /n996-sb-svg/);
  assert.doesNotMatch(injection, /healMisplacedBrandMarks/);
  assert.doesNotMatch(injection, /工作台配色/);
  assert.doesNotMatch(injection, /data-n996-settings-appearance/);
  assert.doesNotMatch(injection, /no996\.openfilm\.theme/);
  assert.doesNotMatch(injection, /no996\.openfilm\.accent/);
});

test('both components are mounted by the shell entry', () => {
  // The entry is upstream source; the patch series is what carries it. Find the
  // patch through series.json rather than guessing its number.
  const series = JSON.parse(readFileSync(join(root, 'patches', 'series.json'), 'utf8'));
  const entry = series.patches.find(patch => patch.source.endsWith('apps/desktop/shell/main.tsx'));
  assert.ok(entry, 'series records the shell entry');
  const patch = readFileSync(join(root, 'patches', entry.file), 'utf8');
  assert.match(patch, /RecoveryGate/);
  assert.match(patch, /EnvironmentNotice/);
  const starters = series.patches.find(entry => entry.source.endsWith('apps/desktop/chat/src/components/ProjectStarters.tsx'));
  // OpenFilm 0.4.0 ships the Community + library starter chips upstream; the older
  // drop-box starter (and its empty-state hints) is gone with it, so do not fork it.
  assert.equal(starters, undefined, 'upstream owns the empty-state starters');
  const models = series.patches.find(entry => entry.source.endsWith('packages/openfilm/studio/ui/src/components/settings/ModelsSection.tsx'));
  assert.ok(models, 'series records ModelsSection deep-link for Local services');
  assert.match(readFileSync(join(root, 'patches', models.file), 'utf8'), /openfilm\.settings\.card/);
  const notice = series.patches.find(entry => entry.source.endsWith('apps/desktop/shell/EnvironmentNotice.tsx'));
  assert.ok(notice, 'series records EnvironmentNotice');
  const noticePatch = readFileSync(join(root, 'patches', notice.file), 'utf8');
  assert.match(noticePatch, /environment:fallback-prompt/);
  assert.match(noticePatch, /no996-fallback-prompt/);
});
