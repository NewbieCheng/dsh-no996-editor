/**
 * `no996_fonts`: inspect OS-installed fonts, project-declared `@font-face` fonts,
 * and built-in display fonts (`Smiley Sans`, `ZCOOL KuaiLe`) via Studio's local
 * font scanners (`GET /api/fonts` and `GET /api/projects/:id/fonts`). Zero network.
 */

const BUILTIN_DISPLAY_FONTS = Object.freeze([
  { family: 'Smiley Sans', alias: '得意黑', locale: 'zh-CN', source: '内置文本组件随包 OFL 字体 (library/text/text/files/fonts/SmileySans.woff2)' },
  { family: 'ZCOOL KuaiLe', alias: '站酷快乐体', locale: 'zh-CN', source: '内置文本组件随包 OFL 字体 (library/text/text/files/fonts/ZCOOLKuaiLe.ttf)' },
]);

const LOCALES = ['all', 'zh-CN', 'latin', 'ja-JP', 'ko-KR'];
const SCOPES = ['all', 'system', 'project', 'builtin'];

const clean = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : '');

function matchFont(font, query) {
  if (!query) return true;
  const terms = query.toLowerCase().split(/[\s,，/]+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [
    font.family,
    font.alias,
    font.role,
    font.locale,
    ...(Array.isArray(font.aliases) ? font.aliases : []),
  ].filter(Boolean).join(' ').toLowerCase();
  return terms.every(term => hay.includes(term));
}

function formatFontLine(font) {
  const aliases = Array.isArray(font.aliases) && font.aliases.length ? ` (${font.aliases.slice(0, 3).join(' / ')})` : '';
  const weights = Array.isArray(font.weights) && font.weights.length ? `weights:[${font.weights.join(',')}]` : '';
  const locale = font.locale ? `[${font.locale}]` : '';
  const tail = [locale, weights].filter(Boolean).join(' ');
  return `· ${font.family}${aliases}${tail ? `  ${tail}` : ''}`;
}

export function buildFontStack(families = []) {
  const quoted = families
    .filter(f => typeof f === 'string' && f.trim())
    .map(f => (/[\s]/.test(f.trim()) && !/^['"]/.test(f.trim()) ? `'${f.trim()}'` : f.trim()));
  const fallback = ["'PingFang SC'", "'Microsoft YaHei'", "'Noto Sans SC'", 'sans-serif'];
  return [...new Set([...quoted, ...fallback])].join(', ');
}

export function createFontsTool({ isProjectAgent, projectOf, http }) {
  return {
    name: 'no996_fonts',
    description: 'List real fonts available on this machine and in this project (OS installed fonts with Chinese aliases, project `@font-face` fonts, and bundled OFL display fonts `Smiley Sans` / `ZCOOL KuaiLe`). Call this before choosing `--font` or Canvas typography so rendered frames never silently fall back to broken fonts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional keyword or alias filter (e.g. "黑", "楷", "霞鹜", "Smiley", "mono", "serif").' },
        locale: { type: 'string', enum: LOCALES, description: 'Filter script locale (default all).' },
        scope: { type: 'string', enum: SCOPES, description: 'Which font sources to return (default all).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max system fonts to show (default 20).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to a No996 Studio project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.projectId) throw new Error('This conversation is not bound to a No996 Studio project.');
      const query = clean(args?.query);
      const locale = LOCALES.includes(args?.locale) ? args.locale : 'all';
      const scope = SCOPES.includes(args?.scope) ? args.scope : 'all';
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(50, Math.max(1, args.limit)) : 20;

      const client = http();
      const [sysRes, projRes] = await Promise.all([
        scope === 'project' || scope === 'builtin' ? Promise.resolve(null) : client.get('/api/fonts').catch(() => null),
        scope === 'system' || scope === 'builtin' ? Promise.resolve(null) : client.get(`/api/projects/${encodeURIComponent(project.projectId)}/fonts`).catch(() => null),
      ]);

      const projectFonts = (Array.isArray(projRes?.fonts) ? projRes.fonts : [])
        .filter(f => f && typeof f.family === 'string' && matchFont(f, query));
      const builtinFonts = BUILTIN_DISPLAY_FONTS
        .filter(f => (locale === 'all' || f.locale === locale) && matchFont(f, query));
      const systemAll = Array.isArray(sysRes?.fonts) ? sysRes.fonts : [];
      const systemFonts = systemAll
        .filter(f => f && typeof f.family === 'string')
        .filter(f => locale === 'all' || f.locale === locale)
        .filter(f => matchFont(f, query));

      const sections = [];
      if (scope === 'all' || scope === 'builtin') {
        sections.push(`【随包内置可商用展示字体】\n${builtinFonts.length ? builtinFonts.map(f => `· ${f.family} (${f.alias}) — ${f.source}`).join('\n') : '（未匹配内置展示字体）'}`);
      }
      if (scope === 'all' || scope === 'project') {
        const projLines = projectFonts.map(f => `· ${f.family}${Array.isArray(f.weights) ? ` weights:[${f.weights.join(',')}]` : ''}${f.missing ? ' [字体文件缺失]' : ''}`);
        sections.push(`【本项目已声明字体 (@font-face)】\n${projLines.length ? projLines.join('\n') : '（当前项目暂无自定义字体声明）'}`);
      }
      if (scope === 'all' || scope === 'system') {
        const shown = systemFonts.slice(0, limit);
        const sysLines = shown.map(formatFontLine);
        sections.push(`【本机操作系统已装字体${locale !== 'all' ? ` · ${locale}` : ''}（命中 ${systemFonts.length} 个，展示 ${shown.length} 个）】\n${sysLines.length ? sysLines.join('\n') : (sysRes ? '（未匹配系统字体）' : '（Studio 未运行或暂未返回系统字体列表）')}`);
      }

      const preferred = [
        ...projectFonts.filter(f => !f.missing).map(f => f.family),
        ...builtinFonts.map(f => f.family),
        ...systemFonts.slice(0, 2).map(f => f.family),
      ].slice(0, 3);
      const stack = buildFontStack(preferred);
      if (query && !projectFonts.length && !builtinFonts.length && !systemFonts.length) {
        sections.push(`⚠ 本机未找到匹配「${query}」的字体：严禁直接硬写未知字体名导致画面渲染回退；请改查空关键词或优先使用内置 Smiley Sans / ZCOOL KuaiLe。`);
      } else {
        sections.push(`【推荐安全 CSS --font / fontFamily 回退栈】\n\`${stack}\``);
      }

      return { text: sections.join('\n\n') };
    },
  };
}
