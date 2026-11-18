// Dev-only debug editor & standalone routes (`src/dev/`).
//
// Physically excluded from production `.tgz` packages (`package.json` +
// `scripts/pack-tgz.mjs` + `scripts/run-release-check.mjs`). Only mounted in a
// developer workspace when an explicit dev flag is enabled.
import { createDebugUrlRoute } from '../studio/studio-controller/routes/debug-url.mjs';

export function registerDevRoutes({
  ctx,
  registerRoute,
  trackRoute,
  officialShell,
  isDisposed,
  getUpstream,
  ensureStudioStarted,
  proxyFor,
  getBridge,
  setBridge,
  getPortalUrl,
  listTemplates,
  templatesRoot,
}) {
  const disposers = [];

  disposers.push(trackRoute(registerRoute({
    kind: 'exact',
    path: '/no996-openfilm/standalone',
    async handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end('DSH_SESSION_REQUIRED'); return; }
      const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenFilm 视频创作 (Dev Standalone)</title>'
        + '<style>html,body{margin:0;height:100%;background:#111;color:#eee;font:13px system-ui,sans-serif}'
        + '#bar{display:flex;gap:12px;align-items:center;padding:6px 10px;border-bottom:1px solid #333}'
        + '#bar label{display:flex;gap:6px;align-items:center}#frame{display:block;width:100%;height:calc(100% - 37px);border:0;background:#000}'
        + '#err{padding:16px;color:#f88;white-space:pre-wrap}</style></head><body>'
        + '<div id="bar"><strong>OpenFilm 开发调试窗</strong>'
        + '<label>对话侧 <select id="side"><option value="right">右侧</option><option value="left">左侧</option></select></label>'
        + '<label>宽度 <input id="width" type="range" min="240" max="800" step="20" value="420"><span id="wv">420</span></label>'
        + '<button id="reload">重新载入</button><span id="status">正在启动…</span></div>'
        + '<iframe id="frame" allow="clipboard-read; clipboard-write"></iframe><pre id="err" hidden></pre>'
        + '<script>(function(){var f=document.getElementById("frame"),status=document.getElementById("status"),err=document.getElementById("err");'
        + 'var side=document.getElementById("side"),width=document.getElementById("width"),wv=document.getElementById("wv");'
        + 'function post(){var w=Number(width.value);wv.textContent=w;try{f.contentWindow.postMessage({type:"no996-openfilm:layout",version:1,side:side.value,width:w},"*")}catch(e){}}'
        + 'function fail(m){err.hidden=false;err.textContent=String(m);status.textContent="启动失败"}'
        + 'function start(){status.textContent="正在启动…";fetch("/api/no996-openfilm/bootstrap",{method:"POST",credentials:"same-origin"})'
        + '.then(function(r){if(!r.ok)throw new Error("bootstrap HTTP "+r.status);return r.json()})'
        + '.then(function(d){var u=new URL(d.editorOrigin);f.src=u.origin+"/";status.textContent="已连接 "+u.origin;f.onload=post})'
        + '.catch(function(e){fail(e&&e.message||e)})}'
        + 'side.onchange=post;width.oninput=post;document.getElementById("reload").onclick=function(){err.hidden=true;start()};start();})();</script>'
        + '</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(page) }).end(page);
    },
  })));

  disposers.push(trackRoute(registerRoute({
    kind: 'exact',
    path: '/no996-openfilm/templates',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end(); return; }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('DSH_BROWSER_REQUIRED'); return; }
      let items = [];
      try { items = await listTemplates(templatesRoot); } catch { /* empty */ }
      const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
      const cards = items.map(item => `<li><strong>${escape(item.title)}</strong> <small>${escape(item.mode)}</small><p>${escape(item.description)}</p><button type="button" data-id="${escape(item.id)}">用这个模板建项目</button></li>`).join('');
      const html = `<!doctype html><meta charset="utf-8"><title>OpenFilm 模板 (Dev)</title><style>body{font:14px system-ui,sans-serif;background:#171717;color:#e8e8e8;margin:24px}li{margin:16px 0;padding:12px;border:1px solid #333;border-radius:8px;list-style:none}button{margin-top:8px;padding:6px 12px;border-radius:6px;border:1px solid #555;background:#2a2a2a;color:inherit;cursor:pointer}p{margin:6px 0;opacity:.8}#msg{margin-top:16px;color:#f88}</style><h1>OpenFilm 模板</h1><ul>${cards || '<li>没有可用模板</li>'}</ul><div id="msg"></div><script>document.addEventListener('click',async e=>{const b=e.target.closest('button[data-id]');if(!b)return;b.disabled=true;b.textContent='创建中…';try{const r=await fetch('/__dsh/official-rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'template:create',payload:{templateId:b.dataset.id}})});const d=await r.json();if(!d||!d.projectId)throw new Error((d&&d.error)||('HTTP '+r.status));if(d.prompt){try{localStorage.setItem('no996.openfilm.templatePrompt',d.prompt)}catch(_){}}location.href='/projects/'+d.projectId}catch(err){document.getElementById('msg').textContent='创建失败：'+(err&&err.message||err);b.disabled=false;b.textContent='用这个模板建项目'}})</script>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) }).end(html);
    },
  })));

  const debugUrl = createDebugUrlRoute({
    ctx,
    register: registerRoute,
    track: trackRoute,
    officialShell,
    isDisposed,
    getUpstream,
    ensureStudioStarted,
    proxyFor,
    getBridge,
    setBridge,
    getPortalUrl,
  });
  disposers.push(...debugUrl.disposers);

  return disposers;
}
