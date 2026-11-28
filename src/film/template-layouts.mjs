// Built-in template orientation contract. External compatibility metadata
// (`ratios`) alone never authorizes a renderer or a source path.
const orientations = Object.freeze({
  '9:16': Object.freeze({ suffix: 'portrait', size: Object.freeze([1080, 1920]) }),
  '16:9': Object.freeze({ suffix: 'landscape', size: Object.freeze([1920, 1080]) }),
});

const unknownLayout = () => Object.assign(new Error('Template does not support the requested canvas ratio'), { code: 'TEMPLATE_INPUT' });

export function readBundledTemplateLayouts(manifest) {
  if (manifest?.layoutVariants === undefined) return null;
  const { defaultRatio, ratios } = manifest.layoutVariants ?? {};
  if (!Array.isArray(ratios) || !ratios.length || ratios.length > 2 || new Set(ratios).size !== ratios.length ||
      ratios.some(ratio => typeof ratio !== 'string' || !Object.hasOwn(orientations, ratio)) || !ratios.includes(defaultRatio)) throw unknownLayout();
  return Object.freeze({ defaultRatio, ratios: Object.freeze([...ratios]) });
}

export function selectBundledTemplateLayout(layouts, ratio) {
  if (!layouts) {
    if (ratio !== undefined) throw unknownLayout();
    return null;
  }
  const selected = ratio === undefined ? layouts.defaultRatio : ratio;
  if (!layouts.ratios.includes(selected)) throw unknownLayout();
  const { suffix, size } = orientations[selected];
  return Object.freeze({ ratio: selected, size,
    entry: selected === layouts.defaultRatio ? 'film.html' : `film-${suffix}.html`,
    pages: selected === layouts.defaultRatio ? 'pages' : `pages-${suffix}`,
  });
}

export function installedTemplatePath(name, layout) {
  if (!layout) return name;
  if (name === layout.entry) return 'film.html';
  if (name === layout.pages) return name;
  if (/^film(?:-portrait|-landscape)?\.html$|^pages(?:-portrait|-landscape)?$/.test(name)) return null;
  return name;
}
