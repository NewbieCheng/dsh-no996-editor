// Environment section for the bundle detail page (`plugins.detail.section`).
//
// Answers "what can the film agent load?" without touching a conversation:
// preset activation, the ACP child's skill gate (the 3 isolated skills),
// the 11 film tools the child calls over MCP, and the instruction chain of a
// named project. Read-only: one GET to /api/no996-openfilm/environment.
//
// Styling is inline + theme tokens only (no stylesheet, no color literals),
// so light/dark both hold and no other UI can be mis-hit.
export function createEnvSection(React) {
  const h = React.createElement;
  const box = {
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 12,
    padding: '16px 18px',
    margin: '12px 0',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    lineHeight: 1.65,
  };
  const title = { fontSize: 14, fontWeight: 650, margin: '0 0 8px' };
  const sub = { fontSize: 13, fontWeight: 600, margin: '14px 0 4px', color: 'var(--dsw-alias-label-primary)' };
  const dim = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 };
  const table = { width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 };
  const th = { textAlign: 'left', padding: '4px 8px 4px 0', color: 'var(--dsw-alias-label-secondary)', fontWeight: 600, verticalAlign: 'top', whiteSpace: 'nowrap' };
  const td = { padding: '4px 0 4px 8px', verticalAlign: 'top' };
  const code = { fontFamily: 'ui-monospace, monospace', fontSize: 12 };
  const input = {
    width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '6px 10px',
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, fontSize: 12,
  };
  const button = {
    marginTop: 8, padding: '6px 14px', cursor: 'pointer',
    // Ghost style (repo convention: transparent + border + label color) so the
    // text stays readable in light and dark themes even if a brand token is
    // missing. Never pair a filled token background with a hardcoded text color.
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l1)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 8, fontSize: 12, fontWeight: 600,
  };
  const row = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 };
  const link = {
    background: 'none', border: 'none', cursor: 'pointer', padding: '6px 4px',
    color: 'var(--dsw-alias-label-secondary)', fontSize: 12, textDecoration: 'underline', textUnderlineOffset: 3,
  };
  const STORAGE_KEY = 'no996-openfilm.env.projectId';
  const readSaved = () => {
    try { return window.localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  };
  const ICON_LABEL = {
    fish: '鱼', cake: '蛋糕', egg: '蛋', milk: '牛奶', chili: '辣椒', potato: '土豆',
    chocolate: '巧克力', garlic: '蒜', scallion: '葱', mint: '薄荷', snow_lotus: '雪莲',
    sweet_potato: '红薯', bean: '豆子',
  };
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

  return function EnvSection() {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState('');
    const [projectId, setProjectId] = React.useState('');
    const [savedId, setSavedId] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [authOpen, setAuthOpen] = React.useState(false);
    const [authAccount, setAuthAccount] = React.useState('');
    const [authPassword, setAuthPassword] = React.useState('');
    const [authBusy, setAuthBusy] = React.useState(false);
    const [authMsg, setAuthMsg] = React.useState('');
    const [captcha, setCaptcha] = React.useState(null);
    const [clicks, setClicks] = React.useState([]);
    const load = React.useCallback(async project => {
      setLoading(true);
      setError('');
      try {
        const query = project ? `?projectId=${encodeURIComponent(project)}` : '';
        const response = await fetch(`/api/no996-openfilm/environment${query}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setData(await response.json());
      } catch (fail) {
        setError(String(fail?.message ?? fail));
        setData(null);
      } finally {
        setLoading(false);
      }
    }, []);
    const fetchCaptcha = React.useCallback(async () => {
      setAuthMsg('');
      setClicks([]);
      try {
        const cap = await postAuth({ action: 'captcha', type: 'click' });
        setCaptcha(cap);
      } catch (fail) {
        setCaptcha(null);
        setAuthMsg(String(fail?.message ?? fail));
      }
    }, []);
    const submitLogin = React.useCallback(async (captchaId, captchaCode) => {
      setAuthBusy(true);
      setAuthMsg('');
      try {
        await postAuth({
          action: 'login',
          account: authAccount.trim(),
          password: authPassword,
          captchaId,
          captchaCode,
        });
        setAuthOpen(false);
        setAuthPassword('');
        setCaptcha(null);
        setClicks([]);
        await load(savedId || projectId.trim());
      } catch (fail) {
        setAuthMsg(String(fail?.message ?? fail));
        setClicks([]);
        if (captchaId) void fetchCaptcha();
      } finally {
        setAuthBusy(false);
      }
    }, [authAccount, authPassword, fetchCaptcha, load, projectId, savedId]);
    const handleLogout = React.useCallback(async () => {
      setAuthBusy(true);
      setAuthMsg('');
      try {
        await postAuth({ action: 'logout' });
        await load(savedId || projectId.trim());
      } catch (fail) {
        setAuthMsg(String(fail?.message ?? fail));
      } finally {
        setAuthBusy(false);
      }
    }, [load, projectId, savedId]);
    const handleCaptchaClick = React.useCallback(event => {
      if (!captcha?.id || authBusy) return;
      const target = event.target?.closest?.('[data-captcha-id]');
      const id = target?.getAttribute?.('data-captcha-id');
      if (!id) return;
      const prompt = captcha.prompt || '';
      const isSeq = prompt === 'click_sequence' || prompt === 'click_size_asc' || prompt === 'click_size_desc';
      if (!isSeq) {
        void submitLogin(captcha.id, id);
        return;
      }
      if (clicks.includes(id)) return;
      const needed = prompt === 'click_sequence' ? (captcha.sequence?.length || 1) : 4;
      const next = [...clicks, id];
      setClicks(next);
      if (next.length >= needed) {
        void submitLogin(captcha.id, next.join(','));
      }
    }, [authBusy, captcha, clicks, submitLogin]);
    // A saved project is reused on open (load it at once); clearing the saved
    // value turns that back off. Nothing is sent anywhere: localStorage only.
    React.useEffect(() => {
      const saved = readSaved();
      if (saved) {
        setProjectId(saved);
        setSavedId(saved);
        load(saved);
      } else {
        load('');
      }
    }, [load]);
    const save = React.useCallback(() => {
      const value = projectId.trim();
      if (!value) return;
      try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* private mode: query still works */ }
      setSavedId(value);
      load(value);
    }, [projectId, load]);
    const clearSaved = React.useCallback(() => {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* already gone */ }
      setSavedId('');
    }, []);

    const preset = data?.preset;
    const wbAuth = data?.workbenchAuth;
    const isFormalUser = Boolean(wbAuth?.loggedIn && !wbAuth?.guest && !wbAuth?.dev);
    const skills = Array.isArray(data?.skills?.isolated) ? data.skills.isolated : [];
    const tools = Array.isArray(data?.tools) ? data.tools : [];
    const chain = data?.project && !data.project.error ? data.project : null;
    const chainError = data?.project?.error;

    return h('div', { 'data-no996-env': '', style: box },
      h('p', { style: title }, '剪辑环境 · Environment'),
      h('p', { style: dim }, '影片子进程实际能加载的东西（只读）。全局 skill 目录不进影片对话，读文件/读图/丢 PDF 走下面的影片工具，不受影响。'),
      loading ? h('p', { style: dim }, '正在读取… Loading…') : null,
      error ? h('p', { style: dim }, `读取失败 Load failed：${error}`) : null,
      wbAuth ? h('div', null,
        h('p', { style: sub }, '不加班账号与模型 · no996/auto'),
        h('p', { style: dim }, isFormalUser
          ? `已登录：${wbAuth.displayName || wbAuth.account || '正式账号'}（不加班 Auto 与生图/配音/联网已就绪）`
          : wbAuth.guest
            ? '当前为游客模式（模型列表显示「不加班 Auto (需先登录)」，仅登录正式账号后可调用）'
            : '未登录（模型列表显示「不加班 Auto (需先登录)」，登录后自动启用并刷新）'),
        h('div', { style: row },
          isFormalUser
            ? h('button', { style: { ...button, marginTop: 0 }, disabled: authBusy, onClick: handleLogout }, authBusy ? '退出中…' : '退出不加班账号')
            : h('button', {
              style: { ...button, marginTop: 0 },
              disabled: authBusy,
              onClick: () => {
                const next = !authOpen;
                setAuthOpen(next);
                if (next && !captcha) void fetchCaptcha();
              },
            }, authOpen ? '收起登录' : '登录不加班账号'),
        ),
        !isFormalUser && authOpen ? h('div', { style: { marginTop: 8 } },
          h('input', {
            style: input, type: 'text', value: authAccount, placeholder: '邮箱或手机号',
            onChange: event => setAuthAccount(event.target.value),
          }),
          h('input', {
            style: input, type: 'password', value: authPassword, placeholder: '密码（至少 6 位）',
            onChange: event => setAuthPassword(event.target.value),
          }),
          h('div', { style: row },
            h('button', {
              style: { ...button, marginTop: 0 },
              disabled: authBusy || !authAccount.trim() || authPassword.length < 6,
              onClick: () => void fetchCaptcha(),
            }, captcha ? '刷新人机验证' : '获取人机验证'),
            captcha?.id ? h('span', { style: dim }, `${captchaHint(captcha.prompt, captcha.icon_target)}${clicks.length ? `（已点 ${clicks.length}）` : ''}`) : null,
          ),
          captcha?.svg ? h('div', {
            style: {
              marginTop: 8, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
              overflow: 'hidden', cursor: 'pointer', maxWidth: 360, background: 'var(--dsw-alias-bg-base)',
            },
            onClick: handleCaptchaClick,
            dangerouslySetInnerHTML: { __html: captcha.svg },
          }) : null,
          authMsg ? h('p', { style: { ...dim, marginTop: 6 } }, authMsg) : null,
        ) : null,
      ) : null,
      preset ? h('div', null,
        h('p', { style: sub }, '预设 Preset'),
        h('p', { style: dim }, h('span', { style: code }, preset.id), ` — ${preset.ok ? '已加载 loaded' : `未加载 not loaded（${preset.detail}）`}`),
      ) : null,
      skills.length > 0 ? h('div', null,
        h('p', { style: sub }, `隔离的技能 Isolated skills（${skills.length}）`),
        h('p', { style: dim }, '子进程只看本插件 skills/（includeDefaultRoots: false）。项目自带的 <project>/.agents/skills 仍可用。'),
        h('table', { style: table }, h('tbody', null, skills.map(skill =>
          h('tr', { key: skill.id },
            h('td', { style: th }, h('span', { style: code }, skill.id)),
            h('td', { style: td }, skill.description || '—'))))),
      ) : null,
      tools.length > 0 ? h('div', null,
        h('p', { style: sub }, `影片工具 Film tools（MCP，${tools.length}）`),
        h('table', { style: table }, h('tbody', null, tools.map(tool =>
          h('tr', { key: tool.name },
            h('td', { style: th }, h('span', { style: code }, tool.name)),
            h('td', { style: td }, h('span', { style: dim }, tool.description || '—')))))),
      ) : null,
      h('div', null,
        h('p', { style: sub }, '项目指令链 Project instructions'),
        h('input', {
          style: input, value: projectId, placeholder: '粘贴项目 ID 查该片的指令链（面板 URL 或 /diagnose 里有）',
          onChange: event => setProjectId(event.target.value),
        }),
        h('div', { style: row },
          h('button', { style: { ...button, marginTop: 0 }, onClick: () => load(projectId.trim()) }, '查询 Load project'),
          h('button', { style: { ...button, marginTop: 0, marginLeft: 'auto' }, onClick: save, title: '记住这个项目 ID，下次打开自动查（只存本机）' }, '保存 Save'),
        ),
        savedId ? h('p', { style: dim }, `已记住 ${savedId}（打开自动查）`,
          h('button', { style: link, onClick: clearSaved }, '清除 Clear'),
        ) : null,
        chain ? h('div', { style: { marginTop: 8 } },
          h('p', { style: dim }, `常驻预算 resident：${chain?.budget?.total ?? '?'} / ${chain?.budget?.limit ?? 6144} bytes（${chain?.budget?.ok ? 'OK' : '超限 over'}）· persona ${chain?.persona ?? '?'}B`),
          h('p', { style: dim }, `读到的文件 files：${(chain.files ?? []).map(f => f.file).join('；') || '无'}`),
          chain.outside?.length > 0 ? h('p', { style: dim }, `已挡掉的上层手册 excluded：${chain.outside.join('；')}`) : null,
          Array.isArray(chain.activeTemplates) && chain.activeTemplates.length > 0
            ? h('p', { style: dim }, `生效模板 templates：${chain.activeTemplates.join(', ')}`) : null,
        ) : null,
        chainError ? h('p', { style: dim }, `该项目查不到 ${chainError}（先在工作台里打开一次该项目）`) : null,
      ),
    );
  };
}
