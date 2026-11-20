import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { isReleasePackage } from '../host/distribution.mjs';
import { officialFacadeSource } from '../official/official-facade.mjs';
import { officialUploadSource } from '../official/official-attachment.mjs';
import { shellUiInjection, shellUiVersion } from '../ui/shell-extras.mjs';
import { theme, themeSurfaceFor } from '../ui/theme.mjs';
import { replaceTitle } from '../ui/brand.mjs';
import { createPluginSurfaceProxy } from './studio-proxy/plugin-surface.mjs';
import { MAX_FRAME, WS_GUID, frames, wsFrame } from './studio-proxy/websocket.mjs';
import {
  RESPONSE_HEADERS,
  SAFE_HEADERS,
  ancestorsFor,
  fail,
  friendlyCommandFailure,
  listen,
  recordFailure,
  shutdown,
  upstreamOrigin,
} from './studio-proxy/upstream.mjs';

// Proxy for the pinned OpenFilm 0.4.0 protocol. It does not provide process
// isolation. Unrecognized or unsafe representations fail closed.
const MAX_RESPONSE = 32 * 1024 * 1024;

const AGENT_HINTS = Object.freeze({
  OFFICIAL_AGENT_FAILED: '对话请求未能完成，请重试',
  OFFICIAL_AGENT_BUSY: '上一条还在进行中，等它结束或先取消',
  OFFICIAL_AGENT_NOT_RUNNING: '当前没有可取消的回合',
  OFFICIAL_AGENT_MODEL_UNAVAILABLE: '当前拿不到模型列表，稍后再试',
  OFFICIAL_AGENT_UNAVAILABLE: '项目或对话服务暂时不可用',
  // Distinct from OFFICIAL_AGENT_FAILED: the child often finished; the page's
  // EventSource died (refresh / remount). Saying "子进程出错" here caused 2026-11-16
  // "你好" turns to look like ACP crashes when the log was STREAM_LOST.
  OFFICIAL_AGENT_STREAM_LOST: '页面连接断了（请勿中途刷新），输出可能不完整，请重试',
  OFFICIAL_AGENT_INPUT: '请求内容无效',
  OFFICIAL_AGENT_CLOSED: '对话已关闭',
  OFFICIAL_AGENT_PROJECT_UNVERIFIED: '项目校验失败，刷新面板再试',
  OFFICIAL_AGENT_CONVERSATION_ARCHIVED: '这个会话已归档，先恢复再继续',
  OFFICIAL_AGENT_OWNERSHIP: '找不到这个会话',
  OFFICIAL_AGENT_DEPENDENCY: '宿主缺少依赖能力',
});

function normalizeViewerOrigins(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('viewerOrigins must be an array of loopback http origins');
  const allowed = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) continue;
    let parsed;
    try { parsed = new URL(entry); } catch { throw new TypeError('viewerOrigins entries must be absolute URLs'); }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port
      || parsed.origin !== entry || parsed.username || parsed.password) {
      throw new TypeError('viewerOrigins must be loopback http://127.0.0.1|localhost:<port> origins');
    }
    allowed.add(parsed.origin);
  }
  return [...allowed];
}

export async function startStudioProxy({ upstream, authenticateBrowser, webOrigin, listenPort, desktop = false, officialShell = false, officialRpc, authorizeOfficialProject, attachOfficialEvents, readProjectFile, openProjectFile, beforeProjectDelete, rewriteLibraryVoices, voiceSettings, log, diagLog, devHooks, viewerOrigins, sessionLifetimeMs = 30 * 60_000 } = {}) {
  // A proxy without a logger is valid (tests, embedders); the calls are no-ops.
  const say = typeof log?.write === 'function' ? log : { write() {}, info() {}, warn() {}, error() {} };
  const recordDiag = typeof diagLog?.record === 'function' ? diagLog : null;
  const activeDevHooks = !isReleasePackage() && devHooks && typeof devHooks === 'object' ? devHooks : null;
  const relaxedEmbed = activeDevHooks?.relaxedEmbed === true;
  let styleLabLoader = null;
  async function getStyleLabHtml() {
    if (isReleasePackage()) return '';
    if (typeof activeDevHooks?.styleLabHtml === 'function') return activeDevHooks.styleLabHtml();
    if (process.env.NO996_OPENFILM_STYLE_LAB !== '1') return '';
    if (!styleLabLoader) {
      styleLabLoader = import('../ui/style-lab.mjs').then(m => m.styleLabInjection).catch(() => null);
    }
    const fn = await styleLabLoader;
    return typeof fn === 'function' ? fn() : '';
  }
  if (typeof officialShell !== 'boolean') throw new TypeError('officialShell must be a boolean');
  if (officialRpc !== undefined && typeof officialRpc !== 'function') throw new TypeError('officialRpc must be a function');
  if (authorizeOfficialProject !== undefined && typeof authorizeOfficialProject !== 'function') throw new TypeError('authorizeOfficialProject must be a function');
  if (attachOfficialEvents !== undefined && typeof attachOfficialEvents !== 'function') throw new TypeError('attachOfficialEvents must be a function');
  if (readProjectFile !== undefined && typeof readProjectFile !== 'function') throw new TypeError('readProjectFile must be a function');
  if (openProjectFile !== undefined && typeof openProjectFile !== 'function') throw new TypeError('openProjectFile must be a function');
  if (beforeProjectDelete !== undefined && typeof beforeProjectDelete !== 'function') throw new TypeError('beforeProjectDelete must be a function');
  if (rewriteLibraryVoices !== undefined && typeof rewriteLibraryVoices !== 'function') throw new TypeError('rewriteLibraryVoices must be a function');
  if (voiceSettings !== undefined && (typeof voiceSettings !== 'object' || typeof voiceSettings.state !== 'function' || typeof voiceSettings.choose !== 'function' || typeof voiceSettings.prepare !== 'function')) throw new TypeError('voiceSettings must expose state/choose/prepare');
  const web = new URL(webOrigin);
  if (desktop ? !['dsh-app://app', 'app://app'].includes(webOrigin) :
      web.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(web.hostname) || !web.port || web.origin !== webOrigin || web.username || web.password) throw new TypeError('Invalid DSH origin');
  if (typeof authenticateBrowser !== 'function') throw new TypeError('Browser authentication callback is required');
  if (!Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 1_000 || sessionLifetimeMs > 24 * 60 * 60_000) throw new TypeError('sessionLifetimeMs must be 1s–24h');
  const viewers = normalizeViewerOrigins(viewerOrigins);
  const editorUpstream = upstreamOrigin(upstream?.origin, '127.0.0.1');
  const filmUpstream = upstreamOrigin(upstream?.filmOrigin, 'localhost');
  const pluginUpstream = upstream?.pluginOrigin ? upstreamOrigin(upstream.pluginOrigin, 'localhost') : null;
  const key = upstream?.key;
  // The pinned release generates a 24-byte hexadecimal key when not advertised.
  if (typeof key !== 'string' || !/^[a-f0-9]{48}$/.test(key)) throw new TypeError('Invalid Studio key');
  let closed = false;
  let editorOrigin;
  let filmOrigin;
  let pluginOrigin;
  const rewriteOrigins = value => {
    const text = value.replaceAll(filmUpstream.origin, filmOrigin);
    return pluginUpstream ? text.replaceAll(pluginUpstream.origin, pluginOrigin) : text;
  };
  let officialRequests = 0;
  // Facts for the panel when the frame stays silent: was the shell page even
  // served, and was the preload injected? No project data or secrets here.
  const diag = { html: 0, injected: 0, lastPath: '', lastStatus: 0, refusals: 0 };
  const sockets = new Set();
  const tickets = new Map();
  const sessions = new Map();
  const ticketLifetime = 60_000;
  // A desktop frame authenticates with this cookie, not with DSH's own session,
  // so its lifetime decides how long an editor stays open. The panel renews it
  // in place before it lapses (see renew-session); the value is configurable so a
  // test can watch a full rotation without waiting half an hour.
  const sessionLifetime = sessionLifetimeMs;
  const maxCredentials = 128;
  const cookieName = 'dsh_openfilm_session';
  function prune(map) {
    const now = Date.now();
    for (const [token, expiry] of map) if (expiry <= now) map.delete(token);
  }
  /** The one ticket session this request names, if it names exactly one. */
  function sessionToken(req) {
    const matches = String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : undefined;
  }
  function authenticated(req) {
    if (closed) return false;
    // A ticket session is as strong as the cookie it was exchanged for: it is
    // minted only from a Host-issued one-use ticket, HttpOnly and short-lived.
    // Accepting it on both surfaces is what lets a browser without DSH's cookie
    // (the built-in one, another browser) keep using the page it just opened.
    prune(sessions);
    const token = sessionToken(req);
    if (token !== undefined && sessions.has(token)) return true;
    if (desktop) return false;
    try { return authenticateBrowser(req) === true; } catch { return false; }
  }
  function desktopBridge(req, res) {
    // A ticket is a one-use, 60 s grant minted only by an authenticated Host
    // request. Serving it to a top-level tab is how the same local Studio can be
    // opened in a separate browser that has no DSH cookie.
    if (!req.url?.startsWith('/__dsh/')) return false;
    if (closed || req.headers.host !== new URL(editorOrigin).host) { fail(res); return true; }
    const site = req.headers['sec-fetch-site'];
    if (req.url === '/__dsh/open' && req.method === 'GET') {
      if (!['iframe', 'document'].includes(req.headers['sec-fetch-dest']) || !['cross-site', 'none'].includes(site) ||
          (req.headers.origin && req.headers.origin !== webOrigin && req.headers.origin !== 'null')) { fail(res); return true; }
      const body = `<!doctype html><meta charset="utf-8"><body><script>(async()=>{const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);try{const r=await fetch('/__dsh/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})});if(!r.ok){document.body.textContent='Unable to open OpenFilm Studio (OF_TICKET_REJECTED).';return}const check=await fetch('/__dsh/session',{cache:'no-store'});if(!check.ok){document.body.textContent='Unable to open OpenFilm Studio (OF_SESSION_COOKIE_UNAVAILABLE). Partitioned secure cookies may be unavailable.';return}location.replace('/');return}catch{}document.body.textContent='Unable to open OpenFilm Studio (OF_BRIDGE_FAILED).'})()</script></body>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors ${ancestorsFor(webOrigin)}`, 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return true;
    }
    if (req.url === '/__dsh/session' && req.method === 'GET') {
      if (site !== 'same-origin' || (req.headers.origin && req.headers.origin !== editorOrigin) || !authenticated(req)) fail(res);
      else { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); }
      return true;
    }
    if (req.url !== '/__dsh/session' || req.method !== 'POST' || req.headers.origin !== editorOrigin || site !== 'same-origin' ||
        !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) { fail(res); return true; }
    let length = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > 512) { fail(res, 413); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { if (!res.destroyed && !res.writableEnded) fail(res, 400); });
    req.on('end', () => {
      if (closed || res.writableEnded || res.destroyed) return;
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(res, 400); }
      if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.ticket)) return fail(res);
      prune(tickets);
      prune(sessions);
      const held = sessionToken(req);
      const current = held !== undefined && sessions.has(held) ? held : undefined;
      const renewable = current !== undefined;
      if (!tickets.has(value.ticket) || (sessions.size >= maxCredentials && !renewable)) return fail(res);
      // No await between checking and deleting: only one request can consume a ticket.
      tickets.delete(value.ticket);
      // Renewal keeps the token the page already holds. A fresh value would not
      // reach the cookie header a WebSocket captured at upgrade time, and this
      // proxy's per-socket recheck authenticates from that captured header; a
      // new token would therefore kill an editor that has simply been open a
      // while. Extending the entry (and re-setting the same cookie's Max-Age)
      // is what makes a long-lived editor stop reloading every half hour.
      const session = renewable ? current : randomBytes(32).toString('base64url');
      sessions.set(session, Date.now() + sessionLifetime);
      say.info(renewable ? 'session-renewed' : 'ticket-redeemed', { desktop, active: sessions.size });
      res.writeHead(204, { 'cache-control': 'no-store', 'set-cookie': `${cookieName}=${session}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=${Math.round(sessionLifetime / 1000)}` });
      res.end();
    });
    return true;
  }
  /** Origins that load the editor UI: ephemeral editorOrigin, plus any public door (dev portal). */
  function isEditorLikeOrigin(origin) {
    return origin === editorOrigin || viewers.includes(origin);
  }
  /**
   * Target Origin the film bridge must postMessage to. Behind a reverse door the
   * browser tab's Origin is the door (e.g. :47821), not the ephemeral editor port;
   * baking editorOrigin into EDITOR drops every ready/seeked message and the
   * preview stays on "Drawing the first frame".
   */
  function filmEditorOrigin() {
    return viewers[0] || editorOrigin;
  }
  function rejectionReason(req, film) {
    const expected = new URL(film ? filmOrigin : editorOrigin);
    if (closed || req.headers.host !== expected.host) return 'OF_HOST_REJECTED';
    if (relaxedEmbed && !film && (req.method === 'GET' || req.method === 'HEAD' || req.headers.origin === editorOrigin)) return null;
    const origin = req.headers.origin;
    const desktopNavigation = desktop && !film && req.method === 'GET' && req.headers['sec-fetch-dest'] === 'iframe' && authenticated(req);
    if (origin && !isEditorLikeOrigin(origin) && !(film && origin === filmOrigin) && !(desktopNavigation && (origin === webOrigin || origin === 'null'))) return 'OF_ORIGIN_REJECTED';
    if (!film) {
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && !['same-origin', 'same-site', 'none'].includes(site) && !(desktopNavigation && site === 'cross-site')) return 'OF_SITE_REJECTED';
      if (!origin && !['GET', 'HEAD'].includes(req.method)) return 'OF_METHOD_REJECTED';
      if (!origin && !['same-origin', 'same-site', 'none'].includes(site) && !(desktopNavigation && site === 'cross-site')) return 'OF_METADATA_MISSING';
    } else if (!['GET', 'HEAD'].includes(req.method)) return 'OF_METHOD_REJECTED';
    return null;
  }
  function permitted(req, film) { return rejectionReason(req, film) === null; }
  function isSameFetchSite(req) { return relaxedEmbed || req.headers['sec-fetch-site'] === 'same-origin'; }
  function traceIdFrom(req, prefix = 'req') {
    const incoming = String(req.headers['x-no996-trace-id'] || '').trim();
    return /^[A-Za-z0-9_-]{6,48}$/.test(incoming) ? incoming : `${prefix}-${randomBytes(4).toString('hex')}`;
  }
  async function rewriteEditorHtml(value, url, status) {
    value = replaceTitle(value);
    diag.html += 1;
    diag.lastPath = url.pathname;
    diag.lastStatus = status;
    const parentOrigin = JSON.stringify(webOrigin).replaceAll('<', '\\u003c');
    const officialPage = url.pathname === '/' || /^\/projects\/[A-Za-z0-9_-]{6,40}\/?$/.test(url.pathname);
    const transport = `async (channel,payload)=>{var tid='rpc-'+Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-3);const r=await fetch('/__dsh/official-rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-no996-trace-id':tid},body:JSON.stringify({channel,payload})});if(!r.ok){let detail='';try{detail=(await r.text()).slice(0,300)}catch(e){}var rt=r.headers.get('x-no996-trace-id')||tid;throw new Error('OpenFilm capability unavailable: '+channel+' ['+r.status+'] '+(detail||'')+' [trace:'+rt+']');}return r.json()}`;
    const nativePrelude = officialShell && officialPage ? `<script>globalThis.openfilmNative=${officialFacadeSource}({invoke:${transport},upload:${officialUploadSource}});</script>` : '';
    const diagnostics = officialShell ? '<script>(function(){' +
      'if(globalThis.__no996Diag)return;globalThis.__no996Diag=1;var n=0;var rawFetch=globalThis.fetch;var buf=globalThis.__no996DiagBuffer=[];' +
      'var sentCount=0,sentReset=Date.now();' +
      'function pushBuf(entry){try{buf.push(entry);if(buf.length>200)buf.shift();try{window.dispatchEvent(new CustomEvent("no996:diag-entry",{detail:entry}))}catch(e){}}catch(e){}}' +
      'function reportToHost(entry){try{if(!rawFetch)return;var now=Date.now();if(now-sentReset>60000){sentCount=0;sentReset=now;}if(sentCount>=60)return;sentCount++;rawFetch.call(globalThis,"/__dsh/client-diag",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(entry).slice(0,7800),keepalive:true}).catch(function(){});}catch(e){}}' +
      'function show(m,meta){try{var entry={id:"ui-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,6),ts:new Date().toISOString(),level:(meta&&meta.level)||"error",layer:(meta&&meta.layer)||"ui",traceId:(meta&&meta.traceId)||"",code:(meta&&meta.code)||"UI_ERROR",channel:(meta&&meta.channel)||"",httpStatus:(meta&&meta.httpStatus)||null,location:(meta&&meta.location)||"",summary:String(m),detail:(meta&&meta.detail)||null};pushBuf(entry);if(entry.level==="error"||entry.level==="warn")reportToHost(entry);if(n>3)return;n++;var d=document.getElementById("no996-diag");' +
      'if(!d){d=document.createElement("div");d.id="no996-diag";' +
      'd.style.cssText="position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#7f1d1d;color:#fff;font:12px/1.5 ui-monospace,Consolas,monospace;padding:10px 12px 10px 12px;border-radius:8px;max-height:40vh;overflow:auto;white-space:pre-wrap;text-align:left;box-shadow:0 8px 28px rgba(0,0,0,.45)";' +
      'var bar=document.createElement("div");bar.style.cssText="display:flex;align-items:center;gap:8px;margin-bottom:6px;";' +
      'var title=document.createElement("strong");title.textContent="发生异常";title.style.cssText="font-size:12px;margin-right:auto";bar.appendChild(title);' +
      'var viewBtn=document.createElement("button");viewBtn.type="button";viewBtn.textContent="查看诊断日志";viewBtn.style.cssText="background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28);color:#fff;border-radius:5px;padding:2px 8px;font:inherit;cursor:pointer";' +
      'viewBtn.onclick=function(){try{window.dispatchEvent(new CustomEvent("no996:open-diagnostics",{detail:{traceId:d.getAttribute("data-last-trace")||""}}))}catch(e){}};bar.appendChild(viewBtn);' +
      'var copyBtn=document.createElement("button");copyBtn.type="button";copyBtn.textContent="复制报错";copyBtn.style.cssText="background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.24);color:#fff;border-radius:5px;padding:2px 8px;font:inherit;cursor:pointer";' +
      'copyBtn.onclick=function(){try{navigator.clipboard.writeText(linesBox.textContent||"").then(function(){copyBtn.textContent="已复制";setTimeout(function(){copyBtn.textContent="复制报错";},1500)}).catch(function(){})}catch(e){}};bar.appendChild(copyBtn);' +
      'var b=document.createElement("button");b.type="button";b.textContent="×";b.style.cssText="background:transparent;border:0;color:#fff;font-size:18px;line-height:1;cursor:pointer;padding:0 4px";b.onclick=function(){d.remove()};bar.appendChild(b);' +
      'd.appendChild(bar);var linesBox=document.createElement("div");linesBox.setAttribute("data-no996-diag-lines","1");d.appendChild(linesBox);document.documentElement.appendChild(d);}' +
      'if(entry.traceId)d.setAttribute("data-last-trace",entry.traceId);' +
      'var target=d.querySelector("[data-no996-diag-lines]")||d;target.appendChild(document.createTextNode(String(m)+"\\n"));}catch(e){}}' +
      'globalThis.__no996ShowError=show;' +
      // A note that must never paint the red bar: expected degradations (a refused
      // fullscreen that fell back to an in-place zoom) are recorded for diagnosis
      // and stay out of the person's way.
      'globalThis.__no996DiagWarn=function(m,meta){try{var entry={id:"ui-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,6),ts:new Date().toISOString(),level:"info",layer:(meta&&meta.layer)||"ui",traceId:(meta&&meta.traceId)||"",code:(meta&&meta.code)||"UI_NOTE",channel:(meta&&meta.channel)||"",httpStatus:null,projectId:"",conversation:"",sessionDigest:"",location:(meta&&meta.location)||"",summary:String(m),detail:(meta&&meta.detail)||null};pushBuf(entry);reportToHost(entry);}catch(e){}};' +
      'addEventListener("error",function(e){var m=e.message||"unknown";if(/ResizeObserver loop/.test(m))return;var loc=(e.filename||"")+":"+(e.lineno||0)+":"+(e.colno||0);show("[JS] "+m+" @ "+loc,{layer:"ui",code:"JS_ERROR",location:loc,detail:{message:m,stack:e.error&&e.error.stack?String(e.error.stack).slice(0,1200):""}});});' +
      'addEventListener("unhandledrejection",function(e){var r=e.reason;var m=(r&&r.message)||String(r);var s=(r&&r.stack)||"";var at=String(s).split("\\n").filter(function(l){return l.indexOf("at ")>=0}).slice(0,4).join(" | ");show("[Promise] "+m+(at?"\\n"+at:""),{layer:"ui",code:"UNHANDLED_REJECTION",location:at.slice(0,180),detail:{message:m,stack:String(s).slice(0,1200)}});});' +
      'var ce=console.error;console.error=function(){try{for(var i=0;i<arguments.length;i++){var a=arguments[i];if(a instanceof Error){show("[React] "+(a.message||a.name),{layer:"ui",code:"REACT_ERROR",detail:{message:a.message||a.name,stack:String(a.stack||"").slice(0,1200)}});break;}}}catch(e){}return ce.apply(console,arguments);};' +
      'var ES=globalThis.EventSource;if(typeof ES==="function"){globalThis.EventSource=function(u,o){var es=new ES(u,o);try{if(String(u).indexOf("/__dsh/")===0){es.addEventListener("error",function(){pushBuf({id:"sse-"+Date.now().toString(36),ts:new Date().toISOString(),level:"warn",layer:"sse",code:"SSE_ERROR",channel:String(u).slice(0,120),summary:"SSE 连接异常或重连",detail:{readyState:es.readyState}});reportToHost(buf[buf.length-1]);});}}catch(e){}return es;};globalThis.EventSource.prototype=ES.prototype;}' +
      'var f=rawFetch;if(f)globalThis.fetch=function(u,o){var started=Date.now();var s=String(u);if(s.indexOf("/__dsh/client-diag")===0)return f.apply(this,arguments);' +
      'var tid="ui-"+Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-3);' +
      'try{if((s.indexOf("/__dsh/")===0||s.indexOf("/api/")===0)){var nextO=o?Object.assign({},o):{};var h=new Headers(nextO.headers||{});if(!h.has("x-no996-trace-id"))h.set("x-no996-trace-id",tid);else tid=h.get("x-no996-trace-id")||tid;nextO.headers=h;arguments[1]=nextO;o=nextO;}}catch(e){}' +
      'return f.apply(this,arguments).then(function(r){try{var ch="";try{ch=String(((JSON.parse((o&&o.body)||"{}")||{}).channel)||"");}catch(e){}var optional=/^(agent:(thinking|models|permission|trace)|chat:(archive-state|log))$/.test(ch);if(optional)return r;var rt=r.headers.get("x-no996-trace-id")||tid;if(r.status>=500||(r.status===404&&s.indexOf("/api/projects")>=0)){var base="[HTTP "+r.status+"] "+s.slice(0,180);r.clone().text().then(function(t){var why="";try{var j=JSON.parse(t);if(j&&typeof j.error==="string"&&j.error)why=" - "+j.error.slice(0,240);}catch(e){why=t?(" - "+String(t).slice(0,240)):"";}show(base+why,{layer:s.indexOf("/__dsh/")===0?"rpc":"studio-upstream",traceId:rt,code:"HTTP_"+r.status,channel:ch||s.slice(0,120),httpStatus:r.status,detail:{url:s.slice(0,180),durationMs:Date.now()-started,responsePreview:String(t||"").slice(0,400)}});}).catch(function(){show(base,{layer:s.indexOf("/__dsh/")===0?"rpc":"studio-upstream",traceId:rt,code:"HTTP_"+r.status,channel:ch||s.slice(0,120),httpStatus:r.status});});}}catch(e){}return r;},function(e){try{var ch="";try{ch=String(((JSON.parse((o&&o.body)||"{}")||{}).channel)||"");}catch(_){}show("[网络] "+s.slice(0,180)+" "+((e&&e.message)||e),{layer:"ui",traceId:tid,code:"NETWORK_ERROR",channel:ch||s.slice(0,120),detail:{url:s.slice(0,180),durationMs:Date.now()-started,message:String((e&&e.message)||e).slice(0,300)}});}catch(_){}throw e;});};' +
      'setTimeout(function(){try{parent.postMessage({type:"no996-openfilm:boot",version:1,hasNative:!!globalThis.openfilmNative,rendered:!!(document.getElementById("root")||{}).firstElementChild},' + "'*'" + ')}catch(e){}},1500);' +
      'setTimeout(function(){var r=document.getElementById("root");if(r&&!r.firstElementChild)show("界面 10 秒后仍未渲染（#root 为空）",{layer:"ui",code:"BOOT_RENDER_TIMEOUT",location:"studio-proxy:#root"});},10000);' +
      '})()</script>' : '';
    const styleLab = await getStyleLabHtml();
    // A cross-origin frame can be refused HTML fullscreen by permissions policy even
    // when the hosting page delegates it. The preview's own button only calls
    // requestFullscreen and never catches the refusal, so it used to do nothing and
    // surface as an unhandled rejection with a red bar. This keeps the native path
    // exactly as it is and, only when the browser refuses, produces the same visual
    // outcome in place: the preview element fills the window and Escape returns.
    const fullscreenShim = `<script>(function(){
if(globalThis.__no996Fullscreen)return;globalThis.__no996Fullscreen=1;
var doc=document;if(!doc||typeof Element==='undefined'||typeof Element.prototype.requestFullscreen!=='function')return;
var nativeRequest=Element.prototype.requestFullscreen,nativeExit=doc.exitFullscreen;
var nativeGet=Object.getOwnPropertyDescriptor(Document.prototype,'fullscreenElement');
var fake=null;
function note(reason){try{if(typeof globalThis.__no996DiagWarn==='function')globalThis.__no996DiagWarn('系统全屏不可用，已切换为窗口内放大',{layer:'ui',code:'FULLSCREEN_FALLBACK',location:'studio-proxy:fullscreen',detail:{reason:String(reason||'').slice(0,160)}})}catch(e){}}
function emit(){try{doc.dispatchEvent(new Event('fullscreenchange'))}catch(e){}}
function clear(){
  if(!fake)return false;
  var el=fake;fake=null;
  try{el.removeAttribute('data-no996-immersive');var s=el.style;s.position='';s.left='';s.top='';s.width='';s.height='';s.zIndex='';s.background='';s.margin='';}catch(e){}
  try{if(doc.body)doc.body.style.overflow=''}catch(e){}
  emit();return true;
}
function immersive(el){
  fake=el;try{el.setAttribute('data-no996-immersive','1')}catch(e){}
  try{var s=el.style;s.position='fixed';s.left='0';s.top='0';s.width='100vw';s.height='100vh';s.zIndex='2147483000';s.background='#000';s.margin='0';}catch(e){}
  try{if(doc.body)doc.body.style.overflow='hidden'}catch(e){}
  emit();
}
Object.defineProperty(doc,'fullscreenElement',{configurable:true,get:function(){return fake||(nativeGet&&nativeGet.get?nativeGet.get.call(doc):null)}});
Object.defineProperty(doc,'fullscreenEnabled',{configurable:true,get:function(){return true}});
doc.exitFullscreen=function(){if(fake){clear();return Promise.resolve()}return nativeExit?nativeExit.call(doc):Promise.resolve()};
Element.prototype.requestFullscreen=function(options){
  var self=this;
  return Promise.resolve().then(function(){return nativeRequest.call(self,options)}).catch(function(error){
    if(fake)return undefined;
    immersive(self);note(error&&error.message);return undefined;
  });
};
doc.addEventListener('keydown',function(e){if(e.key==='Escape'&&fake){e.preventDefault();clear();}},true);
})()</script>`;
    const devHead = typeof activeDevHooks?.headInjection === 'function' ? activeDevHooks.headInjection() : '';
    const host = `${diagnostics}${nativePrelude}${fullscreenShim}<script>try{
if(!localStorage.getItem('openfilm.workspace.current.v2')){
  var base={mode:'edit',tree:null,assets:false,layers:false,timeline:true,inspector:true,chat:true,libraryDock:'chat',chatSide:'left',layersSide:'left',inspectorSide:'right',timelineEdge:'bottom',assetsWidth:320,libraryHeight:280,layersWidth:240,inspectorWidth:360,timelineHeight:null,chatWidth:420};
  var plan=JSON.parse(JSON.stringify(base));plan.mode='canvas';plan.timeline=false;plan.inspector=false;
  localStorage.setItem('openfilm.workspace.current.v2',JSON.stringify({version:2,edit:base,canvas:plan}));
}else{
  try{
    var saved=JSON.parse(localStorage.getItem('openfilm.workspace.current.v2'));
    if(saved&&saved.edit&&saved.edit.chatSide==='right'&&saved.edit.chatWidth===420){
      saved.edit.chatSide='left';
      if(saved.canvas&&saved.canvas.chatSide==='right')saved.canvas.chatSide='left';
      localStorage.setItem('openfilm.workspace.current.v2',JSON.stringify(saved));
    }
  }catch(e){}
}
}catch(e){}globalThis.openfilmHost={version:1,name:'DSH'};
(function(){
  const parentOrigin=${parentOrigin}, targetOrigin=${desktop ? "'*'" : parentOrigin};
  let last;
  function report(force){
    const match=/^\\/projects\\/([\\w-]{6,40})\\/?$/.exec(location.pathname);
    const projectId=match?match[1]:null;
    if(!force&&last===projectId)return;
    last=projectId;
    try{if(parent!==window)parent.postMessage({type:'no996-openfilm:project',version:1,projectId},targetOrigin)}catch{}
    reportArchive(projectId);
  }
  function reportArchive(projectId){
    if(!projectId||parent===window)return;
    fetch('/__dsh/official-rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'chat:archive-state',payload:{projectId:projectId}})})
      .then(function(r){return r.ok?r.json():null})
      .then(function(d){if(d&&typeof d==='object')parent.postMessage({type:'no996-openfilm:archive',version:1,projectId:projectId,archived:d.archived===true,available:d.available!==false},targetOrigin)})
      .catch(function(){});
  }
  addEventListener('message',function(event){
    if(event.source!==parent||parent===window||!(event.origin===parentOrigin||(${desktop}&&event.origin==='null')))return;
    const data=event.data;
    if(data&&typeof data==='object'&&data.type==='no996-openfilm:unarchive'&&data.version===1&&typeof data.projectId==='string'&&/^[A-Za-z0-9_-]{6,40}$/.test(data.projectId)){
      fetch('/__dsh/official-rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'chat:unarchive',payload:{projectId:data.projectId}})})
        .then(function(r){return r.ok?r.json():null})
        .then(function(){report(true)})
        .catch(function(){});
    }
  });
  for(const name of ['pushState','replaceState']){
    const original=history[name];
    history[name]=function(...args){const result=original.apply(this,args);report(false);return result};
  }
  addEventListener('popstate',()=>report(false));
  addEventListener('message',event=>{
    if(event.source!==parent||parent===window||!(event.origin===parentOrigin||(${desktop}&&event.origin==='null')))return;
    const data=event.data;
    if(data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===2&&data.type==='no996-openfilm:project-snapshot-request'&&data.version===1)report(true);
    /* Renewal: the panel holds a fresh one-time grant for this frame's own session.
       Redeeming it here extends the cookie in place, so an editor that has stayed
       open past the credential's lifetime never has to be reloaded. */
    if(data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===3&&data.type==='no996-openfilm:renew-session'&&data.version===1&&typeof data.ticket==='string'&&/^[A-Za-z0-9_-]{43}$/.test(data.ticket)){
      const answer=ok=>{try{parent.postMessage({type:'no996-openfilm:renewed',version:1,ok:ok},'*')}catch(e){}};
      fetch('/__dsh/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:data.ticket})})
        .then(function(r){answer(r.ok)})
        .catch(function(){answer(false)});
    }
    if(data&&typeof data==='object'&&!Array.isArray(data)&&data.type==='no996-openfilm:navigate'&&data.version===1&&typeof data.projectId==='string'&&/^[A-Za-z0-9_-]{6,40}$/.test(data.projectId)){
      const target='/projects/'+data.projectId;
      const sessionId=typeof data.sessionId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(data.sessionId)?data.sessionId:'';
      if(sessionId){
        globalThis.__no996PendingSession={projectId:data.projectId,sessionId:sessionId};
        try{dispatchEvent(new CustomEvent('no996-openfilm:select-session',{detail:{projectId:data.projectId,sessionId:sessionId}}))}catch(_){}
      }
      if(location.pathname!==target&&location.pathname!==target+'/'){
        try{
          history.pushState({},'',target);
          dispatchEvent(new PopStateEvent('popstate',{state:{}}));
        }catch(e){try{location.assign(target)}catch(_){}}
      }
    }
    if(data&&typeof data==='object'&&data.type==='no996-openfilm:layout'&&data.version===1){
      const h=globalThis.openfilmHost;
      if(h&&h.panel){
        if(data.side==='left'||data.side==='right'){try{h.panel.setPlacement({side:data.side,libraryDock:'left'})}catch(e){}}
        if(typeof data.width==='number'&&isFinite(data.width)){try{h.panel.setWidth(Math.max(240,Math.min(800,data.width)),true)}catch(e){}}
      }
    }
  });
  report(true);
})();
</script>${officialShell && officialPage ? shellUiInjection() : ''}${theme.injection(themeSurfaceFor(url.pathname, officialShell))}${styleLab}${devHead}`;
    value = value.replace(/<head(?:\s[^>]*)?>/i, match => match + host);
    if (value.includes('__no996Diag')) diag.injected += 1;
    else diag.refusals += 1;
    return value;
  }
  function forward(req, res, film) {
    const refuse = (code) => {
      if (!film && req.method === 'GET' && ['iframe', 'document'].includes(req.headers['sec-fetch-dest'])) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(`无法打开 OpenFilm 工作台 (${code})。请刷新 DSH 后重试。\nUnable to open OpenFilm Studio (${code}). Refresh DSH and retry.`);
      }
      return fail(res);
    };
    // Only navigations, so the log answers "what did the browser actually ask
    // for, and did it still carry the session" without recording every asset.
    const dest = req.headers['sec-fetch-dest'];
    if (!film && req.method === 'GET' && (dest === 'document' || dest === 'iframe')) {
      say.info('nav', { route: req.url.split('?')[0].slice(0, 60), dest, authed: Boolean(req.headers.cookie && req.headers.cookie.includes(cookieName)) });
    }
    const rejection = rejectionReason(req, film);
    if (rejection) return refuse(rejection);
    if (!film && !authenticated(req)) return refuse('OF_SESSION_REQUIRED');
    let url;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return fail(res);
      url = new URL(req.url, 'http://proxy.invalid');
      let path = decodeURIComponent(url.pathname);
      if (path.includes('\\') || path.split('/').some((part) => part === '.' || part === '..')) return fail(res);
      // No aliases or trailing slashes for key-bearing open endpoints.
      path = path.replace(/\/+$/, '') || '/';
      if (film && !/^\/p\/[A-Za-z0-9_-]+(?:\/|$)/.test(path)) return fail(res);
      if (!film && (path === '/open' || path === '/api/open' || path.startsWith('/open/') || path.startsWith('/api/open/'))) return fail(res);
      if (url.searchParams.has('key') || (desktop && (url.searchParams.has('ticket') || path === '/__dsh' || path.startsWith('/__dsh/')))) return fail(res);
    } catch { return fail(res, 400); }
    const target = film ? filmUpstream : editorUpstream;
    const headers = { host: target.host, 'x-studio-key': key, 'accept-encoding': 'identity' };
    for (const [name, value] of Object.entries(req.headers)) if (SAFE_HEADERS.has(name) && value !== undefined) headers[name] = value;
    if (req.headers.origin) headers.origin = film && req.headers.origin === filmOrigin ? filmUpstream.origin : editorUpstream.origin;
    const remote = request({ hostname: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers }, (up) => {
      up.on('error', (error) => {
        say.error('upstream-error', { path: (() => { try { return new URL(req.url, 'http://x').pathname; } catch { return '?'; } })(), message: String(error?.code || error?.message || error) });
        if (!res.destroyed && !res.writableEnded) fail(res, 502);
      });
      const status = up.statusCode || 502;
      if ((status >= 300 && status < 400 && status !== 304) ||
          (status !== 304 && up.headers['content-encoding'] && up.headers['content-encoding'] !== 'identity')) {
        up.resume(); return fail(res, 502);
      }
      const out = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (RESPONSE_HEADERS.has(name) && typeof value === 'string') out[name] = value;
      }
      const forbidden = [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), editorUpstream.origin, filmUpstream.origin, ...(pluginUpstream ? [pluginUpstream.origin] : [])];
      const headerText = JSON.stringify(out);
      if (forbidden.some((value) => headerText.includes(value))) { up.resume(); return fail(res, 502); }
      if (film) {
        // Echo a viewer/editor Origin so the public door can CORS-fetch film assets;
        // navigations without Origin keep the editor surface default.
        const reqOrigin = req.headers.origin;
        out['access-control-allow-origin'] = reqOrigin && isEditorLikeOrigin(reqOrigin) ? reqOrigin : filmEditorOrigin();
        out['x-content-type-options'] = 'nosniff';
      }
      out['cache-control'] = 'no-store';
      out['referrer-policy'] = 'no-referrer';
      const type = String(up.headers['content-type'] ?? '').toLowerCase();
      out['x-content-type-options'] = 'nosniff';
      if (!film && (type.startsWith('image/svg+xml') || (url.pathname.startsWith('/api/') && (type.startsWith('text/html') || type.startsWith('application/xhtml+xml'))))) {
        // User-provided SVG/HTML must not acquire the editor's API origin.
        out['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
      } else if (!film && !relaxedEmbed && (type.startsWith('text/html') || type.startsWith('application/xhtml+xml'))) {
        out['content-security-policy'] = `frame-ancestors ${ancestorsFor(desktop ? webOrigin : web.origin)}`;
      }
      const text = /^(text\/|application\/(json|javascript|xml|x-javascript))/.test(type);
      const stream = !text && (status === 206 || /^(audio\/|video\/|image\/|application\/(?:octet-stream|zip|x-zip-compressed)(?:\s*;|$))/.test(type));
      const noBody = req.method === 'HEAD' || status === 304 || status === 204 || status === 205;
      const needles = forbidden.map((value) => Buffer.from(value));
      const containsForbidden = (body) => needles.some((needle) => body.includes(needle));
      res.once('close', () => { if (!res.writableEnded) up.destroy(); });
      (async () => {
        try {
          if (noBody) {
            // HEAD describes the selected representation; rewritten text has no known length.
            if (req.method === 'HEAD' && status !== 304 && !text && /^\d+$/.test(String(up.headers['content-length'] ?? ''))) {
              out['content-length'] = up.headers['content-length'];
            }
            up.resume();
            res.writeHead(status, out);
            res.end();
            return;
          }
          if (text && status === 206) { up.resume(); return fail(res, 502); }
          if (stream) {
            if (/^\d+$/.test(String(up.headers['content-length'] ?? ''))) out['content-length'] = up.headers['content-length'];
            const tailLength = Math.max(...needles.map((needle) => needle.length)) - 1;
            let tail = Buffer.alloc(0);
            let started = false;
            const write = async (data) => {
              if (!data.length) return;
              if (res.destroyed) throw new Error('Client disconnected');
              if (!started) { res.writeHead(status, out); started = true; }
              if (!res.write(data)) await new Promise((resolve, reject) => {
                const done = () => { res.off('close', closed); resolve(); };
                const closed = () => { res.off('drain', done); reject(new Error('Client disconnected')); };
                res.once('drain', done);
                res.once('close', closed);
              });
            };
            for await (const chunk of up) {
              const data = Buffer.concat([tail, chunk]);
              if (containsForbidden(data)) { up.destroy(); return fail(res, 502); }
              const safeLength = Math.max(0, data.length - tailLength);
              await write(data.subarray(0, safeLength));
              tail = data.subarray(safeLength);
            }
            await write(tail);
            if (!started) res.writeHead(status, out);
            res.end();
            return;
          }
          const chunks = [];
          let length = 0;
          for await (const chunk of up) {
            length += chunk.length;
            if (length > MAX_RESPONSE) { up.destroy(); return fail(res, 502); }
            chunks.push(chunk);
          }
          if (res.destroyed || res.writableEnded) return;
          let finalStatus = status;
          let body = Buffer.concat(chunks);
          if (text) {
            let value = body.toString('utf8');
            if (!Buffer.from(value).equals(body)) return fail(res, 502);
            value = rewriteOrigins(value);
            // XXX surface: replace the curated vendor voice library with 不加班
            // clones + platform voices (see docs/XXX-no996-surface-and-voice.md).
            if (!film && rewriteLibraryVoices && req.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/api/library/voices' && type.includes('application/json') && status === 200) {
              try {
                const payload = await rewriteLibraryVoices();
                if (payload && typeof payload === 'object' && Array.isArray(payload.voices)) {
                  value = JSON.stringify(payload);
                  finalStatus = 200;
                  out['content-type'] = 'application/json; charset=utf-8';
                }
              } catch {
                /* keep upstream body on bridge failure */
              }
            }
            if (status >= 500 && !film) {
              const reqTraceId = traceIdFrom(req, 'http');
              out['x-no996-trace-id'] = reqTraceId;
              recordFailure(req.method, url.pathname, status, value);
              say.warn('upstream-5xx', { method: req.method, path: url.pathname, status });
              recordDiag?.error({
                layer: 'studio-upstream',
                traceId: reqTraceId,
                code: `STUDIO_HTTP_${status}`,
                channel: `${req.method} ${url.pathname}`,
                httpStatus: status,
                location: 'src/studio/studio-proxy.mjs:forward',
                summary: `Studio 上游返回 HTTP ${status} (${url.pathname})`,
                detail: { method: req.method, path: url.pathname, responsePreview: value.slice(0, 600) },
              });
              const friendly = friendlyCommandFailure(value, url.pathname);
              if (friendly) {
                value = friendly.body;
                finalStatus = friendly.status;
                out['content-type'] = 'application/json; charset=utf-8';
              }
            }
            if (film && type.startsWith('text/html')) {
              value = value.replaceAll(`const EDITOR = ${JSON.stringify(editorUpstream.origin)};`, `const EDITOR = ${JSON.stringify(filmEditorOrigin())};`);
            } else if (!film && type.startsWith('text/html') && !url.pathname.startsWith('/api/')) {
              value = await rewriteEditorHtml(value, url, status);
            }
            body = Buffer.from(value);
            delete out.etag;
            delete out['last-modified'];
          }
          if (containsForbidden(body)) return fail(res, 502);
          out['content-length'] = String(body.length);
          res.writeHead(finalStatus, out);
          res.end(body);
        } catch {
          up.destroy();
          if (!res.destroyed && !res.writableEnded) fail(res, 502);
        }
      })();
    });
    remote.on('error', () => fail(res, 502));
    req.on('error', () => remote.destroy());
    res.on('close', () => { if (!res.writableEnded) remote.destroy(); });
    req.pipe(remote);
  }
  // Lets the page notice that the injected overlay changed on disk, so a saved
  // shell-ui.js reaches a long-lived desktop window without reopening the panel.
  function shellVersion(req, res) {
    if (!officialShell || req.url !== '/__dsh/shell-version') return false;
    if (req.method !== 'GET' || !permitted(req, false) || !authenticated(req)) { fail(res); return true; }
    const body = JSON.stringify({ version: shellUiVersion() });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  // Pictures and products named in the transcript.
  //
  // The chat is a page on the editor origin, so a project-relative path there is
  // resolved by the browser against /projects/... (Studio does not serve it) and a
  // product link is offered to the system browser, where the same origin refuses it
  // without the panel session (OF_SESSION_REQUIRED). Both are Host capabilities, not
  // page ones: an image is read from a verified project, and a file is handed to the
  // operating system. Neither route accepts a path it did not validate.
  function projectFile(req, res) {
    if (typeof readProjectFile !== 'function') return false;
    let url;
    try { url = new URL(req.url, 'http://proxy.invalid'); } catch { return false; }
    if (url.pathname !== '/__dsh/project-file') return false;
    const projectId = url.searchParams.get('projectId');
    const relative = url.searchParams.get('path');
    if (typeof authorizeOfficialProject !== 'function' || !['GET', 'HEAD'].includes(req.method) ||
        !permitted(req, false) || !authenticated(req) ||
        (req.headers.origin !== undefined && req.headers.origin !== editorOrigin) ||
        (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) ||
        url.searchParams.size !== 2 || typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(projectId) ||
        typeof relative !== 'string' || !relative || relative.length > 400) {
      fail(res); return true;
    }
    void (async () => {
      try {
        if (await authorizeOfficialProject(req, projectId) !== true) { fail(res); return; }
        const image = await readProjectFile({ projectId, path: relative });
        if (closed || res.destroyed || res.writableEnded) return;
        res.writeHead(200, {
          'content-type': image.type,
          'content-length': image.bytes.byteLength,
          'cache-control': 'private, max-age=60',
          'x-content-type-options': 'nosniff',
          // Even a picture is untrusted input: no scripts, no external loads.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'referrer-policy': 'no-referrer',
        });
        res.end(req.method === 'HEAD' ? undefined : image.bytes);
      } catch {
        fail(res, 404);
      }
    })();
    return true;
  }
  function openFile(req, res) {
    if (typeof openProjectFile !== 'function') return false;
    if (req.url !== '/__dsh/open-file') return false;
    if (typeof authorizeOfficialProject !== 'function' || req.method !== 'POST' ||
        !permitted(req, false) || !authenticated(req) ||
        req.headers.origin !== editorOrigin || !isSameFetchSite(req) ||
        !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      fail(res); return true;
    }
    void (async () => {
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          // One project id and one path: anything larger is not this request.
          if (length > 4096) { fail(res, 413); req.destroy(); return; }
          chunks.push(chunk);
        }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(res, 400); }
        const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
        if (!keys.includes('projectId') || !keys.includes('path') || keys.some(key => !['projectId', 'path', 'reveal'].includes(key)) ||
            typeof value.projectId !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(value.projectId) ||
            typeof value.path !== 'string' || !value.path || value.path.length > 400 ||
            (value.reveal !== undefined && typeof value.reveal !== 'boolean')) {
          return fail(res, 400);
        }
        if (await authorizeOfficialProject(req, value.projectId) !== true) { fail(res); return; }
        await openProjectFile({ projectId: value.projectId, path: value.path, reveal: value.reveal === true });
        if (!res.destroyed && !res.writableEnded) res.writeHead(204, { 'cache-control': 'no-store' }).end();
      } catch {
        if (!res.destroyed && !res.writableEnded) fail(res, 503);
      }
    })();
    return true;
  }
  let clientDiagWindowStart = Date.now();
  let clientDiagCount = 0;
  function clientDiag(req, res) {
    if (!officialShell || req.url !== '/__dsh/client-diag') return false;
    if (req.method !== 'POST' || !permitted(req, false) || !authenticated(req) ||
        req.headers.origin !== editorOrigin || !isSameFetchSite(req) ||
        !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      fail(res); return true;
    }
    const now = Date.now();
    if (now - clientDiagWindowStart > 60_000) {
      clientDiagWindowStart = now;
      clientDiagCount = 0;
    }
    if (clientDiagCount >= 60) { fail(res, 429); return true; }
    clientDiagCount += 1;
    void (async () => {
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 8 * 1024) { fail(res, 413); req.destroy(); return; }
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(res, 400);
        recordDiag?.record({
          level: value.level === 'warn' || value.level === 'info' ? value.level : 'error',
          layer: typeof value.layer === 'string' ? value.layer : 'ui',
          traceId: typeof value.traceId === 'string' ? value.traceId : '',
          code: typeof value.code === 'string' ? value.code : 'UI_ERROR',
          channel: typeof value.channel === 'string' ? value.channel : '',
          httpStatus: Number.isInteger(value.httpStatus) ? value.httpStatus : null,
          projectId: typeof value.projectId === 'string' ? value.projectId : '',
          location: typeof value.location === 'string' ? value.location : '',
          summary: typeof value.summary === 'string' ? value.summary : '',
          detail: value.detail && typeof value.detail === 'object' ? value.detail : null,
        });
        if (!res.destroyed && !res.writableEnded) res.writeHead(204, { 'cache-control': 'no-store' }).end();
      } catch {
        if (!res.destroyed && !res.writableEnded) fail(res, 400);
      }
    })();
    return true;
  }
  // Fixed-channel official Chat RPC rides the existing authenticated editor
  // origin. No renderer-supplied path or upstream secret is accepted here.
  function officialBridge(req, res) {
    if (!officialShell || req.url !== '/__dsh/official-rpc') return false;
    // A browser session alone is not project authority. Until the Host can bind
    // this request to a trusted project scope, reject all project Chat RPCs.
    if (typeof officialRpc !== 'function' || typeof authorizeOfficialProject !== 'function' || req.method !== 'POST' || !permitted(req, false) || !authenticated(req) ||
        req.headers.origin !== editorOrigin || !isSameFetchSite(req) ||
        !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      fail(res); return true;
    }
    // Bound aggregate buffered request data before reading a body; limiting
    // each request alone still allows many concurrent 9 MiB allocations.
    // Named rather than silent: a burst that trips this must be recognizable in
    // the log, not look like a general Studio failure. Archiving a session starts
    // several reads at once, which is what surfaced this cap.
    if (officialRequests >= 6) { say.warn('official-rpc-busy', { inFlight: officialRequests }); fail(res, 503); return true; }
    officialRequests += 1;
    // Which channel a failure belongs to: read from the body once it parses, and
    // reported in the 503 so the page names the culprit rather than the endpoint.
    let pendingChannel = '';
    let pendingPayload = null;
    const traceId = traceIdFrom(req, 'rpc');
    const startedAt = Date.now();
    void (async () => {
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 9 * 1024 * 1024) { fail(res, 413); req.destroy(); return; }
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length !== 2 || typeof value.channel !== 'string' || !Object.hasOwn(value, 'payload')) return fail(res, 400);
        // These fixed channels do not access project data; they still require
        // the editor's authenticated origin, cookie and same-site checks above.
        // `client:log` is here too: it is a page-side diagnostic line about this
        // page itself, it carries no project id, and gating it on a project made
        // the page's own logging fail with an empty 403 body.
        pendingChannel = value.channel;
        pendingPayload = value.payload;
        // Auth is Host-held session state for this editor window — no project scope.
        const needsProject = value.channel !== 'template:list' && value.channel !== 'template:create'
          && value.channel !== 'project:create-blank'
          && value.channel !== 'prefs:get' && value.channel !== 'prefs:set'
          && value.channel !== 'environment:check' && value.channel !== 'environment:fallback-prompt'
          && value.channel !== 'client:log'
          && value.channel !== 'diag:list' && value.channel !== 'diag:export' && value.channel !== 'diag:clear' && value.channel !== 'diag:prefs'
          // Evidence about a drag this page is handling: no project, no data.
          && value.channel !== 'probe:drag'
          && value.channel !== 'auth:status' && value.channel !== 'auth:logout' && value.channel !== 'auth:action'
          && value.channel !== 'account:balance' && value.channel !== 'account:overview'
          && value.channel !== 'account:traces' && value.channel !== 'account:pricing'
          && value.channel !== 'auth:remember-get' && value.channel !== 'auth:remember-set' && value.channel !== 'auth:remember-clear'
          // First-run wizard: no project exists yet, and the ASR routes are
          // install/status only. Gating them on a project made the wizard's
          // checks fail with an empty 403.
          && value.channel !== 'system:check' && value.channel !== 'system:install'
          && value.channel !== 'asr:status' && value.channel !== 'asr:install';
        if (needsProject && await authorizeOfficialProject(req, value.payload?.projectId) !== true) return fail(res);
        const result = await officialRpc(value.channel, value.payload, { traceId });
        if (closed || res.destroyed || res.writableEnded) return;
        const body = Buffer.from(JSON.stringify(result));
        if (body.length > 9 * 1024 * 1024) return fail(res, 502);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-no996-trace-id': traceId, 'content-length': body.length });
        res.end(body);
      } catch (error) {
        // Never forward arbitrary exception text: providers and filesystem errors
        // may contain credentials or private paths. The turn reason is emitted
        // only when it is one of the explicitly recognized fixed values.
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(error.code) ? error.code : 'OFFICIAL_RPC_FAILED';
        // A fixed sentence per known failure, so the bubble says what to do
        // instead of only "503". Constants only: the message never carries the
        // exception text, a path or a provider's words.
        const hint = AGENT_HINTS[code];
        const match = code === 'OFFICIAL_AGENT_TURN_FAILED' && typeof error?.message === 'string'
          ? /^Turn ended without completion \((aborted|blocked|error|max-tokens|interrupted|forked|unknown)\)$/.exec(error.message) : null;
        // Which channel failed, so a 503 in the page names the culprit instead of
        // pointing at the endpoint. Only a channel-shaped name is ever logged.
        const channel = /^[a-z][a-z0-9:._-]{1,48}$/.test(String(pendingChannel)) ? String(pendingChannel) : 'unknown';
        say.warn('official-rpc-failed', { channel, code });
        recordDiag?.error({
          layer: error?.diag?.layer || 'rpc',
          traceId,
          code,
          channel,
          httpStatus: 503,
          durationMs: Date.now() - startedAt,
          projectId: typeof pendingPayload?.projectId === 'string' ? pendingPayload.projectId : '',
          conversation: typeof pendingPayload?.conversation === 'string' ? pendingPayload.conversation : '',
          location: typeof error?.diag?.location === 'string' ? error.diag.location : `src/studio/studio-proxy.mjs:officialBridge(${channel})`,
          summary: `${hint || code} (${channel})`,
          detail: {
            ...(error?.diag && typeof error.diag === 'object' ? error.diag : {}),
            reason: String(error?.diag?.reason || error?.message || code).slice(0, 400),
            payloadKeys: pendingPayload && typeof pendingPayload === 'object' ? Object.keys(pendingPayload).slice(0, 16) : [],
          },
        });
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-no996-trace-id': traceId });
          res.end(match ? `${code}: ${match[1]} (${channel})` : hint ? `${code}: ${hint} (${channel})` : `${code} (${channel})`);
        }
      } finally {
        officialRequests -= 1;
      }
    })();
    return true;
  }
  // Binary files chosen by the user go through the existing Studio import
  // endpoint, not an unrestricted Host filesystem write. A trusted project
  // scope is required independently of the renderer-provided project ID. This
  // gate does not yet restrict Studio's general /api/projects routes: the
  // official shell must remain disabled until that boundary is also addressed.
  function officialUpload(req, res) {
    let url;
    try { url = new URL(req.url, 'http://proxy.invalid'); } catch { return false; }
    if (!officialShell || url.pathname !== '/__dsh/official-upload') return false;
    const values = [...url.searchParams.keys()];
    const projectId = url.searchParams.get('projectId');
    const name = url.searchParams.get('name');
    const size = Number(req.headers['content-length']);
    if (typeof authorizeOfficialProject !== 'function' || req.method !== 'PUT' || !permitted(req, false) || !authenticated(req) ||
        req.headers.origin !== editorOrigin || !isSameFetchSite(req) ||
        String(req.headers['content-type'] || '').toLowerCase() !== 'application/octet-stream' ||
        values.length !== 2 || new Set(values).size !== 2 || !values.includes('projectId') || !values.includes('name') ||
        typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(projectId) ||
        typeof name !== 'string' || !name || name.length > 200 || name.startsWith('.') || /[\\/\\\\<>:\"|?*\\x00-\\x1f\\x7f]/.test(name) || /[. ]$/.test(name) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)/i.test(name) ||
        !Number.isSafeInteger(size) || size < 1) { fail(res); return true; }
    if (size > 256 * 1024 * 1024) { fail(res, 413); return true; }
    if (officialRequests >= 4) { fail(res, 503); return true; }
    officialRequests += 1;
    let remote;
    let released = false;
    const release = () => { if (!released) { released = true; officialRequests -= 1; } };
    res.once('close', () => { if (remote && !res.writableEnded) remote.destroy(); release(); });
    void (async () => {
      try {
        if (await authorizeOfficialProject(req, projectId) !== true || closed || res.destroyed) return fail(res);
        const target = `/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(`assets/upload/${name}`)}`;
        remote = request({ hostname: editorUpstream.hostname, port: editorUpstream.port, method: 'PUT', path: target,
          headers: { host: editorUpstream.host, 'x-studio-key': key, 'content-type': 'application/octet-stream', 'content-length': size, 'accept-encoding': 'identity', origin: editorUpstream.origin } }, up => {
          void (async () => {
            try {
              if (up.statusCode !== 200) { up.resume(); return fail(res, 502); }
              let length = 0;
              const chunks = [];
              for await (const chunk of up) { length += chunk.length; if (length > 65536) { up.destroy(); return fail(res, 502); } chunks.push(chunk); }
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const path = result?.path;
              if (typeof path !== 'string' || !path.startsWith('assets/upload/') || path.includes('\\\\') || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes(key)) return fail(res, 502);
              // Studio commits the file before probing. A failed probe is not a
              // rollback: it may even have reused a pre-existing user file.
              if (result.unreadable) { res.writeHead(422, { 'cache-control': 'no-store' }); res.end(); return; }
              const body = Buffer.from(JSON.stringify({ path }));
              if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': body.length }); res.end(body); }
            } catch { if (!res.destroyed && !res.writableEnded) fail(res, 502); }
          })();
        });
        remote.on('error', () => { if (!res.destroyed && !res.writableEnded) fail(res, 502); });
        let received = 0;
        req.on('data', chunk => { received += chunk.length; if (received > size) { remote.destroy(); req.destroy(); } });
        req.on('aborted', () => remote.destroy());
        req.on('error', () => remote.destroy());
        req.pipe(remote);
      } catch { if (!res.destroyed && !res.writableEnded) fail(res, 503); }
    })();
    return true;
  }
  // Server-sent events for one authorized project. The DSH page cannot reach the
  // editor origin's cookie, so this rides the same authenticated proxy origin
  // as the RPC instead of exposing the Studio port.
  function officialEvents(req, res) {
    let url;
    try { url = new URL(req.url, 'http://proxy.invalid'); } catch { return false; }
    if (!officialShell || url.pathname !== '/__dsh/official-events') return false;
    const projectId = url.searchParams.get('projectId');
    // One optional resume cursor: the last sequence the page applied. Anything else
    // in the query is still refused, so this cannot become a general-purpose route.
    const afterSeq = url.searchParams.get('afterSeq');
    const resume = afterSeq === null || /^\d{1,12}$/.test(afterSeq);
    if (typeof attachOfficialEvents !== 'function' || req.method !== 'GET' || !permitted(req, false) || !authenticated(req) ||
        (req.headers.origin !== undefined && req.headers.origin !== editorOrigin) || !isSameFetchSite(req) ||
        url.searchParams.size > 2 || !resume || typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) {
      fail(res); return true;
    }
    void (async () => {
      try {
        if (await authorizeOfficialProject(req, projectId) !== true || closed || res.destroyed) { fail(res); return; }
        await attachOfficialEvents({ projectId, res, req });
      } catch { if (!res.destroyed && !res.headersSent) fail(res, 503); else if (!res.destroyed) res.end(); }
    })();
    return true;
  }
  function voiceProviders(req, res) {
    if (!voiceSettings) return false;
    let url;
    try { url = new URL(req.url, 'http://proxy.invalid'); } catch { return false; }
    const isState = url.pathname === '/api/providers' && req.method === 'GET';
    const isChoice = url.pathname === '/api/providers/no996-voice-choice' && req.method === 'PUT';
    if (!isState && !isChoice) return false;
    if (!permitted(req, false) || !authenticated(req)) { fail(res); return true; }
    if (isState && ![...url.searchParams.keys()].every(key => key === 'no996VoiceRefresh')) { fail(res, 400); return true; }
    void (async () => {
      try {
        if (closed || res.destroyed || res.writableEnded) return;
        const callStudio = (method, path, body) => studioCall(method, path, body);
        if (isState) {
          const force = url.searchParams.get('no996VoiceRefresh') === '1';
          const reply = await voiceSettings.state(callStudio, { force });
          if (closed || res.destroyed || res.writableEnded) return;
          const body = Buffer.from(JSON.stringify(reply.value ?? { error: 'unavailable' }));
          res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
          res.end(body);
          return;
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 32 * 1024) { fail(res, 413); req.destroy(); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(res, 400); return; }
        const reply = await voiceSettings.choose(input, callStudio);
        if (closed || res.destroyed || res.writableEnded) return;
        const body = Buffer.from(JSON.stringify(reply.value ?? { error: 'unavailable' }));
        res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
        res.end(body);
      } catch {
        if (!res.destroyed && !res.headersSent) fail(res, 503);
        else if (!res.destroyed) res.end();
      }
    })();
    return true;
  }
  const editor = createServer((req, res) => {
    // A project folder is often also a DSH workspace (the project's own
    // conversation). Its watcher keeps Windows from moving the folder to the
    // Recycle Bin, so stop that conversation before Studio tries. Only an
    // authenticated, permitted request may have that side effect. The forward
    // happens either way: a missing registry must not block a delete.
    const deleting = typeof beforeProjectDelete === 'function' && req.method === 'DELETE'
      ? /^\/api\/projects\/([A-Za-z0-9_-]{6,40})\/?$/.exec(req.url || '')
      : null;
    if (deleting && authenticated(req) && permitted(req, false)) {
      Promise.resolve().then(() => beforeProjectDelete(deleting[1])).catch(() => {}).then(() => {
        if (!res.writableEnded && !res.destroyed) forward(req, res, false);
      });
      return;
    }
    const devContext = {
      editorOrigin,
      filmOrigin,
      webOrigin,
      desktop,
      permitted: (r) => permitted(r, false),
      authenticated,
      rewriteHtml: (html, url, status) => rewriteEditorHtml(html, url, status),
      forbiddenNeedles: [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), editorUpstream.origin, filmUpstream.origin],
      ancestors: relaxedEmbed ? '' : ancestorsFor(desktop ? webOrigin : web.origin),
      fail,
    };
    if (typeof activeDevHooks?.handleHttp === 'function') {
      const handled = activeDevHooks.handleHttp(req, res, devContext);
      if (handled) return;
    }
    if (!officialEvents(req, res) && !voiceProviders(req, res) && !officialUpload(req, res) && !clientDiag(req, res) && !shellVersion(req, res) && !projectFile(req, res) && !openFile(req, res) && !officialBridge(req, res) && !desktopBridge(req, res)) forward(req, res, false);
  });
  const plugin = pluginUpstream && createPluginSurfaceProxy(pluginUpstream, () => ({
    editor: editorOrigin, surface: closed ? null : pluginOrigin, upstreamEditor: editorUpstream.origin, viewers,
  }), (method, lane, status) => {
    say.warn('plugin-surface-http', { method, lane, status });
  });
  const film = createServer((req, res) => forward(req, res, true));
  film.on('upgrade', (_req, socket) => socket.destroy());
  editor.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let parsed;
    try { parsed = new URL(req.url, editorOrigin); } catch { return socket.destroy(); }
    if (typeof activeDevHooks?.handleUpgrade === 'function') {
      const upgraded = activeDevHooks.handleUpgrade(req, socket, head, {
        parsed,
        editorOrigin,
        desktop,
        permitted: (r) => permitted(r, false),
        authenticated,
      });
      if (upgraded) return;
    }
    const global = parsed.pathname === '/api/events';
    const project = /^\/api\/projects\/[^/]+\/events$/.test(parsed.pathname);
    if (!permitted(req, false) || req.headers.origin !== editorOrigin || (!global && !project) ||
        parsed.searchParams.has('key') || (desktop && parsed.searchParams.has('ticket')) || parsed.origin !== editorOrigin || req.headers['sec-websocket-version'] !== '13' ||
        typeof req.headers['sec-websocket-key'] !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key']) ||
        String(req.headers.upgrade).toLowerCase() !== 'websocket') return socket.destroy();
    if (!authenticated(req)) return socket.destroy();
    const nonce = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(nonce + WS_GUID).digest('base64');
    const remote = request({ hostname: editorUpstream.hostname, port: editorUpstream.port, path: req.url,
      headers: { host: editorUpstream.host, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': nonce, 'x-studio-key': key, origin: editorUpstream.origin } });
    sockets.add(socket);
    let peer;
    const recheck = setInterval(() => { if (!authenticated(req)) close(); }, 30_000);
    recheck.unref();
    const close = () => { clearInterval(recheck); sockets.delete(socket); socket.destroy(); peer?.destroy(); remote.destroy(); };
    socket.once('close', close);
    remote.on('error', close);
    remote.on('response', (response) => { response.resume(); close(); });
    remote.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      peer.on('error', close);
      peer.once('close', close);
      if (!authenticated(req) || response.headers['sec-websocket-accept'] !== expectedAccept || response.headers['sec-websocket-extensions']) return close();
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const clientFrames = frames(socket, true, (opcode, data) => {
        if (!authenticated(req)) return close();
        if (opcode !== 1 || !global) return close();
        try {
          const value = JSON.parse(data.toString('utf8'));
          if (!value || Object.keys(value).length !== 1 || typeof value.visible !== 'boolean') return close();
          peer.write(wsFrame(1, Buffer.from(JSON.stringify({ visible: value.visible })), true));
        } catch { close(); }
      }, close);
      const serverFrames = frames(peer, false, (opcode, data) => {
        if (!authenticated(req) || opcode !== 1) return close();
        try {
          const value = JSON.parse(data.toString('utf8'));
          if (!value || Array.isArray(value) || typeof value.type !== 'string') return close();
          let text = rewriteOrigins(JSON.stringify(value));
          if (text.includes(key) || text.includes(editorUpstream.origin) || text.includes(filmUpstream.origin)) return close();
          socket.write(wsFrame(1, Buffer.from(text), false));
        } catch { close(); }
      }, close);
      if (head.length) clientFrames(head);
      if (upstreamHead.length) serverFrames(upstreamHead);
    });
    remote.end();
  });
  try {
    // The editor must use the DSH page's hostname so its host-only browser
    // session cookie remains available. Film pages use the other hostname.
    const editorHost = desktop ? '127.0.0.2' : web.hostname;
    const filmHost = editorHost === 'localhost' ? '127.0.0.1' : 'localhost';
    const preferredPort = Number.isInteger(listenPort) && listenPort >= 0 && listenPort < 65536
      ? listenPort
      : Number(process.env.NO996_OPENFILM_EDITOR_PORT || 47822);
    editorOrigin = `http://${editorHost}:${await listen(editor, desktop ? editorHost : '127.0.0.1', preferredPort)}`;
    filmOrigin = `http://${filmHost}:${await listen(film, '127.0.0.1')}`;
    if (plugin) pluginOrigin = `http://${filmHost}:${await listen(plugin, '127.0.0.1')}`;
  } catch {
    await Promise.all([shutdown(editor), shutdown(film), ...(plugin ? [shutdown(plugin)] : [])]);
    throw new Error('Studio proxy could not start');
  }
  // Two Studio calls the template installer needs. They stay inside this module
  // so the Studio key never leaves it.
  function studioCall(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({ hostname: editorUpstream.hostname, port: editorUpstream.port, method, path,
        headers: { host: editorUpstream.host, 'x-studio-key': key, 'accept-encoding': 'identity', origin: editorUpstream.origin,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (reply) => {
        const chunks = [];
        reply.on('data', chunk => { if (chunks.length < 512) chunks.push(chunk); });
        reply.on('end', () => {
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = undefined; }
          resolve({ status: reply.statusCode, value });
        });
      });
      req.on('error', () => reject(new Error('Studio request failed')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  return Object.freeze({
    editorOrigin,
    filmOrigin,
    diagnostics: () => ({ ...diag, mode: officialShell ? 'official' : 'dsh' }),
    async listProjects() {
      const reply = await studioCall('GET', '/api/projects');
      const items = Array.isArray(reply.value) ? reply.value : reply.value?.projects;
      if (reply.status !== 200 || !Array.isArray(items)) throw new Error('Studio project list unavailable');
      return items.map(project => ({ id: String(project.id), path: String(project.path) }));
    },
    async createProject(projectPath) {
      if (typeof projectPath !== 'string' || !projectPath) throw new Error('A project path is required');
      // Opening a folder as a project (projects.mjs openProject): the folder is
      // made when missing, a film.html already there is never touched, and the
      // project joins the library list. The reply is unwrapped leniently so a
      // ({project} | project) shape both work.
      const reply = await studioCall('POST', '/api/projects', { path: projectPath });
      if (reply.status !== 200) throw new Error(`Studio refused the project (HTTP ${reply.status})`);
      const project = reply.value?.project ?? reply.value;
      const id = project?.id ?? project?.projectId;
      if (typeof id !== 'string' || !id) throw new Error('Studio returned no project id');
      return { id, path: typeof project.path === 'string' ? project.path : projectPath };
    },
    issueTicket() {
      const ticket = this.mintTicket();
      if (!ticket) return null;
      return { url: `${editorOrigin}/__dsh/open#${ticket}`, expiresIn: Math.round(ticketLifetime / 1000) };
    },
    /**
     * A one-time grant for opening (or renewing) the frame's own session. Renewal
     * mints the same shape; the difference is only that the frame already holds a
     * session, so the redemption extends it instead of minting a second one.
     */
    mintTicket() {
      prune(tickets);
      if (closed || tickets.size >= maxCredentials) return null;
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, Date.now() + ticketLifetime);
      say.info('ticket-minted', { desktop, pending: tickets.size });
      return ticket;
    },
    bootstrapData() {
      if (desktop) {
        const ticket = this.mintTicket();
        if (!ticket) return null;
        return {
          editorOrigin, ticket,
          sessionExpiresIn: Math.round(sessionLifetime / 1000),
          mode: officialShell ? 'official' : 'dsh', webOrigin,
        };
      }
      return { editorOrigin, mode: officialShell ? 'official' : 'dsh', webOrigin };
    },
    /** Renewal for a frame that is already open; never opens a second session. */
    renewalData() {
      if (!desktop) return null;
      const ticket = this.mintTicket();
      if (!ticket) return null;
      return { ticket, sessionExpiresIn: Math.round(sessionLifetime / 1000) };
    },
    bootstrap(res) {
      if (closed) return fail(res);
      const data = this.bootstrapData();
      if (!data) return fail(res, 503);
      const body = JSON.stringify({ ...data, diagnostics: diag });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    },
    async close() {
      closed = true;
      tickets.clear();
      sessions.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await Promise.all([shutdown(editor), shutdown(film), ...(plugin ? [shutdown(plugin)] : [])]);
    },
  });
}
