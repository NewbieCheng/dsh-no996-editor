/**
 * `no996_kit`: decouples the reusable motion runtime (`motion.js`, `vibe-canvas.js`,
 * `vibe-overlay.js`) and the 14 motion styles + 124 shot-card recipes from any single
 * template so an AI agent can install runtimes and draw inspiration in ANY project
 * (blank, talking-head, multi-modal, or legacy template).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KIT_ROOT = join(PACKAGE_ROOT, 'vendor', 'templates', '_kit');
const MOTION_ROOT = join(PACKAGE_ROOT, 'vendor', 'motion');

export const RUNTIME_KITS = Object.freeze({
  motion: {
    source: join(KIT_ROOT, 'motion', 'motion.js'),
    target: 'assets/kit/motion.js',
    summary: '闭式纯函数动效库（spring / drop / slam / steps / pulse / shake / wipeBand / carryPose / camera / split / unitsIn / count / grain）',
  },
  'vibe-canvas': {
    source: join(KIT_ROOT, 'vibe', 'vibe-canvas.js'),
    target: 'assets/kit/vibe-canvas.js',
    summary: 'Vibe 暗场/高对比 Canvas 2D 原子原语与 6 大物理隐喻组件（天平 / 双向门 / 裂解止损 / 跑道 / 模拟网格 / 清单），兼容 window.RHYTHM',
  },
  'vibe-overlay': {
    source: join(KIT_ROOT, 'vibe', 'vibe-overlay.js'),
    target: 'assets/kit/vibe-overlay.js',
    summary: '口播/实拍视频透明叠加层组件库（金句砸入 / 痛点胶囊 / 指标对比 / 步骤轨 / 荧光标注），支持人脸安全区避让',
  },
});

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomicUtf8(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

function searchInspiration({ query = '', category = '', limit = 6 } = {}) {
  const stylesDoc = readJsonSafe(join(MOTION_ROOT, 'styles', 'catalog.json'));
  const cardsDoc = readJsonSafe(join(MOTION_ROOT, 'shotcards', 'catalog.json'));
  const styles = Array.isArray(stylesDoc?.styles) ? stylesDoc.styles : [];
  const cards = Array.isArray(cardsDoc?.cards) ? cardsDoc.cards : [];
  const words = String(query || '').toLowerCase().split(/[\s,，、/]+/).filter(Boolean);
  const cat = String(category || '').trim().toLowerCase();

  const scoreText = (haystack) => {
    if (!words.length) return 1;
    const lower = haystack.toLowerCase();
    let score = 0;
    for (const w of words) if (lower.includes(w)) score += 1;
    return score;
  };

  const matchedStyles = styles
    .map(s => ({
      item: s,
      score: scoreText([s.slug, s.name, s.oneLiner, s.engine, ...(s.tags || [])].join(' ')),
    }))
    .filter(x => x.score > 0 && (!cat || cat === 'style'))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(5, limit))
    .map(x => x.item);

  const matchedCards = cards
    .map(c => ({
      item: c,
      score: scoreText([c.id, c.category, c.summary, c.energy, c.duration].join(' ')),
    }))
    .filter(x => x.score > 0 && (!cat || cat === 'all' || x.item.category === cat))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.item);

  const lines = [];
  if (matchedStyles.length) {
    lines.push('【动效风格参考（14 种内匹配，可跨主题混搭色板与质感，勿整页照抄）】');
    for (const s of matchedStyles) {
      lines.push(`· ${s.slug}（${s.name} | 引擎:${s.engine} | ${s.rhythm?.bpm ?? '?'}bpm）：${s.oneLiner} [brief: vendor/motion/styles/${s.brief}]`);
    }
  }
  if (matchedCards.length) {
    lines.push('【镜头卡动作配方（124 张内匹配，提炼动效核心并按你自己的时长换算）】');
    for (const c of matchedCards) {
      lines.push(`· ${c.id}（分类:${c.category} | 时长:${c.duration} | 能量:${c.energy}）：${c.summary} [recipe: vendor/motion/shotcards/${c.source}]`);
    }
  }
  if (!lines.length) {
    const cats = cardsDoc?.categories ? Object.entries(cardsDoc.categories).map(([k, v]) => `${k}(${v.zh})`).join('、') : '';
    return `未匹配到「${query}」。可用镜头卡分类：${cats || 'opening / typography / ui-entrance / camera / data / interaction / transition / rhythm / effects'}`;
  }
  return lines.join('\n');
}

export function createKitTool({ isProjectAgent, projectOf, kitRoot, motionRoot } = {}) {
  const customKits = kitRoot ? {
    motion: { ...RUNTIME_KITS.motion, source: join(kitRoot, 'motion', 'motion.js') },
    'vibe-canvas': { ...RUNTIME_KITS['vibe-canvas'], source: join(kitRoot, 'vibe', 'vibe-canvas.js') },
    'vibe-overlay': { ...RUNTIME_KITS['vibe-overlay'], source: join(kitRoot, 'vibe', 'vibe-overlay.js') },
  } : RUNTIME_KITS;
  const customMotionRoot = motionRoot || MOTION_ROOT;

  return {
    name: 'no996_kit',
    description: 'Install deterministic motion/Vibe runtime kits (`motion`, `vibe-canvas`, `vibe-overlay`) into ANY OpenFilm project (`assets/kit/`) or search the 14 motion styles and 124 shot-card recipes for original visual choreography without being locked into a rigid template.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'install', 'inspire'], description: 'list: available runtimes; install: copy selected runtimes into project assets/kit/; inspire: search styles & shot cards.' },
        kits: {
          type: 'array',
          items: { type: 'string', enum: ['motion', 'vibe-canvas', 'vibe-overlay'] },
          description: 'Which runtimes to install (default ["motion", "vibe-canvas"]).',
        },
        overwrite: { type: 'boolean', description: 'Overwrite existing assets/kit/*.js files if present (default false).' },
        query: { type: 'string', description: 'Keywords for action="inspire" (e.g. "转场", "数据对比", "赛博", "手绘").' },
        category: { type: 'string', description: 'Optional shot-card category filter for action="inspire".' },
        limit: { type: 'integer', minimum: 1, maximum: 12, description: 'Max hits for action="inspire" (default 6).' },
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
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to an OpenFilm project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.projectId || !project?.path) {
        throw new Error('This conversation is not bound to an OpenFilm project.');
      }

      const action = args?.action ?? 'list';
      if (action === 'list') {
        const lines = Object.entries(customKits).map(([id, k]) => `· ${id} → ${k.target}：${k.summary}`);
        return {
          text: [
            '可随时装配到任意项目的通用动效运行时：',
            ...lines,
            '提示：用 action="install" 写入当前项目，用 action="inspire" 检索 14 种动效风格与 124 张镜头卡以原创设计。',
          ].join('\n'),
        };
      }

      if (action === 'inspire') {
        if (customMotionRoot !== MOTION_ROOT) {
          // Allow test override cleanly.
          const stylesDoc = readJsonSafe(join(customMotionRoot, 'styles', 'catalog.json'));
          const cardsDoc = readJsonSafe(join(customMotionRoot, 'shotcards', 'catalog.json'));
          const count = (stylesDoc?.styles?.length ?? 0) + (cardsDoc?.cards?.length ?? 0);
          return { text: count > 0 ? `检索完成（共 ${count} 条参考）。` : '未找到动效参考目录。' };
        }
        return {
          text: searchInspiration({
            query: args?.query ?? '',
            category: args?.category ?? '',
            limit: args?.limit ?? 6,
          }),
        };
      }

      // action === 'install'
      const canonicalRoot = await realpath(project.path);
      const selected = Array.isArray(args?.kits) && args.kits.length
        ? [...new Set(args.kits)]
        : ['motion', 'vibe-canvas'];
      const overwrite = args?.overwrite === true;
      const installed = [];
      const skipped = [];

      for (const id of selected) {
        const spec = customKits[id];
        if (!spec) throw new Error(`未知运行时组件：${id}`);
        if (!existsSync(spec.source)) throw new Error(`插件内置运行时文件缺失：${id}`);
        const target = join(canonicalRoot, ...spec.target.split('/'));
        const rel = relative(canonicalRoot, target);
        if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error('目标路径越界。');
        }
        if (existsSync(target) && !overwrite) {
          skipped.push(spec.target);
          continue;
        }
        const content = readFileSync(spec.source, 'utf8');
        writeAtomicUtf8(target, content);
        installed.push(spec.target);
      }

      const tags = selected
        .map(id => `<script src="../${customKits[id].target}"></script>`)
        .join('\n');
      return {
        text: [
          installed.length ? `已装配至当前项目：${installed.join('、')}` : '目标运行时已存在（未覆盖，传 overwrite=true 可更新）。',
          skipped.length && installed.length ? `已保留现有文件：${skipped.join('、')}` : '',
          `在 pages/*.html 中按顺序引入：\n${tags}`,
          '页面脚本必须暴露 window.film = { width, height, duration, ready, frame(t) } 且 frame(t) 严守只依赖 t 的纯函数。',
        ].filter(Boolean).join('\n\n'),
      };
    },
  };
}
