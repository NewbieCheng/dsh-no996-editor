(function () {
  if (globalThis.__no996DevBadge) return;
  globalThis.__no996DevBadge = 1;

  var badge = document.createElement('div');
  badge.id = 'no996-dev-hmr-badge';
  badge.style.cssText = [
    'position:fixed',
    'right:10px',
    'bottom:10px',
    'z-index:2147483640',
    'display:inline-flex',
    'align-items:center',
    'gap:6px',
    'padding:4px 9px',
    'border-radius:999px',
    'background:rgba(17,24,39,.86)',
    'border:1px solid rgba(255,255,255,.16)',
    'color:#e5e7eb',
    'font:11px/1.3 ui-monospace,Consolas,monospace',
    'backdrop-filter:blur(6px)',
    'box-shadow:0 4px 14px rgba(0,0,0,.35)',
    'pointer-events:auto',
    'user-select:none',
  ].join(';');

  var dot = document.createElement('span');
  dot.style.cssText = 'width:7px;height:7px;border-radius:999px;background:#22c55e;flex:none;';
  var label = document.createElement('span');
  label.textContent = 'DEV HMR · 已连接';
  badge.appendChild(dot);
  badge.appendChild(label);

  function mount() {
    var parent = document.body || document.documentElement;
    if (parent && !badge.isConnected) parent.appendChild(badge);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  function stamp() {
    return new Date().toTimeString().slice(0, 8);
  }

  function setStatus(color, text) {
    dot.style.background = color;
    label.textContent = text;
  }

  async function refreshThemeCss() {
    try {
      var res = await fetch('/__dsh/dev/theme.css?path=' + encodeURIComponent(location.pathname) + '&t=' + Date.now(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return;
      var css = await res.text();
      var el = document.querySelector('style[data-no996-theme]');
      if (!el) {
        el = document.createElement('style');
        el.setAttribute('data-no996-theme', 'live');
        document.head.appendChild(el);
      }
      el.textContent = css;
      setStatus('#22c55e', 'DEV HMR · 样式热更新 ' + stamp());
    } catch (_) {
      setStatus('#f59e0b', 'DEV HMR · 样式拉取失败');
    }
  }

  function connectLive() {
    if (typeof EventSource !== 'function') return;
    var es = new EventSource('/__dsh/dev/live');
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'connected') {
        setStatus('#22c55e', 'DEV HMR · 已连接');
      } else if (msg.type === 'theme') {
        void refreshThemeCss();
      } else if (msg.type === 'shell-ui') {
        setStatus('#38bdf8', 'DEV HMR · shell-ui 更新，重载中…');
        setTimeout(function () { location.reload(); }, 80);
      } else if (msg.type === 'client-js') {
        setStatus('#38bdf8', 'DEV HMR · client.js 已重建 ' + stamp());
      } else if (msg.type === 'host-stale') {
        setStatus('#f59e0b', 'DEV HMR · Host 源码已改，请重载插件 (' + (msg.file || 'src') + ')');
      } else if (msg.type === 'vite-error') {
        setStatus('#ef4444', 'DEV HMR · Vite 错误');
      }
    };
    es.onerror = function () {
      setStatus('#f59e0b', 'DEV HMR · 重连中…');
    };
  }
  connectLive();
})();
