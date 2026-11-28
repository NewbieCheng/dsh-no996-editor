import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeHtml, page, shotWall } from '../../../packages/no996-scene-kit/src/index.mjs';

const kitRoot = fileURLToPath(new URL('.', import.meta.url));

export function readCatalog() {
  return JSON.parse(readFileSync(new URL('catalog.json', import.meta.url), 'utf8'));
}

export function unitPath(id, catalog) {
  const unit = catalog.units[id];
  if (!unit) throw new Error(`unknown unit "${id}" (add it to _kit/catalog.json)`);
  return new URL(unit.file, import.meta.url);
}

export function readUnit(id, catalog) {
  return readFileSync(unitPath(id, catalog), 'utf8').replace(/\n$/, '');
}

/** Resolve `{{a.b}}` against `{ copy: {...}, shot: {...} }`; missing values throw. */
export function lookup(path, scope) {
  const parts = path.split('.');
  let value = scope;
  for (const part of parts) {
    if (value === null || value === undefined) break;
    value = value[part];
  }
  if (value === undefined) throw new Error(`missing value for "{{${path}}}"`);
  return value;
}

/** Escaped `{{x}}`, raw `{{{x}}}`. Missing data fails instead of painting a blank. */
export function fill(template, scope) {
  return template
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, path) => String(lookup(path, scope)))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => escapeHtml(lookup(path, scope)));
}

export function resolveProp(value, scope) {
  if (typeof value !== 'string') return { text: String(value ?? ''), raw: false };
  const trimmed = value.trim();
  const raw = /^\{\{\{\s*([\w.]+)\s*\}\}\}$/.exec(trimmed);
  if (raw) return { text: String(lookup(raw[1], scope)), raw: true };
  const escaped = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(trimmed);
  if (escaped) return { text: String(lookup(escaped[1], scope)), raw: false };
  return { text: fill(value, scope), raw: false };
}

function fillUnit(template, props, scope) {
  const resolvedOnce = template.replace(/\{\{#if\s+props\.([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
    const prop = props[key];
    return prop && prop.text ? body : '';
  });
  return resolvedOnce
    .replace(/\{\{\{\s*props\.([\w.]+)\s*\}\}\}/g, (_, key) => {
      const prop = props[key];
      if (!prop) throw new Error(`missing prop "${key}"`);
      return prop.text;
    })
    .replace(/\{\{\s*props\.([\w.]+)\s*\}\}/g, (_, key) => {
      const prop = props[key];
      if (!prop) throw new Error(`missing prop "${key}"`);
      return promoteText(prop);
    })
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, path) => String(lookup(path, scope)))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => escapeHtml(lookup(path, scope)));
}

function promoteText(prop) {
  return prop.raw ? prop.text : escapeHtml(prop.text);
}

export function renderUnit(unitSpec, catalog, scope) {
  const { unit, id } = unitSpec;
  const template = readUnit(unit, catalog);
  const props = { ...(unitSpec.props ?? {}) };
  if (id !== undefined) props.id = id;
  if (unitSpec.repeat) {
    const { unit: childUnit, items = [], as = 'items' } = unitSpec.repeat;
    props[as] = items
      .map(item => renderUnit({ unit: childUnit, props: item }, catalog, scope))
      .join('');
  }
  const resolved = {};
  for (const [key, value] of Object.entries(props)) resolved[key] = resolveProp(value, scope);
  return fillUnit(template, resolved, scope);
}

export function renderUnits(units, catalog, scope) {
  return (units ?? []).map(unitSpec => renderUnit(unitSpec, catalog, scope)).join('\n');
}

/** Styles a shot needs, in use order and without duplicates. */
export function collectUnitStyles(units, catalog) {
  const seen = new Set();
  const blocks = [];
  const walk = list => {
    for (const spec of list ?? []) {
      const unit = catalog.units[spec.unit];
      if (!unit) throw new Error(`unknown unit "${spec.unit}"`);
      if (unit.css && !seen.has(unit.css)) {
        seen.add(unit.css);
        blocks.push(readFileSync(new URL(unit.css, import.meta.url), 'utf8').trim());
      }
      if (spec.repeat) walk((spec.repeat.items ?? []).map(props => ({ unit: spec.repeat.unit, props })));
    }
  };
  walk(units);
  return blocks.join('\n');
}

export { escapeHtml, page, shotWall };
