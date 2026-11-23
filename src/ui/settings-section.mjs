// The workbench's Settings page (`settings.section` list slot), and the same
// component reused in the plugin detail seat (`plugins.bundle.config`, keyed
// by our package) — one surface only, exactly like dsh-agy-link and
// dsh-codex-subscription do on this host.
//
// Same Host data as before (GET /api/no996-openfilm/environment,
// /api/no996-openfilm/models, POST /api/no996-openfilm/auth), laid out like
// the shipped settings pages: grouped cards, status badges, collapsible rows
// (all collapsed by default) and a modal for sign-in.
//
// Hard rules (each learned from a real outage on this host):
// - never touch the `styles` service: the host throws on undeclared-service
//   access and optional chaining does NOT save it. Styles go in as a plain
//   document <style> tag with an id guard — the only pattern both working
//   references use;
// - no react-dom / createPortal: the modal is a fixed overlay rendered in place;
// - exactly one slot registration (`settings.section`); the row icon comes from
//   the bundle `icon` field.
export function createNo996SettingsSection(React) {
  const h = React.createElement;
  const S = 'data-no996-settings';
  const ICON_LABEL = {
    fish: '鱼', cake: '蛋糕', egg: '蛋', milk: '牛奶', chili: '辣椒', potato: '土豆',
    chocolate: '巧克力', garlic: '蒜', scallion: '葱', mint: '薄荷', snow_lotus: '雪莲',
    sweet_potato: '红薯', bean: '豆子',
  };

  async function postAuth(payload) {
    const surface = `${window.location.protocol}//${window.location.host}`;
    const response = await fetch('/api/no996-openfilm/auth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-no996-surface': surface },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
    }
    return data;
  }

  function captchaHint(prompt, iconTarget) {
    const icon = ICON_LABEL[iconTarget] || '图标';
    if (prompt === 'click_largest') return `请点击最大的${icon}`;
    if (prompt === 'click_smallest') return `请点击最小的${icon}`;
    if (prompt === 'click_second_smallest') return `请点击第二小的${icon}`;
    if (prompt === 'click_icon') return `请点击图中的${icon}`;
    if (prompt === 'click_sequence') return '请按提示顺序点击';
    if (prompt === 'click_size_asc') return `请按从小到大点击${icon}`;
    if (prompt === 'click_size_desc') return `请按从大到小点击${icon}`;
    return '请完成人机验证';
  }

  function Card({ title, hint, action, children }) {
    return h('section', { [S]: 'card' },
      h('div', { [S]: 'card-head' },
        h('div', null,
          h('h3', { [S]: 'card-title' }, title),
          hint ? h('p', { [S]: 'card-hint' }, hint) : null,
        ),
        action || null,
      ),
      h('div', { [S]: 'card-body' }, children),
    );
  }

  function Badge({ tone = 'idle', children }) {
    return h('span', { [S]: 'badge', [`${S}-tone`]: tone }, children);
  }

  function Row({ label, detail, badge, children }) {
    return h('div', { [S]: 'row' },
      h('div', { [S]: 'row-main' },
        h('div', { [S]: 'row-label' }, label, badge || null),
        detail ? h('div', { [S]: 'row-detail' }, detail) : null,
      ),
      children ? h('div', { [S]: 'row-action' }, children) : null,
    );
  }

  function Btn({ variant = 'ghost', children, ...rest }) {
    return h('button', { [S]: 'btn', [`${S}-variant`]: variant, type: 'button', ...rest }, children);
  }

  function Chevron({ open }) {
    return h('svg', {
      [S]: 'chevron', [`${S}-open`]: open ? '1' : undefined,
      width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    }, h('path', { d: 'm9 18 6-6-6-6' }));
  }

  function Disclosure({ title, summary, children }) {
    const [open, setOpen] = React.useState(false);
    return h('div', { [S]: 'disclosure' },
      h('button', { [S]: 'disclosure-head', type: 'button', onClick: () => setOpen(v => !v), 'aria-expanded': open ? 'true' : 'false' },
        h('span', null, title),
        h('span', { [S]: 'disclosure-summary' }, summary || (open ? '收起' : '展开')),
        h(Chevron, { open }),
      ),
      open ? h('div', { [S]: 'disclosure-body' }, children) : null,
    );
  }

  function Modal({ title, onClose, children }) {
    return h('div', { [S]: 'modal-backdrop', onClick: event => { if (event.target === event.currentTarget) onClose(); } },
      h('div', { [S]: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { [S]: 'modal-head' },
          h('h2', { [S]: 'modal-title' }, title),
          h('button', { [S]: 'modal-x', type: 'button', onClick: onClose, 'aria-label': '关闭' }, '×'),
        ),
        h('div', { [S]: 'modal-body' }, children),
      ),
    );
  }

  function LoginDialog({ busy, message, onLogin, onClose }) {
    const [account, setAccount] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [cap, setCap] = React.useState(null);
    const [clicks, setClicks] = React.useState([]);
    const [localMsg, setLocalMsg] = React.useState('');

    const openCaptcha = React.useCallback(async () => {
      setLocalMsg('');
      setClicks([]);
      try {
        setCap(await postAuth({ action: 'captcha', type: 'click' }));
      } catch (fail) {
        setCap(null);
        setLocalMsg(String(fail?.message ?? fail));
      }
    }, []);

    const submit = React.useCallback(async (captchaId, captchaCode) => {
      const ok = await onLogin({ account, password, captchaId, captchaCode });
      if (ok) onClose();
      else { setClicks([]); if (captchaId) void openCaptcha(); }
    }, [account, password, onLogin, onClose, openCaptcha]);

    const clickCaptcha = React.useCallback(event => {
      if (!cap?.id || busy) return;
      const target = event.target?.closest?.('[data-captcha-id]');
      const id = target?.getAttribute?.('data-captcha-id');
      if (!id) return;
      const prompt = cap.prompt || '';
      const isSeq = prompt === 'click_sequence' || prompt === 'click_size_asc' || prompt === 'click_size_desc';
      if (!isSeq) { void submit(cap.id, id); return; }
      if (clicks.includes(id)) return;
      const next = [...clicks, id];
      setClicks(next);
      const needed = prompt === 'click_sequence' ? (cap.sequence?.length || 1) : 4;
      if (next.length >= needed) void submit(cap.id, next.join(','));
    }, [cap, clicks, busy, submit]);

    return h(Modal, { title: '登录不加班账号', onClose },
      h('p', { [S]: 'modal-hint' }, '登录后即可使用不加班 Auto、生图、配音与联网。账号信息仅用于本机会话。'),
      h('label', { [S]: 'field' },
        h('span', { [S]: 'field-label' }, '邮箱或手机号'),
        h('input', { [S]: 'input', type: 'text', value: account, placeholder: '请输入账号', autoComplete: 'username', onChange: e => setAccount(e.target.value) }),
      ),
      h('label', { [S]: 'field' },
        h('span', { [S]: 'field-label' }, '密码'),
        h('input', { [S]: 'input', type: 'password', value: password, placeholder: '至少 6 位', autoComplete: 'current-password', onChange: e => setPassword(e.target.value) }),
      ),
      h('div', { [S]: 'field-actions' },
        h(Btn, { onClick: () => void openCaptcha(), disabled: busy }, cap ? '刷新人机验证' : '获取人机验证'),
        cap?.id ? h('span', { [S]: 'captcha-hint' }, `${captchaHint(cap.prompt, cap.icon_target)}${clicks.length ? `（已点 ${clicks.length}）` : ''}`) : null,
      ),
      cap?.svg ? h('div', { [S]: 'captcha', onClick: clickCaptcha, dangerouslySetInnerHTML: { __html: cap.svg } }) : null,
      (message || localMsg) ? h('p', { [S]: 'notice', [`${S}-tone`]: 'error' }, message || localMsg) : null,
      h('div', { [S]: 'modal-actions' },
        h(Btn, { onClick: onClose }, '取消'),
        h(Btn, { variant: 'primary', onClick: () => void submit(cap?.id, ''), disabled: busy || !account.trim() || password.length < 6 || !cap?.id }, busy ? '登录中…' : '登录'),
      ),
    );
  }

  return function No996SettingsSection() {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState('');
    const [catalog, setCatalog] = React.useState(null);
    const [loginOpen, setLoginOpen] = React.useState(false);
    const [confirmRemove, setConfirmRemove] = React.useState(false);
    const [showImport, setShowImport] = React.useState(false);
    const [tarPath, setTarPath] = React.useState('');

    const load = React.useCallback(async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/no996-openfilm/environment', { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setData(await response.json());
      } catch (fail) {
        setError(String(fail?.message ?? fail));
        setData(null);
      } finally {
        setLoading(false);
      }
    }, []);

    const loadCatalog = React.useCallback(async () => {
      try {
        const res = await fetch('/api/no996-openfilm/models', { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (res.ok) setCatalog(await res.json());
      } catch { /* ignore */ }
    }, []);

    React.useEffect(() => {
      void load();
      void loadCatalog();
    }, [load, loadCatalog]);

    const postModels = React.useCallback(async payload => {
      setBusy(true);
      setMessage('');
      try {
        const res = await fetch('/api/no996-openfilm/models', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.ok === false) throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
        if (body?.catalog) setCatalog(body.catalog);
        else await loadCatalog();
      } catch (fail) {
        setMessage(String(fail?.message ?? fail));
      } finally {
        setBusy(false);
      }
    }, [loadCatalog]);

    const login = React.useCallback(async ({ account, password, captchaId, captchaCode }) => {
      setBusy(true);
      setMessage('');
      try {
        await postAuth({ action: 'login', account: String(account).trim(), password: String(password), captchaId, captchaCode });
        await load();
        return true;
      } catch (fail) {
        setMessage(String(fail?.message ?? fail));
        return false;
      } finally {
        setBusy(false);
      }
    }, [load]);

    const logout = React.useCallback(async () => {
      setBusy(true);
      setMessage('');
      try {
        await postAuth({ action: 'logout' });
        await load();
      } catch (fail) {
        setMessage(String(fail?.message ?? fail));
      } finally {
        setBusy(false);
      }
    }, [load]);

    const fmtMb = n => `${(Math.max(0, Number(n) || 0) / (1024 * 1024)).toFixed(1)} MB`;
    const auth = data?.workbenchAuth;
    const formal = Boolean(auth?.loggedIn && !auth?.guest && !auth?.dev);
    const preset = data?.preset;
    const skills = Array.isArray(data?.skills?.isolated) ? data.skills.isolated : [];
    const tools = Array.isArray(data?.tools) ? data.tools : [];
    const vision = catalog?.vision || null;

    return h('div', { [S]: '' },
      h(Card, {
        title: '账号与模型',
        hint: '不加班 Auto · 生图 · 配音 · 联网',
        action: auth ? (formal
          ? h(Btn, { onClick: () => void logout(), disabled: busy }, busy ? '退出中…' : '退出登录')
          : h(Btn, { variant: 'primary', onClick: () => setLoginOpen(true) }, '登录')) : null,
      },
        !auth ? h('p', { [S]: 'muted' }, loading ? '正在读取账号状态…' : `读取失败：${error || '未知错误'}`) : null,
        auth ? h(Row, {
          label: h('span', null, formal ? (auth.displayName || auth.account || '正式账号') : (auth.guest ? '游客模式' : '未登录')),
          badge: h(Badge, { tone: formal ? 'success' : 'idle' }, formal ? '已登录' : (auth.guest ? '游客' : '未登录')),
          detail: formal ? '不加班 Auto 与平台能力已就绪' : '模型列表显示「不加班 Auto (需先登录)」，登录后自动启用',
        }) : null,
      ),

      h(Card, { title: '模型与组件', hint: '按需安装，不后台静默下载' },
        vision ? h(Row, {
          label: '本地视觉组件',
          badge: h(Badge, { tone: vision.managed ? 'success' : 'idle' }, vision.managed ? '已安装' : '未安装'),
          detail: `压缩包约 ${fmtMb(vision.downloadBytes || 15449643)} / 解压 ${fmtMb(vision.declaredBytes)} · 运行时 ${vision.runtime?.ready ? '已就绪' : '缺失'}`,
        },
          h('div', { [S]: 'btn-group' },
            !vision.managed && !vision.installing ? h(Btn, { onClick: () => void postModels({ action: 'install', id: 'no996-models-vision' }), disabled: busy }, '安装') : null,
            vision.managed && !confirmRemove ? h(Btn, { onClick: () => setConfirmRemove(true), disabled: busy }, `卸载（释放 ${fmtMb(vision.reclaimableBytes)}）`) : null,
            vision.managed && confirmRemove ? h(Btn, { variant: 'danger', onClick: () => { setConfirmRemove(false); void postModels({ action: 'remove', id: 'no996-models-vision' }); }, disabled: busy }, '确认卸载') : null,
            confirmRemove ? h(Btn, { onClick: () => setConfirmRemove(false) }, '取消') : null,
          ),
        ) : h('p', { [S]: 'muted' }, '组件状态读取中…'),
        vision?.installing ? h('div', { [S]: 'progress' },
          h('div', { [S]: 'progress-fill', style: { width: `${Math.min(100, Math.round(((Number(vision.install?.seen) || 0) / (Number(vision.install?.total) || 1)) * 100))}%` } }),
        ) : null,
        h(Row, {
          label: '从本地压缩包导入',
          detail: '离线机器可用；导入会校验 SHA-256',
        },
          h(Btn, { onClick: () => setShowImport(v => !v) }, showImport ? '收起' : '选择压缩包'),
        ),
        showImport ? h('div', { [S]: 'import' },
          h('input', { [S]: 'input', type: 'text', value: tarPath, placeholder: '本地 .tgz 的绝对路径', onChange: e => setTarPath(e.target.value) }),
          h(Btn, { variant: 'primary', disabled: busy || !tarPath.trim(), onClick: () => void postModels({ action: 'import-local', id: 'no996-models-vision', path: tarPath.trim() }) }, '导入'),
        ) : null,
        message ? h('p', { [S]: 'notice' }, message) : null,
      ),

      h(Card, { title: '剪辑工作台', hint: '影片子进程实际能加载的东西' },
        h(Row, {
          label: '预设 Preset',
          badge: h(Badge, { tone: preset?.ok ? 'success' : 'error' }, preset?.ok ? '已加载' : '未加载'),
          detail: preset ? `${preset.id}${preset.ok ? '' : ` — ${preset.detail}`}` : '读取中…',
        }),
        h(Disclosure, {
          title: `隔离技能（${skills.length}）`,
          summary: '仅本插件 skills/，全局目录不进影片对话',
        }, skills.length ? skills.map(skill => h('div', { [S]: 'skill' },
          h('div', { [S]: 'skill-name' }, skill.name || skill.id || '未命名'),
          h('div', { [S]: 'skill-desc' }, skill.description || ''),
        )) : h('p', { [S]: 'muted' }, '没有隔离技能。')),
        h(Disclosure, {
          title: `影片工具（${tools.length}）`,
          summary: '读文件 / 读图 / 丢 PDF 走这里，不受技能隔离影响',
        }, tools.length ? tools.map(tool => h('div', { [S]: 'skill' },
          h('div', { [S]: 'skill-name' }, tool.name),
          h('div', { [S]: 'skill-desc' }, tool.description || ''),
        )) : h('p', { [S]: 'muted' }, '没有影片工具。')),
      ),

      loginOpen ? h(LoginDialog, { busy, message, onLogin: login, onClose: () => { setLoginOpen(false); setMessage(''); } }) : null,
    );
  };
}

/**
 * Inject the settings stylesheet as a plain document <style> tag (id-guarded).
 * Never go through `ctx.styles`: the host throws on undeclared-service access.
 */
export function injectSettingsCss() {
  if (typeof document === 'undefined') return () => {};
  const id = 'no996-settings-css';
  if (!document.getElementById(id)) {
    const st = document.createElement('style');
    st.id = id;
    st.textContent = NO996_SETTINGS_CSS;
    const host = document.head ?? document.documentElement;
    if (host) host.appendChild(st);
  }
  return () => {};
}

/** CSS text for the settings page. Token-only, scoped to [data-no996-settings]. */
export const NO996_SETTINGS_CSS = `
[data-no996-settings] { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6; }
[data-no996-settings] * { box-sizing: border-box; }
[data-no996-settings="card"] { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
[data-no996-settings="card-head"] { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
[data-no996-settings="card-title"] { font-size: 14px; font-weight: 650; margin: 0; }
[data-no996-settings="card-hint"] { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 2px 0 0; }
[data-no996-settings="card-body"] { display: flex; flex-direction: column; gap: 10px; }
[data-no996-settings="row"] { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
[data-no996-settings="row"]:first-child { border-top: none; }
[data-no996-settings="row-main"] { min-width: 0; flex: 1; }
[data-no996-settings="row-label"] { display: flex; align-items: center; gap: 8px; font-weight: 600; }
[data-no996-settings="row-detail"] { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; word-break: break-word; }
[data-no996-settings="row-action"] { flex-shrink: 0; }
[data-no996-settings="badge"] { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid var(--dsw-alias-border-l2); }
[data-no996-settings-tone="success"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
[data-no996-settings-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
[data-no996-settings-tone="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
[data-no996-settings="btn"] { padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; background: transparent; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
[data-no996-settings="btn"]:disabled { opacity: .5; cursor: default; }
[data-no996-settings-variant="primary"] { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border-color: var(--dsw-alias-brand-primary); }
[data-no996-settings-variant="danger"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
[data-no996-settings="btn-group"] { display: flex; flex-wrap: wrap; gap: 8px; }
[data-no996-settings="progress"] { height: 6px; background: var(--dsw-alias-bg-layer-2); border-radius: 999px; overflow: hidden; }
[data-no996-settings="progress-fill"] { height: 100%; background: var(--dsw-alias-brand-primary); transition: width .2s ease; }
[data-no996-settings="import"] { display: flex; gap: 8px; align-items: center; }
[data-no996-settings="input"] { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
[data-no996-settings="muted"] { color: var(--dsw-alias-label-secondary); margin: 4px 0; }
[data-no996-settings="notice"] { color: var(--dsw-alias-label-secondary); margin: 6px 0 0; font-size: 12px; }
[data-no996-settings="disclosure"] { border-top: 1px solid var(--dsw-alias-border-l1); }
[data-no996-settings="disclosure-head"] { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 0; background: none; border: none; color: inherit; font-size: 13px; font-weight: 600; cursor: pointer; text-align: left; }
[data-no996-settings="disclosure-summary"] { flex: 1; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
[data-no996-settings="chevron"] { flex: none; color: var(--dsw-alias-label-secondary); transition: transform .15s ease; }
[data-no996-settings-open="1"] { transform: rotate(90deg); }
[data-no996-settings="btn"]:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
[data-no996-settings-variant="primary"]:hover:not(:disabled) { filter: brightness(1.08); }
[data-no996-settings="btn"]:focus-visible,
[data-no996-settings="disclosure-head"]:focus-visible,
[data-no996-settings="modal-x"]:focus-visible,
[data-no996-settings="captcha"]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
[data-no996-settings="input"]:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
@media (prefers-reduced-motion: reduce) {
  [data-no996-settings="chevron"], [data-no996-settings="progress-fill"] { transition: none; }
}
[data-no996-settings="disclosure-body"] { padding: 0 0 8px; display: flex; flex-direction: column; gap: 8px; }
[data-no996-settings="skill"] { padding: 6px 8px; background: var(--dsw-alias-bg-layer-2); border-radius: 8px; }
[data-no996-settings="skill-name"] { font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; }
[data-no996-settings="skill-desc"] { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
[data-no996-settings="modal-backdrop"] { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; padding: 24px; }
[data-no996-settings="modal"] { width: min(440px, 100%); max-height: 90vh; overflow: auto; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.35); }
[data-no996-settings="modal-head"] { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
[data-no996-settings="modal-title"] { font-size: 15px; font-weight: 650; margin: 0; }
[data-no996-settings="modal-x"] { background: none; border: none; color: var(--dsw-alias-label-secondary); font-size: 20px; cursor: pointer; line-height: 1; }
[data-no996-settings="modal-body"] { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
[data-no996-settings="modal-hint"] { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; }
[data-no996-settings="field"] { display: flex; flex-direction: column; gap: 4px; }
[data-no996-settings="field-label"] { font-size: 12px; font-weight: 600; }
[data-no996-settings="field-actions"] { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
[data-no996-settings="captcha-hint"] { font-size: 12px; color: var(--dsw-alias-label-secondary); }
[data-no996-settings="captcha"] { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; cursor: pointer; background: var(--dsw-alias-bg-base); max-width: 360px; }
[data-no996-settings="modal-actions"] { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
`;
