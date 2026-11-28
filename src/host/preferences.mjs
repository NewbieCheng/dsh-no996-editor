/**
 * Per-install OpenFilm preferences (not account-scoped).
 * Stored under `$DSH_HOME/no996-openfilm/preferences.json`.
 * No tokens, no secrets — only onboarding and default template hints.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const TEMPLATE_ID = /^(?:[a-z0-9][a-z0-9-]{1,40}|custom)$/;

const PRODUCT = Object.freeze({
  'vibe-explainer': {
    productTitle: 'Vibe 科普剧场',
    productBlurb: '适合知识科普：双比例独立构图，标题、动态字幕、矢量图解与行动清单都能分别编辑。',
    featured: true,
  },
  'paper-texture': {
    productTitle: '口播讲堂',
    productBlurb: '适合课程讲解：竖屏上下讲授、横屏课件与人物并排，标题、课件和字幕都能编辑。',
  },
  sketchnote: {
    productTitle: '手绘笔记',
    productBlurb: '适合笔记风总结与轻教程：竖屏单页、横屏摊页，标题、步骤和便签都可编辑。',
  },
  'motion-styles': {
    productTitle: '动效风格样片',
    productBlurb: '适合片头与概念片：双比例扁平矢量、包豪斯动效，文字与形状都能编辑。',
  },
  custom: {
    productTitle: '自定义',
    productBlurb: '适合已有素材、先入库再定风格：空白开工，不预设片型。',
  },
});

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

const RATIOS = new Set(['16:9', '9:16', '1:1']);
const SECONDS = new Set([15, 30, 60]);
const LANGUAGES = new Set(['中文', 'English']);
const SEARCH_SOURCES = new Set(['dsh', 'no996']);
const ASR_CHOICE_RE = /^(?:unset|off|local:sensevoice-small|remote:[a-z0-9._:-]{1,64})$/;

function finitePoints(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function sanitizeMarket(raw) {
  let url = '';
  if (typeof raw?.url === 'string' && raw.url.length <= 500 && /^https:\/\/[^\s]+$/i.test(raw.url)) {
    try { const parsed = new URL(raw.url); if (!parsed.username && !parsed.password) url = parsed.href; } catch { /* invalid address is disabled */ }
  }
  const refreshedAt = typeof raw?.refreshedAt === 'string' ? raw.refreshedAt.slice(0, 40) : '';
  const seen = new Set();
  const items = Array.isArray(raw?.items) ? raw.items.slice(0, 100).flatMap(item => {
    let itemUrl = '';
    if (typeof item?.url === 'string' && item.url.length <= 1000 && /^https:\/\/[^\s]+$/i.test(item.url)) {
      try { const parsed = new URL(item.url); if (!parsed.username && !parsed.password) itemUrl = parsed.href; } catch { /* drop unsafe entry */ }
    }
    const id = typeof item?.id === 'string' && TEMPLATE_ID.test(item.id) && !seen.has(item.id) ? item.id : '';
    const sha256 = typeof item?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) ? item.sha256 : '';
    if (!id || !itemUrl || !sha256 || typeof item.title !== 'string' || !item.title.trim()) return [];
    seen.add(id);
    return [{ id, title: item.title.slice(0, 80), description: typeof item.description === 'string' ? item.description.slice(0, 400) : '', url: itemUrl, sha256 }];
  }) : [];
  return { url, refreshedAt, items };
}

function defaults() {
  return {
    onboardingCompleted: false,
    defaultTemplateId: '',
    lastProjectId: '',
    // 空白项目也记住画布与时长，下一次「自定义」不用重选。
    customRatio: '16:9',
    customSeconds: 30,
    customLanguage: '中文',
    // Workbench wallet snapshot (Host fills via account:balance). Not a secret.
    cachedAvailablePoints: null,
    cachedPointsBalance: null,
    cachedPeriodPointsBalance: null,
    cachedExpertPointsBalance: null,
    cachedPeriodExpiresAt: '',
    cachedBalanceAt: '',
    logRetentionDays: 14,
    asrChoice: 'unset',
    searchSource: 'dsh',
    visionUpgradeNoticeDismissed: '',
    templateMarket: { url: '', refreshedAt: '', items: [] },
    no996UpdateVersion: '',
  };
}

function sanitize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  return {
    onboardingCompleted: raw.onboardingCompleted === true,
    defaultTemplateId: typeof raw.defaultTemplateId === 'string' && TEMPLATE_ID.test(raw.defaultTemplateId)
      ? raw.defaultTemplateId
      : '',
    lastProjectId: typeof raw.lastProjectId === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(raw.lastProjectId)
      ? raw.lastProjectId
      : '',
    customRatio: RATIOS.has(raw.customRatio) ? raw.customRatio : '16:9',
    customSeconds: SECONDS.has(raw.customSeconds) ? raw.customSeconds : 30,
    customLanguage: LANGUAGES.has(raw.customLanguage) ? raw.customLanguage : '中文',
    cachedAvailablePoints: finitePoints(raw.cachedAvailablePoints),
    cachedPointsBalance: finitePoints(raw.cachedPointsBalance),
    cachedPeriodPointsBalance: finitePoints(raw.cachedPeriodPointsBalance),
    cachedExpertPointsBalance: finitePoints(raw.cachedExpertPointsBalance),
    cachedPeriodExpiresAt: typeof raw.cachedPeriodExpiresAt === 'string' ? raw.cachedPeriodExpiresAt.slice(0, 64) : '',
    cachedBalanceAt: typeof raw.cachedBalanceAt === 'string' ? raw.cachedBalanceAt.slice(0, 64) : '',
    logRetentionDays: Number.isFinite(Number(raw.logRetentionDays))
      ? Math.max(1, Math.min(90, Math.round(Number(raw.logRetentionDays))))
      : 14,
    asrChoice: typeof raw.asrChoice === 'string' && ASR_CHOICE_RE.test(raw.asrChoice) ? raw.asrChoice : 'unset',
    searchSource: SEARCH_SOURCES.has(raw.searchSource) ? raw.searchSource : 'dsh',
    visionUpgradeNoticeDismissed: typeof raw.visionUpgradeNoticeDismissed === 'string'
      ? raw.visionUpgradeNoticeDismissed.slice(0, 32)
      : '',
    templateMarket: sanitizeMarket(raw.templateMarket),
    no996UpdateVersion: typeof raw.no996UpdateVersion === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(raw.no996UpdateVersion) ? raw.no996UpdateVersion : '',
  };
}

/** Public wallet view derived from prefs cache (or a live workbench payload). */
export function balanceFromPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') {
    return {
      available_points: null,
      points_balance: null,
      period_points_balance: null,
      expert_points_balance: null,
      period_expires_at: null,
      cached_at: '',
    };
  }
  return {
    available_points: finitePoints(prefs.cachedAvailablePoints),
    points_balance: finitePoints(prefs.cachedPointsBalance),
    period_points_balance: finitePoints(prefs.cachedPeriodPointsBalance),
    expert_points_balance: finitePoints(prefs.cachedExpertPointsBalance),
    period_expires_at: prefs.cachedPeriodExpiresAt || null,
    cached_at: prefs.cachedBalanceAt || '',
  };
}

export function balanceCachePatch(live) {
  const permanent = finitePoints(live?.points_balance) ?? 0;
  const period = finitePoints(live?.period_points_balance) ?? 0;
  const expert = finitePoints(live?.expert_points_balance) ?? 0;
  const available = finitePoints(live?.available_points);
  return {
    cachedPointsBalance: permanent,
    cachedPeriodPointsBalance: period,
    cachedExpertPointsBalance: expert,
    cachedAvailablePoints: available == null ? permanent + period : available,
    cachedPeriodExpiresAt: typeof live?.period_expires_at === 'string' ? live.period_expires_at.slice(0, 64) : '',
    cachedBalanceAt: new Date().toISOString(),
  };
}

export function clearBalanceCachePatch() {
  return {
    cachedAvailablePoints: null,
    cachedPointsBalance: null,
    cachedPeriodPointsBalance: null,
    cachedExpertPointsBalance: null,
    cachedPeriodExpiresAt: '',
    cachedBalanceAt: '',
  };
}

export function productMeta(templateId) {
  return PRODUCT[templateId] || null;
}

export function onboardingCopy(templateId, presets = {}) {
  const meta = productMeta(templateId) || productMeta('custom');
  const name = meta.productTitle;
  if (templateId === 'custom') {
    return {
      title: 'AI 剪辑员工 · 下一步',
      steps: [
        '这是空白项目。',
        '先说主题和时长，或把素材拖进对话。',
        '想套口播/科普剧场/手绘骨架时再说一声。',
      ],
      ratio: presets?.ratio,
      seconds: presets?.seconds,
      language: presets?.language,
      uploadHint: '素材丢到对话框即可，我会放进项目素材库。不用去点左侧素材库按钮。',
    };
  }
  return {
    title: 'AI 剪辑员工 · 下一步',
    steps: [
      `已按「${name}」建好项目。`,
      '用一句话说主题和时长。',
      '把视频/音频/图片拖进对话，我来入库再帮你剪。',
    ],
    uploadHint: '素材丢到对话框即可，我会放进项目素材库。不用去点左侧素材库按钮。',
  };
}

export function createPreferencesStore({ home = dshHome() } = {}) {
  const file = join(home, 'no996-openfilm', 'preferences.json');
  let cache = null;
  let writeChain = Promise.resolve();

  async function read() {
    if (cache) return { ...cache };
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      cache = sanitize(raw);
    } catch {
      cache = defaults();
    }
    return { ...cache };
  }

  async function write(next) {
    const value = sanitize(next);
    cache = value;
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    }).catch(() => {});
    await writeChain;
    return { ...value };
  }

  return {
    file,
    get: read,
    async set(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw Object.assign(new Error('无效偏好'), { code: 'PREFS_INPUT', status: 400 });
      }
      const current = await read();
      const next = { ...current };
      if ('onboardingCompleted' in patch) next.onboardingCompleted = patch.onboardingCompleted === true;
      if ('defaultTemplateId' in patch) {
        const id = typeof patch.defaultTemplateId === 'string' ? patch.defaultTemplateId : '';
        if (id && !TEMPLATE_ID.test(id)) throw Object.assign(new Error('无效模板'), { code: 'PREFS_INPUT', status: 400 });
        next.defaultTemplateId = id;
      }
      if ('customRatio' in patch) {
        if (!RATIOS.has(patch.customRatio)) throw Object.assign(new Error('无效画布比例'), { code: 'PREFS_INPUT', status: 400 });
        next.customRatio = patch.customRatio;
      }
      if ('customLanguage' in patch) {
        if (!LANGUAGES.has(patch.customLanguage)) throw Object.assign(new Error('无效语言'), { code: 'PREFS_INPUT', status: 400 });
        next.customLanguage = patch.customLanguage;
      }
      if ('customSeconds' in patch) {
        const seconds = Number(patch.customSeconds);
        if (!SECONDS.has(seconds)) throw Object.assign(new Error('无效时长'), { code: 'PREFS_INPUT', status: 400 });
        next.customSeconds = seconds;
      }
      if ('lastProjectId' in patch) {
        const id = typeof patch.lastProjectId === 'string' ? patch.lastProjectId : '';
        if (id && !/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw Object.assign(new Error('无效项目'), { code: 'PREFS_INPUT', status: 400 });
        next.lastProjectId = id;
      }
      for (const key of [
        'cachedAvailablePoints',
        'cachedPointsBalance',
        'cachedPeriodPointsBalance',
        'cachedExpertPointsBalance',
      ]) {
        if (key in patch) {
          if (patch[key] == null) next[key] = null;
          else {
            const n = finitePoints(patch[key]);
            if (n == null) throw Object.assign(new Error('无效积分缓存'), { code: 'PREFS_INPUT', status: 400 });
            next[key] = n;
          }
        }
      }
      if ('cachedPeriodExpiresAt' in patch) {
        next.cachedPeriodExpiresAt = typeof patch.cachedPeriodExpiresAt === 'string'
          ? patch.cachedPeriodExpiresAt.slice(0, 64)
          : '';
      }
      if ('cachedBalanceAt' in patch) {
        next.cachedBalanceAt = typeof patch.cachedBalanceAt === 'string'
          ? patch.cachedBalanceAt.slice(0, 64)
          : '';
      }
      if ('logRetentionDays' in patch) {
        const days = Number(patch.logRetentionDays);
        if (!Number.isFinite(days) || days < 1 || days > 90) {
          throw Object.assign(new Error('无效日志保留天数'), { code: 'PREFS_INPUT', status: 400 });
        }
        next.logRetentionDays = Math.round(days);
      }
      if ('asrChoice' in patch) {
        const value = typeof patch.asrChoice === 'string' ? patch.asrChoice.trim() : '';
        if (!ASR_CHOICE_RE.test(value)) {
          throw Object.assign(new Error('无效转写引擎选择'), { code: 'PREFS_INPUT', status: 400 });
        }
        next.asrChoice = value;
      }
      if ('searchSource' in patch) {
        if (!SEARCH_SOURCES.has(patch.searchSource)) {
          throw Object.assign(new Error('无效搜索来源选择'), { code: 'PREFS_INPUT', status: 400 });
        }
        next.searchSource = patch.searchSource;
      }
      if ('visionUpgradeNoticeDismissed' in patch) {
        next.visionUpgradeNoticeDismissed = typeof patch.visionUpgradeNoticeDismissed === 'string'
          ? patch.visionUpgradeNoticeDismissed.slice(0, 32)
          : '';
      }
      if ('templateMarket' in patch) next.templateMarket = sanitizeMarket(patch.templateMarket);
      if ('no996UpdateVersion' in patch) next.no996UpdateVersion = typeof patch.no996UpdateVersion === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(patch.no996UpdateVersion) ? patch.no996UpdateVersion : '';
      return write(next);
    },
    productCatalog() {
      return Object.entries(PRODUCT).map(([id, meta]) => ({ id, ...meta }));
    },
  };
}
