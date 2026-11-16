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

  return function EnvSection() {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState('');
    const [projectId, setProjectId] = React.useState('');
    const [savedId, setSavedId] = React.useState('');
    const [loading, setLoading] = React.useState(true);
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
    const skills = Array.isArray(data?.skills?.isolated) ? data.skills.isolated : [];
    const tools = Array.isArray(data?.tools) ? data.tools : [];
    const chain = data?.project && !data.project.error ? data.project : null;
    const chainError = data?.project?.error;

    return h('div', { 'data-no996-env': '', style: box },
      h('p', { style: title }, '剪辑环境 · Environment'),
      h('p', { style: dim }, '影片子进程实际能加载的东西（只读）。全局 skill 目录不进影片对话，读文件/读图/丢 PDF 走下面的影片工具，不受影响。'),
      loading ? h('p', { style: dim }, '正在读取… Loading…') : null,
      error ? h('p', { style: dim }, `读取失败 Load failed：${error}`) : null,
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
