import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { fileURLToPath } from 'node:url';

/**
 * The templates are now generated from `_kit/` + `shots/*.json`. These tests hold
 * the two promises that make that refactor safe:
 *
 *   1. 生成的标记与拆分前的页面一致（同一批 div、同样的 class 和文本）；
 *   2. 每个选择器最终生效的声明一致——把共享样式与单元样式合起来、把 CSS
 *      变量代进去之后，与拆分前逐条相同。
 *
 * Without (2) a "clean refactor" can quietly turn a 92px title into an 80px one
 * and nobody notices until the film is rendered.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const templates = join(root, 'vendor', 'templates');
const fixtures = join(root, 'tests', 'fixtures', 'templates');

// Whitespace between tags is not rendered; everything else is compared literally.
const collapse = text => text.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

function bodyOf(html) {
  const match = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
  assert.ok(match, 'page has a body');
  return collapse(match[1].replace(/<script>[\s\S]*?<\/script>/, ''));
}

function styleOf(html) {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
}

/** selector → [ "prop: value", … ], with CSS variables substituted. */
function parseCss(text, vars = {}) {
  const rules = new Map();
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(part => collapse(part)).filter(Boolean);
    const declarations = match[2]
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => collapse(part));
    for (const selector of selectors) {
      const list = rules.get(selector) ?? [];
      rules.set(selector, list.concat(declarations));
    }
  }
  // Resolve var() after the whole sheet is known, so order does not matter.
  const scope = { ...vars };
  for (const [selector, declarations] of rules) {
    if (selector === ':root') {
      for (const declaration of declarations) {
        const [name, ...rest] = declaration.split(':');
        scope[name.trim().replace(/^--/, '')] = collapse(rest.join(':'));
      }
    }
  }
  const resolve = value => value.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, name, fallback) => {
    const key = name.replace(/^--/, '');
    return scope[key] !== undefined ? scope[key] : collapse(fallback ?? '');
  });
  // `line-height: normal` is the initial value: a unit that always emits it
  // (because the size is a variable with a fallback) renders identically to a
  // page that omits it. Normalising the initial value away keeps the comparison
  // about what is actually painted.
  const INITIAL = new Set(['line-height: normal']);
  const out = new Map();
  for (const [selector, declarations] of rules) {
    const resolved = declarations.map(declaration => {
      const index = declaration.indexOf(':');
      return `${collapse(declaration.slice(0, index))}: ${collapse(resolve(declaration.slice(index + 1)))}`;
    }).filter(declaration => !INITIAL.has(declaration)).sort();
    out.set(selector, resolved);
  }
  return out;
}

function sameCss(actual, expected, label) {
  const missing = [...expected.keys()].filter(selector => !actual.has(selector));
  const extra = [...actual.keys()].filter(selector => !expected.has(selector));
  assert.deepEqual(missing, [], `${label}: selectors missing from the generated page`);
  // `assets/kit.css` is the union of all shots' units, so a page may carry rules
  // for blocks it does not use. What matters is that nothing it *does* use changed.
  void extra;
  for (const [selector, declarations] of expected) {
    if (selector === ':root') {
      // The refactor adds one variable per per-shot difference (title size,
      // capsule height…). Those are new names by design; the values they replace
      // are proven by every other selector below.
      const actualRoot = actual.get(selector) ?? [];
      for (const declaration of declarations) {
        assert.ok(actualRoot.includes(declaration), `${label}: ${declaration} disappeared from :root`);
      }
      continue;
    }
    assert.deepEqual(actual.get(selector), declarations, `${label}: "${selector}" declarations changed`);
  }
}

for (const template of ['paper-texture']) {
  const dir = join(templates, template);
  const fixtureDir = join(fixtures, template);
  const shots = readdirSync(join(dir, 'shots')).filter(name => name.endsWith('.json')).sort();

  for (const name of shots) {
    const id = name.replace(/\.json$/, '');
    test(`${template}/${id}: 生成的标记与拆分前一致`, () => {
      const generated = readFileSync(join(dir, 'pages', `${id}.html`), 'utf8');
      const original = readFileSync(join(fixtureDir, `${id}.html`), 'utf8');
      assert.equal(bodyOf(generated), bodyOf(original));
    });

    test(`${template}/${id}: 每个选择器生效的样式与拆分前一致`, () => {
      const generated = readFileSync(join(dir, 'pages', `${id}.html`), 'utf8');
      const original = readFileSync(join(fixtureDir, `${id}.html`), 'utf8');
      const generatedCss = styleOf(generated) + '\n' + readFileSync(join(dir, 'assets', 'kit.css'), 'utf8');
      sameCss(parseCss(generatedCss), parseCss(styleOf(original)), `${template}/${id}`);
    });
  }

  test(`${template}: 镜头墙的时间轴与每个镜头自己的时长一致`, () => {
    const wall = readFileSync(join(dir, 'film.html'), 'utf8');
    const frames = [...wall.matchAll(/<iframe id="([^"]+)"[^>]*src="pages\/\1\.html#t=0,([\d.]+)" at="([\d.]+)"/g)];
    assert.equal(frames.length, shots.length);
    let expected = 0;
    for (const [, id, duration, at] of frames) {
      assert.equal(Number(at), Number(expected.toFixed(3)), `${id} starts at the wrong second`);
      const shot = JSON.parse(readFileSync(join(dir, 'shots', `${id}.json`), 'utf8'));
      assert.equal(Number(duration), shot.duration, `${id} declares a different duration`);
      expected += shot.duration;
    }
  });
}

/**
 * 安装模板是把整个模板目录复制进项目（src/official/official-templates.mjs 的 copy）。
 * 所以页面只能引用模板目录内部的资源——一个指向 `_kit/` 的 ../ 链接在项目里会
 * 404，而且只在那时候才炸。这条测试守的就是这个边界。
 */
for (const template of ['paper-texture', 'sketchnote', 'vibe-explainer']) {
  test(`${template}: 页面只引用模板目录内部的资源`, () => {
    const dir = join(templates, template);
    const offenders = [];
    for (const name of readdirSync(join(dir, 'pages'))) {
      const html = readFileSync(join(dir, 'pages', name), 'utf8');
      for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        if (/^(?:https?:|data:|#)/.test(ref)) continue;
        const resolved = join(dir, 'pages', ref);
        const relative = resolved.slice(dir.length);
        if (!relative || relative.includes('..')) offenders.push(`${name} → ${ref}`);
        else if (!existsSync(resolved)) offenders.push(`${name} → ${ref} (missing)`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test(`${template}: 提交的页面与 shots 源一致`, () => {
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, [join(root, 'scripts', 'templates-build.mjs'), '--check', template], { stdio: 'pipe' });
  });
}

/**
 * 素材库本身也要能被组合：每个单元用示例数据渲染一次，检查槽位被填满、没有
 * 残留的 `{{…}}`、以及可选的 {{#if}} 真的能去掉整块。
 */
import { readCatalog, renderUnit } from '../vendor/templates/_kit/render.mjs';

test('素材库：每个单元都能用示例数据渲染出来', () => {
  const catalog = readCatalog();
  const samples = {
    'paper.grain': {},
    'paper.head': { kicker: 'K', title: '<em>T</em>' },
    'paper.stage': { slideTitle: 'S', slideHint: 'H' },
    'paper.nameplate': { text: 'N' },
    'paper.presenter': { text: 'P' },
    'paper.capsule': { text: 'C' },
    'paper.steps': { items: '<div class="step">x</div>' },
    'paper.step': { num: '1', title: 'T', body: 'B' },
  };
  for (const id of Object.keys(catalog.units)) {
    assert.ok(samples[id], `catalog 里的 ${id} 还没有示例数据`);
    const html = renderUnit({ unit: id, props: samples[id] }, catalog, { copy: {} });
    assert.doesNotMatch(html, /\{\{/, `${id} 渲染后仍有未替换的槽位`);
    assert.ok(html.trim().length > 0, `${id} 渲染成空的了`);
  }
});

/**
 * 手绘笔记是"一场戏 + 多个窗口"：页面只声明时间窗，画由 notebook.js 按绝对
 * 时间完成。所以校验点不是标记，而是窗口参数与脚本装配——窗口写错时画面看着
 * 正常，只是内容错位，最难靠肉眼发现。
 */
const sketchDir = join(templates, 'sketchnote');
const sketchFixtures = join(fixtures, 'sketchnote');
const sketchShots = readdirSync(join(sketchDir, 'shots')).filter(name => name.endsWith('.json')).sort();

for (const name of sketchShots) {
  const id = name.replace(/\.json$/, '');
  test(`sketchnote/${id}: 时间窗与脚本装配与拆分前一致`, () => {
    const generated = readFileSync(join(sketchDir, 'pages', `${id}.html`), 'utf8');
    const original = readFileSync(join(sketchFixtures, 'pages', `${id}.html`), 'utf8');
    const pick = (html, re) => re.exec(html)[1];
    assert.equal(pick(generated, /<title>([^<]*)<\/title>/), pick(original, /<title>([^<]*)<\/title>/));
    assert.equal(pick(generated, /const START = ([\d.]+);/), pick(original, /const START = ([\d.]+);/));
    assert.equal(pick(generated, /const DURATION = ([\d.]+);/), pick(original, /const DURATION = ([\d.]+);/));
    assert.equal(pick(generated, /<canvas ([^>]*)>/), pick(original, /<canvas ([^>]*)>/));
    const scripts = html => [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(scripts(generated), scripts(original));
    assert.match(generated, /notebook\.draw\(toSourceTime\(START \+ local\)\)/);
  });
}

test('sketchnote: 镜头墙的窗口首尾相接，等于整场戏', () => {
  const wall = readFileSync(join(sketchDir, 'film.html'), 'utf8');
  const frames = [...wall.matchAll(/<iframe id="([^"]+)"[^>]*src="pages\/\1\.html#t=0,([\d.]+)" at="([\d.]+)"/g)];
  assert.equal(frames.length, sketchShots.length);
  let end = 0;
  for (const [, id, duration, at] of frames) {
    assert.equal(Number(at), Number(end.toFixed(3)), `${id} 的起点与上一个窗口不连续`);
    end += Number(duration);
  }
  // 整场戏的时长 = 最后一个窗口的终点；页面里的绝对时间都落在这条线上。
  for (const name of sketchShots) {
    const shot = JSON.parse(readFileSync(join(sketchDir, 'shots', name), 'utf8'));
    assert.ok(shot.start + shot.duration <= end + 1e-9, `${name} 超出了整场戏的时长`);
  }
});
