// aiui — circles UI driven by an AI that knows it lives in this webview.
'use strict';

const $ = (s) => document.querySelector(s);
const el = {
  path: $('#path'), title: $('#title'), message: $('#message'),
  circles: $('#circles'), view: $('#view'), write: $('#write'),
  status: $('#status'), go: $('#go'), toast: $('#toast'),
  up: $('#up'), down: $('#down'),
};

// Human capabilities, each backed by technical ones.
const ROOT = {
  kind: 'circles',
  more: true, // infinite things to do: further pages come from the AI pager
  circles: [
    { id: 'create',   icon: '✨', label: 'Create',   hint: 'docs, images, code' },
    { id: 'search',   icon: '🔍', label: 'Search',   hint: 'files, web, mail' },
    { id: 'read',     icon: '📖', label: 'Read',     hint: 'articles, docs, mail' },
    { id: 'write',    icon: '✍️', label: 'Write',    hint: 'notes, messages, posts' },
    { id: 'talk',     icon: '💬', label: 'Talk',     hint: 'people, messages' },
    { id: 'play',     icon: '🎧', label: 'Play',     hint: 'music, video, podcasts' },
    { id: 'organize', icon: '🗂️', label: 'Organize', hint: 'files, photos, tasks' },
    { id: 'plan',     icon: '📅', label: 'Plan',     hint: 'calendar, reminders' },
    { id: 'remember', icon: '🧠', label: 'Remember', hint: 'notes, ideas, links' },
    { id: 'learn',    icon: '🎓', label: 'Learn',    hint: 'explain, teach, quiz' },
    { id: 'build',    icon: '🛠️', label: 'Build',    hint: 'code, scripts, automations' },
    { id: 'control',  icon: '🎛️', label: 'Control',  hint: 'apps, settings, devices' },
    { id: 'fix',      icon: '🩺', label: 'Fix',      hint: 'problems, errors, cleanup' },
    { id: 'share',    icon: '📤', label: 'Share',    hint: 'send, publish, export' },
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

let stack = [];                       // previous {screen, label}
let current = { screen: clone(ROOT), label: null };
let busy = false;
let writing = false;
let pendingCircle = null;
let seq = 0;                          // id of the AI turn currently wanted
const paging = { loading: false, token: 0, n: 0 };

// ---------------------------------------------------------------- API bridge

async function call(name, body) {
  const r = await fetch('/api/' + name, { method: 'POST', body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

window.aiui = {
  call,
  sys: (op) => call('sys', op),
  next: (data) => ask({ event: 'html', data }, { label: data && data.label }),
  back: () => back(),
  home: () => home(),
  get screen() { return current.screen; },
  _event(e) {
    if (e.type === 'progress') el.status.textContent = e.text;
  },
};

// ---------------------------------------------------------------- AI turns

function summary(screen) {
  const s = { kind: screen.kind };
  for (const k of ['title', 'message', 'go']) if (screen[k]) s[k] = screen[k];
  if (screen.circles) {
    s.circles = screen.circles.filter((c) => !c.removed).map(circleSummary);
    const removed = screen.circles.filter((c) => c.removed).map((c) => c.label);
    if (removed.length) s.removed = removed;
  }
  if (screen.kind === 'text') s.text = el.write.value;
  if (screen.kind === 'html') s.html = '(AI-generated view)';
  return s;
}

function circleSummary(c) {
  const o = { id: c.id, label: c.label };
  if (c.hint) o.hint = c.hint;
  if (c.selected) o.selected = true;
  if (c.value != null) o.value = c.value;
  return o;
}

async function ask(evt, { label, replace = false, circle = null } = {}) {
  if (busy) await cancel();
  const payload = {
    ...evt,
    path: [...stack.map((e) => e.label), current.label].filter(Boolean),
    screen: summary(current.screen),
  };
  const my = ++seq;
  setBusy(true, circle);
  try {
    const { screen } = await call('ai', payload);
    if (my !== seq) return; // cancelled or superseded
    const next = normalize(screen);
    if (replace) {
      current.screen = next;
    } else {
      stack.push(current);
      current = { screen: next, label: label || next.title || evt.event };
    }
    stopWriting(true);
    render();
  } catch (e) {
    if (my === seq) toast(e.message);
  } finally {
    if (my === seq) setBusy(false);
  }
}

function normalize(s) {
  s = s && typeof s === 'object' ? s : {};
  if (!s.kind) s.kind = s.html ? 'html' : s.circles ? 'circles' : 'text';
  if (s.circles) s.circles = s.circles.map((c, i) => ({ id: c.id || 'c' + i, ...c }));
  return s;
}

async function cancel() {
  if (!busy) return;
  seq++;
  setBusy(false);
  try { await call('cancel'); } catch {}
}

function setBusy(on, circle) {
  busy = on;
  document.body.classList.toggle('busy', on);
  if (pendingCircle) pendingCircle.classList.remove('pending');
  pendingCircle = on ? circle : null;
  if (pendingCircle) pendingCircle.classList.add('pending');
  if (on) el.status.textContent = 'thinking';
  else requestAnimationFrame(updatePager);
}

// ---------------------------------------------------------------- navigation

function back() {
  if (busy) return cancel();
  if (writing && current.screen.kind !== 'text') return stopWriting();
  if (!stack.length) return;
  current = stack.pop();
  stopWriting(true);
  render();
}

function home() {
  cancel();
  stack = [];
  current = { screen: clone(ROOT), label: null };
  stopWriting(true);
  render();
}

// ---------------------------------------------------------------- render

function render() {
  const s = current.screen;
  paging.token++;
  paging.loading = false;
  const labels = [...stack.map((e) => e.label), current.label].filter(Boolean);
  el.path.innerHTML = labels.map((l) => `<span>${esc(l)}</span>`).join('');
  el.title.textContent = s.title || '';
  el.message.textContent = s.message || '';
  document.body.classList.toggle('has-title', !!s.title);
  document.body.classList.remove('mode-circles', 'mode-text', 'mode-html');
  document.body.classList.add('mode-' + s.kind);

  el.circles.innerHTML = '';
  el.view.innerHTML = '';

  if (s.kind === 'circles') renderCircles(s);
  else if (s.kind === 'html') renderHTML(s);
  else if (s.kind === 'text') startWriting(null, null, s.text || '');
  updateGo();
  requestAnimationFrame(updatePager);
}

function renderCircles(s) {
  (s.circles || []).forEach((c, i) => {
    if (c.removed) return;
    el.circles.appendChild(circleEl(c, i));
  });
  el.circles.scrollTop = s.scrollTop || 0;
}

// ---------------------------------------------------------------- paging

function updatePager() {
  const s = current.screen, c = el.circles;
  const circles = s.kind === 'circles';
  const canUp = c.scrollTop > 4;
  const canDown = c.scrollTop + c.clientHeight < c.scrollHeight - 4;
  el.up.classList.toggle('on', circles && canUp);
  el.down.classList.toggle('on', circles && (canDown || (!!s.more && paging.loading)));
  el.down.classList.toggle('loading', circles && !canDown && paging.loading);
  if (circles) s.scrollTop = c.scrollTop;
  maybeLoadMore();
}

// Preload the next page whenever less than one screen of circles is left below.
function maybeLoadMore() {
  const s = current.screen, c = el.circles;
  if (s.kind !== 'circles' || !s.more || paging.loading || busy) return;
  const remaining = c.scrollHeight - (c.scrollTop + c.clientHeight);
  if (remaining > c.clientHeight) return;
  loadMore();
}

async function loadMore() {
  const screen = current.screen;
  const tok = ++paging.token;
  paging.loading = true;
  updatePager();
  try {
    const page = await call('more', {
      path: [...stack.map((e) => e.label), current.label].filter(Boolean),
      screen: summary(screen),
    });
    if (tok !== paging.token || screen !== current.screen) return;
    const seen = new Set(screen.circles.map((c) => c.label.toLowerCase()));
    const fresh = (page.circles || []).filter((c) => c && c.label && !seen.has(c.label.toLowerCase()));
    fresh.forEach((c, i) => {
      c = { ...c, id: (c.id || 'c') + '~p' + (++paging.n) };
      screen.circles.push(c);
      el.circles.appendChild(circleEl(c, i));
    });
    screen.more = page.more !== false && fresh.length > 0;
  } catch (e) {
    if (tok === paging.token && e.message !== 'cancelled') {
      screen.more = false;
      toast(e.message);
    }
  } finally {
    if (tok === paging.token) {
      paging.loading = false;
      requestAnimationFrame(updatePager);
    }
  }
}

function page(dir) {
  el.circles.scrollBy({ top: dir * el.circles.clientHeight * 0.85 });
}

el.up.addEventListener('click', (e) => { e.stopPropagation(); page(-1); });
el.down.addEventListener('click', (e) => { e.stopPropagation(); page(1); });
el.up.addEventListener('mousedown', (e) => e.stopPropagation());
el.down.addEventListener('mousedown', (e) => e.stopPropagation());
el.circles.addEventListener('scroll', updatePager, { passive: true });
new ResizeObserver(updatePager).observe(el.circles);

function circleEl(c, i) {
  const node = document.createElement('div');
  node.className = 'circle' + (c.selected ? ' selected' : '');
  node.style.setProperty('--i', i);
  const size = Math.max(0.7, Math.min(1.5, Number(c.size) || 1));
  node.style.setProperty('--s', size);
  node.title = c.hint || '';
  const showValue = c.value != null && (c.plus === 'increment' || c.minus === 'decrement' || c.value > 1);
  node.innerHTML = `
    <button class="ear minus" type="button" title="Remove / reduce">×</button>
    <div class="face">
      ${c.icon ? `<span class="icon">${esc(c.icon)}</span>` : ''}
      <span class="label">${esc(c.label)}</span>
      ${c.hint && size >= 0.9 ? `<span class="hint">${esc(c.hint)}</span>` : ''}
      ${showValue ? `<span class="value">${esc(String(c.value))}</span>` : ''}
    </div>
    <button class="ear plus" type="button" title="Add / select / increase">+</button>`;

  node.querySelector('.minus').addEventListener('click', (e) => { e.stopPropagation(); minus(c, node); });
  node.querySelector('.plus').addEventListener('click', (e) => { e.stopPropagation(); plus(c, node); });
  node.querySelector('.face').addEventListener('click', (e) => {
    e.stopPropagation();
    // Shift/Cmd-click selects instead of opening.
    if (e.shiftKey || e.metaKey) return toggleSelect(c, node);
    ask({ event: 'open', target: circleSummary(c) }, { label: c.label, circle: node });
  });
  return node;
}

function toggleSelect(c, node) {
  c.selected = !c.selected;
  refresh(c, node);
}

function minus(c, node) {
  const mode = c.minus || 'remove';
  if (mode === 'decrement' && c.value > 0) c.value -= 1;
  else if (c.selected) { c.selected = false; if (c.value > 1 && mode !== 'decrement') c.value = null; }
  else if (c.value > 0 && mode !== 'remove') c.value -= 1;
  else if (mode === 'deselect') return;
  else {
    c.removed = true;
    node.classList.add('leaving');
    node.addEventListener('animationend', () => { node.remove(); updateGo(); updatePager(); }, { once: true });
    return;
  }
  refresh(c, node);
}

function plus(c, node) {
  const mode = c.plus || 'select';
  if (mode === 'more') {
    return ask({ event: 'more', target: circleSummary(c) }, { replace: true, circle: node });
  }
  if (mode === 'increment') c.value = (Number(c.value) || 0) + 1;
  else if (!c.selected) c.selected = true;
  else c.value = (Number(c.value) || 1) + 1; // select again = more of it
  refresh(c, node);
}

function refresh(c, node) {
  const i = node.style.getPropertyValue('--i');
  const fresh = circleEl(c, i);
  fresh.style.animation = 'none';
  node.replaceWith(fresh);
  updateGo();
}

function renderHTML(s) {
  const frame = document.createElement('iframe');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; autoplay; fullscreen; microphone; camera; geolocation');
  const base = `<meta charset="utf-8"><style>
    html,body{margin:0;background:transparent;color:#e8e8ee;font:15px/1.55 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    body{padding:${s.title ? 120 : 64}px 48px 120px;max-width:1100px;margin:0 auto}
    a{color:#7c9cff} ::selection{background:rgba(124,156,255,.35)}
    ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}
  </style><script>window.aiui = parent.aiui;<\/script>`;
  let html = String(s.html || '');
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + base);
  else html = `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:|file:|tel:)/i.test(href)) {
        e.preventDefault();
        aiui.sys({ op: 'open', target: href }).catch((err) => toast(err.message));
      }
    });
  });
  el.view.appendChild(frame);
}

// ---------------------------------------------------------------- Go

function anySelected() {
  return (current.screen.circles || []).some((c) => c.selected && !c.removed);
}

function updateGo() {
  const s = current.screen;
  const text = el.write.value.trim();
  let label = null;
  if (writing && text) label = s.kind === 'text' && s.go ? s.go : 'Send';
  else if (s.go) label = s.go;
  else if (anySelected()) label = 'Go';
  el.go.textContent = label || 'Go';
  document.body.classList.toggle('show-go', !!label);
}

el.go.addEventListener('click', (e) => {
  e.stopPropagation();
  if (writing && el.write.value.trim()) return submitText();
  ask({ event: 'go' }, { label: current.screen.go || 'Go' });
});

// ---------------------------------------------------------------- writing

function startWriting(x, y, text) {
  writing = true;
  const w = innerWidth, h = innerHeight;
  const px = x == null ? 60 : Math.max(60, Math.min(x, w - 320));
  const py = y == null ? (current.screen.title ? 130 : 90) : Math.max(90, Math.min(y - 14, h - 220));
  el.write.style.setProperty('--px', px + 'px');
  el.write.style.setProperty('--py', py + 'px');
  if (text != null) el.write.value = text;
  el.write.placeholder = current.screen.kind === 'text' ? '' : 'Type anything — Enter to send';
  document.body.classList.add('writing');
  el.write.focus();
  updateGo();
}

function stopWriting(clear) {
  writing = false;
  document.body.classList.remove('writing');
  if (clear) el.write.value = '';
  el.write.blur();
  updateGo();
}

function submitText() {
  const text = el.write.value.trim();
  if (!text) return;
  ask({ event: 'text', text }, { label: text.length > 28 ? text.slice(0, 26) + '…' : text });
}

el.write.addEventListener('input', updateGo);
el.write.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitText();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (busy) cancel();
    else if (current.screen.kind === 'text') back();
    else stopWriting();
  } else if (e.key === 'Backspace' && !el.write.value && current.screen.kind !== 'text') {
    e.preventDefault();
    stopWriting();
  }
  e.stopPropagation();
});

// Any empty place on screen becomes a text input at the click point.
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const t = e.target;
  if (t === el.write || t.closest('.circle, #go, #pager, #view iframe, #toast')) return;
  if (current.screen.kind === 'html' && t.closest('#view')) return;
  e.preventDefault();
  startWriting(e.clientX, e.clientY);
});

// ---------------------------------------------------------------- keys

function isEditable(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (isEditable(e.target)) return;
  if (e.key === 'Backspace' || (e.metaKey && e.key === '[')) {
    e.preventDefault();
    back();
  } else if (e.key === 'Escape') {
    if (busy) cancel();
  } else if ((e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'ArrowUp' || e.key === 'PageUp')
             && current.screen.kind === 'circles') {
    e.preventDefault();
    page(e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : -1);
  } else if (e.key === 'Enter' && (e.metaKey || current.screen.go || anySelected())) {
    if (current.screen.kind !== 'html' || e.metaKey) { e.preventDefault(); el.go.click(); }
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && current.screen.kind !== 'html') {
    // Typing anywhere starts writing.
    startWriting(null, null);
  }
}
document.addEventListener('keydown', onKey);

// ---------------------------------------------------------------- misc

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), 6000);
}

render();
