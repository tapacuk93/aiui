// aiui — circles UI driven by an AI that knows it lives in this webview.
'use strict';

const $ = (s) => document.querySelector(s);
const el = {
  path: $('#path'), title: $('#title'), message: $('#message'),
  circles: $('#circles'), view: $('#view'), write: $('#write'),
  status: $('#status'), go: $('#go'), toast: $('#toast'),
  prev: $('#prev'), more: $('#more'), stage: $('#stage'), close: $('#close'),
};

// Human capabilities, each backed by technical ones.
const ROOT = {
  kind: 'circles',
  more: true,     // expandable: shows More
  infinite: true, // infinite things to do: never runs out, further pages come from the AI pager
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
const paging = { loading: false, failed: false, token: 0, n: 0 };

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
  memory: {
    search: (q) => call('cache', { op: 'search', q }).then((r) => r.results),
    stats: () => call('cache', { op: 'stats' }),
  },
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
    const { screen, cached } = await call('ai', payload);
    if (my !== seq) return; // cancelled or superseded
    if (cached) flashStatus('from memory');
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
  if (s.circles) {
    const ids = new Set();
    s.circles = s.circles.map((c, i) => {
      let id = String(c.id || 'c' + i);
      while (ids.has(id)) id += '_';
      ids.add(id);
      return { ...c, id };
    });
  }
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
  else updatePager();
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
  paging.failed = false;
  wantNext = false;
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
  layoutPages();
}

function renderCircles(s) {
  (s.circles || []).forEach((c) => {
    if (c.removed) return;
    el.circles.appendChild(circleEl(c, 0));
  });
}

// ---------------------------------------------------------------- pages
// No scrolling: circles that don't fit go to further pages. "More" shows the next page
// (asking the AI pager for one when the set is open-ended); "Back" appears after page one.

let pages = [];      // arrays of circle nodes
let wantNext = false; // More was pressed while the next page was still loading

// Pages the user has seen are frozen: circles loaded later never slip into them, they
// always start a new page behind More. A window resize re-flows everything.
function layoutPages(reflow) {
  const s = current.screen;
  if (s.kind !== 'circles') { pages = []; return updatePager(); }
  const nodes = [...el.circles.children].filter((n) => !n.classList.contains('leaving'));
  if (reflow) s.frozen = null;
  const firstShown = nodes.find((n) => !n.hidden);

  const byId = new Map(nodes.map((n) => [n.dataset.id, n]));
  const frozen = (s.frozen || []).map((ids) => ids.map((id) => byId.get(id)).filter(Boolean)).filter((p) => p.length);
  const taken = new Set(frozen.flat());
  const rest = nodes.filter((n) => !taken.has(n));

  pages = [...frozen, ...paginate(rest, nodes)];
  if (reflow && firstShown) {
    const i = pages.findIndex((p) => p.includes(firstShown));
    if (i >= 0) s.page = i;
  }
  s.page = Math.max(0, Math.min(s.page || 0, pages.length - 1));
  showPage();
}

// Splits `subset` into pages by measuring rows with only that subset laid out.
function paginate(subset, all) {
  if (!subset.length) return [];
  const keep = new Set(subset);
  all.forEach((n) => { n.hidden = !keep.has(n); });
  const cs = getComputedStyle(el.stage);
  const avail = el.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 48;
  const gap = parseFloat(getComputedStyle(el.circles).rowGap) || 0;
  const rows = [];
  for (const n of subset) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(n.offsetTop - last.top) < 3) {
      last.nodes.push(n);
      last.h = Math.max(last.h, n.offsetHeight);
    } else rows.push({ top: n.offsetTop, h: n.offsetHeight, nodes: [n] });
  }
  const out = [];
  let cur = [], used = 0;
  for (const r of rows) {
    if (cur.length && used + gap + r.h > avail) { out.push(cur); cur = []; used = 0; }
    used += (cur.length ? gap : 0) + r.h;
    cur.push(...r.nodes);
  }
  if (cur.length) out.push(cur);
  return out;
}

function showPage() {
  const s = current.screen;
  pages.forEach((p, i) => p.forEach((n, j) => {
    const on = i === s.page;
    if (on && n.dataset.shown !== String(s.page)) n.style.setProperty('--i', j); // stagger the entrance
    n.hidden = !on;
    if (on) n.dataset.shown = String(s.page);
  }));
  // Freeze every page up to the one shown.
  s.frozen = pages.slice(0, (s.page || 0) + 1).map((p) => p.map((n) => n.dataset.id));
  updatePager();
}

function lastPage() { return Math.max(0, pages.length - 1); }

// More: on every screen the AI marks expandable (`more`), and whenever circle pages remain.
// Back: after paging forward, or when the AI says the context needs it (`back`).
function updatePager() {
  const s = current.screen;
  const circles = s.kind === 'circles';
  const page = s.page || 0;
  el.prev.classList.toggle('on', (circles && page > 0) || (!!s.back && stack.length > 0));
  el.more.classList.toggle('on', (circles && page < lastPage()) || !!s.more);
  el.more.classList.toggle('loading', circles && page >= lastPage() && paging.loading && wantNext);
  maybePreload();
}

function nextPage() {
  const s = current.screen;
  if (s.kind !== 'circles') {
    // Non-circle screens grow by asking the AI to extend them.
    if (s.more) ask({ event: 'more' }, { label: 'More' });
    return;
  }
  if ((s.page || 0) < lastPage()) { s.page = (s.page || 0) + 1; showPage(); return; }
  if (!s.more) return;
  wantNext = true;
  paging.failed = false;
  if (!paging.loading) loadMore(); else updatePager();
}

function prevPage() {
  const s = current.screen;
  if (s.kind !== 'circles' || !(s.page > 0)) return false;
  s.page -= 1;
  wantNext = false;
  showPage();
  return true;
}

// Keep one full page ready beyond the one shown.
function maybePreload() {
  const s = current.screen;
  if (s.kind !== 'circles' || !s.more || paging.loading || paging.failed || busy) return;
  const page = s.page || 0, last = lastPage();
  const capacity = Math.max(...pages.map((p) => p.length), 1);
  const nextReady = last > page + 1 || (last === page + 1 && pages[last].length >= capacity);
  if (!nextReady) loadMore();
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
    fresh.forEach((c) => {
      c = { ...c, id: (c.id || 'c') + '~p' + (++paging.n) };
      screen.circles.push(c);
      const node = circleEl(c, 0);
      node.hidden = true;
      el.circles.appendChild(node);
    });
    if (!screen.infinite && page.more === false && !fresh.length) screen.more = false;
    else if (!fresh.length) paging.failed = true; // nothing new this time: wait for a More press
  } catch (e) {
    // Keep More: a press retries. Only stop preloading in the background.
    if (tok === paging.token && e.message !== 'cancelled') {
      paging.failed = true;
      if (wantNext) toast(e.message);
    }
  } finally {
    if (tok === paging.token) {
      paging.loading = false;
      const advance = wantNext;
      wantNext = false;
      layoutPages();
      if (advance && (screen.page || 0) < lastPage()) { screen.page += 1; showPage(); }
    }
  }
}

el.prev.addEventListener('click', (e) => { e.stopPropagation(); if (!prevPage()) back(); });
el.more.addEventListener('click', (e) => { e.stopPropagation(); nextPage(); });
let lastStageSize = '';
new ResizeObserver(() => {
  const size = el.stage.clientWidth + 'x' + el.stage.clientHeight;
  if (size === lastStageSize) return;
  lastStageSize = size;
  layoutPages(true);
}).observe(el.stage);

function circleEl(c, i) {
  const node = document.createElement('div');
  node.className = 'circle' + (c.selected ? ' selected' : '');
  node.dataset.id = c.id;
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
    node.addEventListener('animationend', () => { node.remove(); updateGo(); layoutPages(); }, { once: true });
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
  const fresh = circleEl(c, 0);
  fresh.style.animation = 'none';
  fresh.dataset.shown = node.dataset.shown || '';
  fresh.hidden = node.hidden;
  node.replaceWith(fresh);
  pages = pages.map((p) => p.map((n) => (n === node ? fresh : n)));
  updateGo();
}

// The app's theme variables, resolved for the current appearance (light or dark).
const THEME_VARS = ['color-scheme', '--bg', '--fg', '--muted', '--faint', '--accent', '--on-accent', '--surface',
  '--line', '--line-strong', '--chip', '--danger', '--accent-soft', '--accent-glow'];
function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  return THEME_VARS.map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(';');
}

// Re-theme AI-generated views when the system appearance flips.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const f of el.view.querySelectorAll('iframe')) {
    const root = f.contentDocument && f.contentDocument.documentElement;
    if (root) root.style.cssText += ';' + themeVars();
  }
});

function renderHTML(s) {
  const frame = document.createElement('iframe');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; autoplay; fullscreen; microphone; camera; geolocation');
  const base = `<meta charset="utf-8"><style>
    :root{${themeVars()}}
    html,body{margin:0;background:transparent;color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    body{padding:${s.title ? 120 : 64}px 48px 120px;max-width:1100px;margin:0 auto}
    a{color:var(--accent)} ::selection{background:var(--accent-soft)}
    ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
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
  el.write.placeholder = current.screen.kind === 'text' ? '' : 'Type anything — Enter to send, Esc to close';
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

// Esc always gets out of typing: cancels a pending send, closes and clears the text area
// (on an AI text screen it leaves the screen).
function escapeWriting() {
  if (busy) cancel();
  if (current.screen.kind === 'text') { stopWriting(true); back(); }
  else stopWriting(true);
}

el.close.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); escapeWriting(); });

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
    escapeWriting();
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
  if (t === el.write || t.closest('.circle, #nav, #view iframe, #toast, #close')) return;
  if (current.screen.kind === 'html' && t.closest('#view')) return;
  e.preventDefault();
  startWriting(e.clientX, e.clientY);
});

// ---------------------------------------------------------------- keys

function isEditable(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (e.key === 'Escape' && writing) { e.preventDefault(); return escapeWriting(); }
  if (isEditable(e.target)) return;
  if (e.key === 'Backspace' || (e.metaKey && e.key === '[')) {
    e.preventDefault();
    if (!busy && !writing && prevPage()) return;
    back();
  } else if (e.key === 'Escape') {
    if (busy) cancel();
  } else if (/^(ArrowRight|ArrowDown|PageDown)$/.test(e.key) && current.screen.kind === 'circles') {
    e.preventDefault();
    nextPage();
  } else if (/^(ArrowLeft|ArrowUp|PageUp)$/.test(e.key) && current.screen.kind === 'circles') {
    e.preventDefault();
    prevPage();
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

let flashTimer;
function flashStatus(text) {
  el.status.textContent = text;
  document.body.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => document.body.classList.remove('flash'), 1400);
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), 6000);
}

render();
