// aiui — circles UI driven by an AI that knows it lives in this webview.
'use strict';

const $ = (s) => document.querySelector(s);
const el = {
  path: $('#path'), title: $('#title'), message: $('#message'),
  circles: $('#circles'), view: $('#view'), write: $('#write'),
  status: $('#status'), go: $('#go'), toast: $('#toast'),
  prev: $('#prev'), more: $('#more'), stage: $('#stage'), close: $('#close'), top: $('#top'), who: $('#who'),
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
let pendingCircle = null;
let seq = 0;                          // id of the AI turn currently wanted
const paging = { loading: false, failed: false, token: 0, n: 0 };

// ---------------------------------------------------------------- API bridge

// Inside the Mac app the page is served from aiui:// and /api/* is native. Anywhere else this is
// the web version, answered by WebBackend (backend.js) in the browser.
const NATIVE = location.protocol === 'aiui:';
document.documentElement.classList.toggle('web', !NATIVE);

async function call(name, body) {
  if (!NATIVE) return WebBackend.call(name, body || {}, (text) => aiui._event({ type: 'progress', text }));
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
  setup: () => showSetup(),
  profile: () => showProfile([]),
  get screen() { return current.screen; },
  _event(e) {
    if (e.type !== 'progress') return;
    el.status.textContent = e.text;
    // The circle being opened shows what is happening inside it.
    const hint = pendingCircle && pendingCircle.querySelector('.progress');
    if (hint) hint.textContent = e.text;
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
    language: LANG,
  };
  const att = attentionSummary(current.screen);
  if (att.length) payload.attention = att;
  if (who.guest) payload.guest = true;
  if (who.suspect) payload.userCheck = { suspect: true, reasons: who.suspect };
  const my = ++seq;
  setBusy(true, circle);
  try {
    const { screen, cached, savedUtility } = await call('ai', payload);
    if (my !== seq) return; // cancelled or superseded
    if (!cached) learnSoon();
    if (savedUtility) {
      setTimeout(() => flashStatus('🧰 ' + [...savedUtility.path, savedUtility.name].join(' › ')), 300);
      initLibrary();
initUser();
    }
    if (cached) flashStatus(t('fromMemory'));
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
    if (my === seq) {
      if (e.message === 'no-ai') { setBusy(false); return showSetup(); }
      toast(e.message);
    }
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
  if (pendingCircle) {
    pendingCircle.classList.remove('pending');
    const p = pendingCircle.querySelector('.progress'); if (p) p.remove();
  }
  pendingCircle = on ? circle : null;
  if (pendingCircle) {
    pendingCircle.classList.add('pending');
    const p = document.createElement('span');
    p.className = 'progress';
    p.textContent = t('thinking');
    pendingCircle.querySelector('.face').appendChild(p);
  }
  if (on) el.status.textContent = t('thinking');
  else updatePager();
}

// ---------------------------------------------------------------- AI provider setup
// Local screens (no AI involved): pick a detected agent CLI, or paste an API key of any provider.

function push(screen, label) {
  stack.push(current);
  current = { screen, label };
  stopWriting(true);
  render();
}

async function showSetup() {
  let st;
  try { st = await call('engine', { op: 'status' }); } catch (e) { return toast(e.message); }
  const circles = (st.options || []).map((o) => ({
    id: 'use:' + o.id, label: o.label, icon: o.kind === 'cli' ? '⌨️' : '🔑',
    hint: o.kind === 'cli' ? 'agent CLI on this Mac' : 'saved API key',
    selected: !!(st.active && st.active.id === o.id),
  }));
  circles.push({ id: 'key', label: 'API Key', icon: '🔑', hint: 'any provider', size: 1.1 });
  if ((st.options || []).some((o) => o.kind === 'key')) circles.push({ id: 'forget', label: 'Forget Key', icon: '🗑️', size: 0.8 });
  push({
    kind: 'circles', local: 'setup', more: false, back: stack.length > 0,
    title: st.active ? 'AI' : 'Connect an AI',
    message: !NATIVE
      ? (st.active ? `Using ${st.active.label}. ` : '') +
        'Web version: your API key stays in this browser and goes only to its provider. No system access here — the AI UI Mac app has it.'
      : st.active
        ? `Using ${st.active.label}. Pick another, or add an API key.`
        : 'No AI command-line tool was found on this Mac. Paste an API key from any provider to continue.',
    circles,
  }, 'AI');
}

// ---------------------------------------------------------------- utilities library
// Reusable utilities the AI built, filed in a category tree and sorted by use. Browsing it is
// local; opening a utility shows it instantly.

async function showLibrary(path = []) {
  let r;
  try { r = await call('utilities', { op: 'tree', path }); } catch (e) { return toast(e.message); }
  const circles = [
    ...r.categories.map((c) => ({ id: 'cat:' + c.name, icon: '📁', label: c.name, hint: String(c.count), cat: true })),
    ...r.utilities.map((u) => ({ id: 'util:' + u.id, icon: u.icon || '🧰', label: u.name, hint: u.description, util: u.id })),
  ];
  push({ kind: 'circles', local: 'library', libPath: path, more: false, back: true,
    title: path.length ? path[path.length - 1] : t('root.utilities'), circles }, path.length ? path[path.length - 1] : t('root.utilities'));
}

async function localOpen(c) {
  const kind = current.screen.local;
  if (kind === 'who') return whoOpen(c);
  if (kind === 'profile') {
    if (c.branch) return showProfile([...current.screen.profPath, c.label]);
    return; // a trait: nothing to open (× forgets it)
  }
  if (kind === 'library') {
    if (c.cat) return showLibrary([...current.screen.libPath, c.label]);
    try {
      const { screen } = await call('utilities', { op: 'open', id: c.util });
      return push(normalize(screen), c.label);
    } catch (e) { return toast(e.message); }
  }
  if (kind !== 'setup') return;
  if (c.id === 'key') {
    return push({
      kind: 'text', local: 'key', go: 'Connect', title: 'Paste an API key',
      message: 'Anthropic, OpenAI, Google, OpenRouter, Groq or xAI is recognised from the key. ' +
        'Any other OpenAI-compatible provider: <base-url> <key> [model]. ' +
        (NATIVE ? 'Stored in the macOS Keychain.' : 'Stored only in this browser.'),
      text: '',
    }, 'API Key');
  }
  try {
    if (c.id === 'forget') await call('engine', { op: 'forget' });
    else await call('engine', { op: 'use', id: c.id.slice(4) });
  } catch (e) { return toast(e.message); }
  if (c.id === 'forget') { stack.pop(); return showSetup(); }
  home();
  flashStatus('Using ' + c.label);
}

async function connectKey(text) {
  try {
    const st = await call('engine', { op: 'key', text });
    home();
    flashStatus('Connected: ' + (st.active ? st.active.label : 'AI'));
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- navigation

function back() {
  if (busy) return cancel();
  if (typing() && current.screen.kind !== 'text') return stopWriting(true);
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
  focusManual = false;
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

  if (s.kind !== 'circles') el.circles.innerHTML = '';
  el.view.innerHTML = '';

  if (s.kind === 'circles') renderCircles(s);
  else if (s.kind === 'html') renderHTML(s);
  else if (s.kind === 'text') startWriting(s.text || '');
  updateGo();
  fitStage();
  layoutPages(typing());
  if (s.kind === 'circles') { initFocus(s); maybeRefine(s); }
  shownAt = s.local ? 0 : performance.now();
  trail.length = 0;
}

function renderCircles(s) {
  const before = new Set([...el.circles.children].map((n) => n.dataset.id));
  el.circles.innerHTML = '';
  visibleCircles(s).forEach((c) => {
    if (c.removed) return;
    const node = circleEl(c, 0);
    if (before.has(c.id)) node.style.animation = 'none'; // only new circles animate in
    el.circles.appendChild(node);
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
  // Freeze every page up to the one shown (not while typing: live circles re-flow freely).
  if (!typing()) s.frozen = pages.slice(0, (s.page || 0) + 1).map((p) => p.map((n) => n.dataset.id));
  // Keep the focus ring on this page.
  const shown = pages[s.page] || [];
  if (shown.length && !shown.some((n) => n.dataset.id === focusedId())) {
    setFocus((focusEdge === 'last' ? shown[shown.length - 1] : shown[0]).dataset.id);
  }
  focusEdge = 'first';
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
  if (s.kind !== 'circles' || !s.more || s.local || typing() || paging.loading || paging.failed || busy) return;
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
  node.className = 'circle' + (c.selected ? ' selected' : '') + (c.typed ? ' typed' : '') +
    (c.suggested ? ' suggested' : '') +
    (c.id === focusedId() ? ' focused' : '');
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
    setFocus(c.id, true);
    // Shift/Cmd-click selects instead of opening.
    if (e.shiftKey || e.metaKey) return toggleSelect(c, node);
    openCircle(c, node);
  });
  return node;
}

// Opens a circle: the typed-text circle sends the text; any other circle opens with the
// typed text (if any) as context.
function openCircle(c, node) {
  if (shownAt) { observe('decideMs', performance.now() - shownAt); shownAt = 0; }
  if (c.typed) return submitText();
  if (current.screen.local) return localOpen(c);
  if (c.id === 'utilities' && !stack.length) return showLibrary([]);
  const text = typing() ? el.write.value.trim() : '';
  const evt = { event: 'open', target: circleSummary(c) };
  if (text) evt.text = text;
  if (!text && openPrefetched(c, evt)) return;
  ask(evt, { label: c.label, circle: node });
}

function toggleSelect(c, node) {
  c.selected = !c.selected;
  refresh(c, node);
}

function minus(c, node) {
  if (current.screen.local === 'profile' && c.trait) {
    call('profile', { op: 'remove', path: c.trait }).catch(() => {});
    c.removed = true;
    node.classList.add('leaving');
    node.addEventListener('animationend', () => { node.remove(); layoutPages(); }, { once: true });
    return;
  }
  if (current.screen.local === 'library' && c.util) {
    call('utilities', { op: 'delete', id: c.util, path: current.screen.libPath }).catch(() => {});
    c.removed = true;
    node.classList.add('leaving');
    node.addEventListener('animationend', () => { node.remove(); layoutPages(); }, { once: true });
    return;
  }
  if (c.suggested) {
    live.circles = live.circles.filter((x) => x !== c);
    return rerenderLive();
  }
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
  if (c.suggested) {
    // Adopt the suggestion into the screen, selected.
    live.circles = live.circles.filter((x) => x !== c);
    const { suggested, ...rest } = c;
    current.screen.circles.push({ ...rest, id: c.id.replace(/^s~/, 'a~'), selected: true });
    return rerenderLive();
  }
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
  fresh.classList.toggle('focused', node.classList.contains('focused'));
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

// On the web, AI-written views run in a sandboxed frame (no access to this page or the stored key);
// they reach `aiui` through postMessage.
const FRAME_SHIM = `<script>(() => {
  let n = 0; const pend = {};
  addEventListener('message', (e) => {
    const d = e.data; if (!d || d.aiuiReply == null || !pend[d.aiuiReply]) return;
    const p = pend[d.aiuiReply]; delete pend[d.aiuiReply];
    d.error ? p.rej(new Error(d.error)) : p.res(d.value);
  });
  const rpc = (m, a) => new Promise((res, rej) => { const id = ++n; pend[id] = { res, rej }; parent.postMessage({ aiuiCall: id, m, a }, '*'); });
  window.aiui = { sys: (o) => rpc('sys', o), next: (d) => rpc('next', d), back: () => rpc('back'), home: () => rpc('home'),
    memory: { search: (q) => rpc('memory.search', q), stats: () => rpc('memory.stats') } };
  addEventListener('keydown', (e) => {
    const t = e.target; if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); parent.postMessage({ aiuiKey: e.key }, '*'); }
  });
  addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    if (/^(https?:|mailto:|tel:)/i.test(a.getAttribute('href'))) { e.preventDefault(); rpc('sys', { op: 'open', target: a.href }); }
  });
})();<\/script>`;

window.addEventListener('message', async (e) => {
  const frame = el.view.querySelector('iframe');
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.aiuiKey) return onKey(new KeyboardEvent('keydown', { key: d.aiuiKey }));
  if (d.aiuiCall == null) return;
  const fns = { sys: (a) => aiui.sys(a), next: (a) => aiui.next(a), back: () => aiui.back(), home: () => aiui.home(),
    'memory.search': (q) => aiui.memory.search(q), 'memory.stats': () => aiui.memory.stats() };
  try {
    const value = await (fns[d.m] ? fns[d.m](d.a) : Promise.reject(new Error('unknown call')));
    e.source.postMessage({ aiuiReply: d.aiuiCall, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }, '*');
  } catch (err) {
    e.source.postMessage({ aiuiReply: d.aiuiCall, error: err.message }, '*');
  }
});

function renderHTML(s) {
  const frame = document.createElement('iframe');
  if (!NATIVE) frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; autoplay; fullscreen; microphone; camera; geolocation');
  const base = `<meta charset="utf-8"><style>
    :root{${themeVars()}}
    html,body{margin:0;background:transparent;color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    body{padding:${s.title ? 120 : 64}px 48px 120px;max-width:1100px;margin:0 auto}
    a{color:var(--accent)} ::selection{background:var(--accent-soft)}
    ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
  </style>${NATIVE ? '<script>window.aiui = parent.aiui;<\/script>' : FRAME_SHIM}`;
  let html = String(s.html || '');
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + base);
  else html = `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    if (!NATIVE) return; // sandboxed: the shim handles keys and links
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
  if (s.kind === 'text' && text) label = s.go || t('send');
  else if (typing() && text) label = null; // Enter opens the focused circle
  else if (s.go) label = s.go;
  else if (anySelected()) label = t('go');
  el.go.textContent = label || t('go');
  document.body.classList.toggle('show-go', !!label);
}

el.go.addEventListener('click', (e) => {
  e.stopPropagation();
  if (current.screen.kind === 'text' && el.write.value.trim()) return submitText();
  if (current.screen.local) return;
  ask({ event: 'go' }, { label: current.screen.go || 'Go' });
});

// ---------------------------------------------------------------- focus
// One focused circle per screen (a ring, separate from + selection). Arrows move it, Enter opens
// it. A new screen starts on the AI's `focus`, else the user's most frequent choice, else the first.

let focusEdge = 'first'; // where focus lands after a page change
let focusManual = false; // the user moved focus since the last keystroke

function focusedId() {
  return typing() ? live.focus : current.screen.focusId;
}

function setFocus(id, manual) {
  if (typing()) live.focus = id; else current.screen.focusId = id;
  if (manual) focusManual = true;
  for (const n of el.circles.children) n.classList.toggle('focused', n.dataset.id === id);
  // Bring its page into view.
  const i = pages.findIndex((p) => p.some((n) => n.dataset.id === id));
  if (i >= 0 && i !== current.screen.page) { current.screen.page = i; showPage(); }
}

function initFocus(s) {
  const ids = [...el.circles.children].map((n) => n.dataset.id);
  if (typing()) return setFocus(ids.includes(live.focus) ? live.focus : ids[0]);
  if (ids.includes(s.focusId)) return setFocus(s.focusId);
  if (s.focus && ids.includes(s.focus)) return setFocus(s.focus);
  setFocus(ids[0]);
  // The user's habit on this screen, from the flow index.
  const path = [...stack.map((e) => e.label), current.label].filter(Boolean);
  const screen = s, asked = performance.now();
  call('cache', { op: 'likely', path }).then(({ label }) => {
    // Only as the initial pre-selection: never once the user has moved, or after a moment.
    if (!label || current.screen !== screen || focusManual || typing()) return;
    if (performance.now() - asked > 400 || lastPointerMove > asked) return;
    const c = (screen.circles || []).find((x) => !x.removed && x.label === label);
    if (c) setFocus(c.id);
  }).catch(() => {});
}

function focusedNode() {
  return [...el.circles.children].find((n) => n.dataset.id === focusedId() && !n.hidden);
}

// Spatial move among the circles on this page; past the edge, to the next/previous page.
function moveFocus(dir) {
  const nodes = [...el.circles.children].filter((n) => !n.hidden);
  if (!nodes.length) return;
  const cur = focusedNode();
  if (!cur) return setFocus(nodes[0].dataset.id, true);
  if (dir === 'next' || dir === 'prev') {
    const i = nodes.indexOf(cur) + (dir === 'next' ? 1 : -1);
    if (i >= 0 && i < nodes.length) return setFocus(nodes[i].dataset.id, true);
    return edge(dir === 'next' ? 1 : -1);
  }
  const r0 = cur.getBoundingClientRect();
  const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
  const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  let best = null, bestScore = Infinity;
  for (const n of nodes) {
    if (n === cur) continue;
    const r = n.getBoundingClientRect();
    const dx = r.left + r.width / 2 - c0.x, dy = r.top + r.height / 2 - c0.y;
    const along = dx * v[0] + dy * v[1];
    if (along <= 4) continue;
    const across = Math.abs(dx * v[1] - dy * v[0]);
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = n; }
  }
  if (best) return setFocus(best.dataset.id, true);
  edge(dir === 'right' || dir === 'down' ? 1 : -1);
}

function edge(step) {
  focusManual = true;
  if (step > 0) { focusEdge = 'first'; nextPage(); }
  else { focusEdge = 'last'; prevPage(); }
}

// ---------------------------------------------------------------- typing
// Typing any character opens a text input under the title (in its place when there is none).
// Circles live-update around the input: first the typed text itself (focused by default; Enter
// sends it), then matching circles of this screen, then circles the AI suggests for the input.

const live = { focus: '__typed', circles: [], q: '', timer: 0, token: 0 };

function typing() {
  return document.body.classList.contains('typing');
}

function startWriting(text) {
  const s = current.screen;
  document.body.classList.add('typing');
  document.body.classList.toggle('typing-text', s.kind === 'text');
  if (text != null) el.write.value = text;
  el.write.placeholder = s.kind === 'text' ? '' : t('typeHint');
  el.write.focus();
  autosize();
  fitStage();
  if (s.kind === 'circles') { live.focus = '__typed'; focusManual = false; rerenderLive(); }
  updateGo();
}

function stopWriting(clear) {
  const was = typing();
  document.body.classList.remove('typing', 'typing-text');
  if (clear) el.write.value = '';
  el.write.blur();
  clearTimeout(live.timer);
  live.circles = []; live.q = ''; live.token++;
  autosize();
  fitStage();
  if (was && current.screen.kind === 'circles') { renderCircles(current.screen); layoutPages(true); initFocus(current.screen); }
  updateGo();
}

// Esc always gets out of typing: cancels a pending send and clears the input
// (on an AI text screen it leaves the screen).
function escapeWriting() {
  if (busy) cancel();
  if (current.screen.kind === 'text') { stopWriting(true); back(); }
  else stopWriting(true);
}

el.who.addEventListener('click', (e) => { e.stopPropagation(); showWhoScreen(); });
el.close.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); escapeWriting(); });

function submitText() {
  const text = el.write.value.trim();
  if (!text) return;
  if (current.screen.local === 'key') return connectKey(text);
  ask({ event: 'text', text }, { label: text.length > 28 ? text.slice(0, 26) + '…' : text });
}

function matchScore(c, q) {
  const label = String(c.label || '').toLowerCase(), hint = String(c.hint || '').toLowerCase();
  if (label.startsWith(q)) return 4;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 3;
  if (label.includes(q)) return 2;
  if (hint.includes(q)) return 1;
  return 0;
}

// The circles shown for the current input.
function visibleCircles(s) {
  const q = el.write.value.trim();
  if (!typing() || !q || s.kind !== 'circles') return s.circles || [];
  const ql = q.toLowerCase();
  const typed = { id: '__typed', typed: true, icon: '✍️', label: q.length > 42 ? q.slice(0, 40) + '…' : q,
    hint: t('asTyped'), size: 1.1 };
  const matches = (s.circles || []).filter((c) => !c.removed)
    .map((c) => [c, matchScore(c, ql)]).filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const seen = new Set(matches.map((c) => c.label.toLowerCase()));
  const sugg = live.circles.filter((c) => !seen.has(c.label.toLowerCase()) && seen.add(c.label.toLowerCase()));
  return [typed, ...matches, ...sugg];
}

function rerenderLive() {
  if (current.screen.kind !== 'circles') return;
  renderCircles(current.screen);
  layoutPages(true);
  const ids = [...el.circles.children].map((n) => n.dataset.id);
  setFocus(ids.includes(live.focus) ? live.focus : ids[0]);
  updateGo();
}

function onInput() {
  autosize();
  updateGo();
  const s = current.screen;
  if (s.kind !== 'circles') return;
  const q = el.write.value.trim();
  if (!q) { live.circles = []; live.focus = '__typed'; }
  if (!focusManual) live.focus = '__typed';
  focusManual = false;
  rerenderLive();
  // Ask the AI for circles inspired by the input once typing pauses.
  clearTimeout(live.timer);
  if (!q || s.local) return;
  live.timer = setTimeout(() => suggestFor(q), 650);
}

async function suggestFor(q) {
  const screen = current.screen;
  const tok = ++live.token;
  el.status.textContent = 'thinking about “' + (q.length > 30 ? q.slice(0, 28) + '…' : q) + '”';
  document.body.classList.add('suggesting');
  try {
    const r = await call('suggest', {
      input: q,
      path: [...stack.map((e) => e.label), current.label].filter(Boolean),
      screen: summary(screen),
    });
    if (tok !== live.token || screen !== current.screen || !typing()) return;
    live.q = q;
    live.circles = (r.circles || []).filter((c) => c && c.label)
      .map((c, i) => ({ ...c, id: 's~' + (c.id || i), suggested: true }));
    rerenderLive();
    // r.focus marks the AI's best guess without moving the ring: the typed text stays the default.
    const wanted = r.focus && live.circles.find((c) => c.id === 's~' + r.focus || c.id === r.focus);
    if (wanted) { const n = [...el.circles.children].find((x) => x.dataset.id === wanted.id); if (n) n.classList.add('heading'); }
  } catch (e) {
    if (tok === live.token && e.message !== 'cancelled') flashStatus(e.message === 'no-ai' ? 'no AI connected' : 'no suggestions');
  } finally {
    if (tok === live.token) document.body.classList.remove('suggesting');
  }
}

function autosize() {
  el.write.style.height = 'auto';
  el.write.style.height = Math.min(el.write.scrollHeight, innerHeight * 0.5) + 'px';
}

// The circles area starts below the header, whatever the header holds.
function fitStage() {
  const top = el.top.getBoundingClientRect().bottom;
  el.stage.style.paddingTop = Math.max(70, Math.round(top + 18)) + 'px';
}
new ResizeObserver(fitStage).observe(el.top);

el.write.addEventListener('input', onInput);
el.write.addEventListener('keydown', (e) => {
  const kind = current.screen.kind;
  if (e.key.length === 1) {
    const now = performance.now();
    if (lastKeyAt && now - lastKeyAt < 1500) observe('typeGap', now - lastKeyAt);
    lastKeyAt = now;
  }
  // Option/Shift+Enter: new line (the input grows and pushes the circles down).
  if (e.key === 'Enter' && (e.altKey || e.shiftKey)) {
    e.preventDefault();
    el.write.setRangeText('\n', el.write.selectionStart, el.write.selectionEnd, 'end');
    return onInput();
  }
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (e.metaKey && (current.screen.go || anySelected())) return el.go.click();
    if (kind === 'circles') {
      const n = focusedNode();
      const c = n && visibleCircles(current.screen).find((x) => x.id === n.dataset.id);
      return c ? openCircle(c, n) : submitText();
    }
    return submitText();
  }
  if (e.key === 'Escape') { e.preventDefault(); return escapeWriting(); }
  if (kind === 'circles') {
    const empty = !el.write.value;
    const map = { ArrowUp: 'up', ArrowDown: 'down', Tab: e.shiftKey ? 'prev' : 'next' };
    if (empty) Object.assign(map, { ArrowLeft: 'left', ArrowRight: 'right' });
    if (map[e.key]) { e.preventDefault(); moveFocus(map[e.key]); return; }
    if (e.key === 'Backspace' && empty) { e.preventDefault(); return stopWriting(true); }
  }
  e.stopPropagation();
});

// A click on any empty place opens the text input.
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.pointerType === 'touch') return; // touch: handled as a tap below
  const t = e.target;
  if (t === el.write || t.closest('.circle, #nav, #view iframe, #toast, #close, #who, #webnote')) return;
  if (current.screen.kind === 'html' && t.closest('#view')) return;
  e.preventDefault();
  startWriting();
});

// ---------------------------------------------------------------- touch gestures (iPhone, iPad)
// Swipe up: next page (like More). Swipe down: previous page, then back a screen. A tap on an
// empty place opens the text input, as a click does with a mouse.

let touch0 = null;
document.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touch0 = null; return; }
  const p = e.touches[0];
  touch0 = { x: p.clientX, y: p.clientY, t: performance.now(), target: e.target };
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (!touch0) return;
  const p = e.changedTouches[0];
  const dx = p.clientX - touch0.x, dy = p.clientY - touch0.y, dt = performance.now() - touch0.t;
  const target = touch0.target;
  touch0 = null;
  if (target === el.write || (target.closest && target.closest('#view iframe'))) return;
  const s = current.screen;
  if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.5 && dt < 700) {
    if (typing() || s.kind === 'html') return;
    if (dy < 0) nextPage();
    else if (!prevPage()) back();
    return;
  }
  // A tap (no movement) on an empty place: start typing.
  if (Math.hypot(dx, dy) < 10 && dt < 400 && target.closest &&
      !target.closest('.circle, #nav, #view, #toast, #close, #write, #who, a, button')) {
    startWriting();
  }
}, { passive: true });

// ---------------------------------------------------------------- keys

function isEditable(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (e.key === 'Escape' && typing()) { e.preventDefault(); return escapeWriting(); }
  if (isEditable(e.target)) return;
  const circles = current.screen.kind === 'circles';
  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Tab: e.shiftKey ? 'prev' : 'next' };
  if (e.key === 'Backspace' || (e.metaKey && e.key === '[')) {
    e.preventDefault();
    if (!busy && prevPage()) return;
    back();
  } else if (e.key === 'Escape') {
    if (busy) cancel();
  } else if (circles && arrows[e.key]) {
    e.preventDefault();
    moveFocus(arrows[e.key]);
  } else if (circles && (e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault();
    e.key === 'PageDown' ? nextPage() : prevPage();
  } else if (e.key === 'Enter') {
    if (e.metaKey && (current.screen.go || anySelected())) { e.preventDefault(); return el.go.click(); }
    if (circles) {
      const n = focusedNode();
      const c = n && (current.screen.circles || []).find((x) => x.id === n.dataset.id);
      if (c) { e.preventDefault(); return openCircle(c, n); }
    }
    if (current.screen.go || anySelected()) { e.preventDefault(); el.go.click(); }
  } else if (circles && e.key === ' ') {
    // Space selects the focused circle (like its + ear).
    e.preventDefault();
    const n = focusedNode();
    const c = n && (current.screen.circles || []).find((x) => x.id === n.dataset.id);
    if (c) toggleSelect(c, n);
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && current.screen.kind !== 'html') {
    // Typing any symbol opens the input; the character lands in it.
    startWriting();
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

// ---------------------------------------------------------------- language
// The AI writes in the system language (`language` in every event). The app's own words are
// translated once by the AI and cached per language.

const STR = {
  go: 'Go', send: 'Send', back: '‹ Back', more: 'More ›', thinking: 'thinking', fromMemory: 'from memory',
  ready: 'ready', asTyped: 'as typed',
  typeHint: 'Type — Enter opens the highlighted circle, ⌥Enter new line, Esc closes',
  guest: 'guest', whoTitle: 'Is it still you?',
  whoMsg: 'This session looks different from how you usually use AI UI.',
  whoGuestMsg: 'Guest mode: no personal history is used.',
  itsMe: "It's me", itsMeHint: 'keep going, learn this', someoneElse: 'Someone else', someoneElseHint: 'guest mode',
  aboutYou: 'About you', aboutYouEmpty: 'Nothing learned yet. It builds up as you use the app.',
};
STR['root.utilities'] = 'Utilities'; STR['root.utilities.hint'] = 'your saved tools';
for (const c of ROOT.circles) { STR['root.' + c.id] = c.label; STR['root.' + c.id + '.hint'] = c.hint; }

// The root shows a Utilities circle once the library has something in it.
async function initLibrary() {
  try {
    const r = await call('utilities', { op: 'tree', path: [] });
    if (!r.total) return;
    const circle = { id: 'utilities', icon: '🧰', label: t('root.utilities'), hint: t('root.utilities.hint') };
    if (!ROOT.circles.some((c) => c.id === 'utilities')) ROOT.circles.unshift(circle);
    const root = stack.length ? stack[0].screen : current.screen;
    if (root.circles && !root.circles.some((c) => c.id === 'utilities')) root.circles.unshift({ ...circle });
    if (!stack.length && !typing()) render();
  } catch {}
}
let LANG = (navigator.language || 'en');
let L10N = null;
function t(k) { return (L10N && L10N[k]) || STR[k] || k; }

function applyStrings() {
  el.prev.textContent = t('back');
  el.more.textContent = t('more');
  for (const c of ROOT.circles) { if (STR['root.' + c.id]) { c.label = t('root.' + c.id); c.hint = t('root.' + c.id + '.hint'); } }
  // The root screen on display picks up the translated labels.
  const root = stack.length ? stack[0].screen : current.screen;
  for (const c of root.circles || []) {
    if (STR['root.' + c.id]) { c.label = t('root.' + c.id); c.hint = t('root.' + c.id + '.hint'); }
  }
  if (!stack.length && current.screen.kind === 'circles' && !typing()) render();
}

async function initLanguage() {
  if (NATIVE) { try { LANG = (await call('info')).language || LANG; } catch {} }
  document.documentElement.lang = LANG;
  if (/^en\b/i.test(LANG)) return;
  const store = 'aiui.i18n.' + LANG + '.' + Object.keys(STR).length;
  try { L10N = JSON.parse(localStorage.getItem(store)); } catch {}
  if (L10N) return applyStrings();
  try {
    const r = await call('translate', { language: LANG, strings: STR });
    if (r && r.strings) {
      L10N = r.strings;
      localStorage.setItem(store, JSON.stringify(L10N));
      applyStrings();
    }
  } catch { /* stay in English */ }
}

// ---------------------------------------------------------------- cursor trajectories
// The app follows the pointer: which circle it lingers on or hesitates over (sent to the AI as
// `attention`), and where it is heading — that circle is highlighted and its screen prefetched in
// the background, so clicking it is instant.

const trail = [];            // recent pointer samples {x, y, t}
let heading = null;          // id of the circle the pointer is heading for
let headingSince = 0;
let hoverStart = 0, hoverId = null;

function attentionOf(screen) { return screen.attention || (screen.attention = {}); }

function attentionSummary(screen) {
  const a = screen.attention || {};
  const byId = new Map((screen.circles || []).map((c) => [c.id, c]));
  return Object.entries(a).filter(([, v]) => v.ms > 150)
    .sort((x, y) => y[1].ms - x[1].ms).slice(0, 6)
    .map(([id, v]) => ({ circle: (byId.get(id) || {}).label || id, dwellMs: Math.round(v.ms), passes: v.passes,
      ...(v.ms > 900 && !v.opened ? { hesitated: true } : {}) }));
}

function circleAt(target) {
  const n = target && target.closest && target.closest('.circle');
  return n && !n.hidden ? n : null;
}

el.circles.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return; // touch: no hover, no trajectories
  const n = circleAt(e.target);
  if (!n || n.dataset.id === hoverId) return;
  endHover();
  hoverId = n.dataset.id; hoverStart = performance.now();
  // The focus ring follows the pointer only when the pointer itself moved onto the circle — not
  // when circles re-flowed or updated under a resting pointer.
  const moved = performance.now() - lastPointerMove < 80;
  if (moved && !typing() && n.dataset.id !== focusedId()) setFocus(n.dataset.id, true);
});
el.circles.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') endHover(); });
function endHover() {
  if (!hoverId) return;
  const a = attentionOf(current.screen);
  const v = a[hoverId] || (a[hoverId] = { ms: 0, passes: 0 });
  v.ms += performance.now() - hoverStart; v.passes += 1;
  hoverId = null;
}

let lastPointerMove = 0;
let lastPointer = { x: -1, y: -1 };
document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const now = performance.now();
  if (e.clientX === lastPointer.x && e.clientY === lastPointer.y) return; // synthetic, no motion
  lastPointer = { x: e.clientX, y: e.clientY };
  lastPointerMove = now;
  if (trail.length >= 3 && now - lastSpeedSample > 200) {
    const a = trail[0], b = trail[trail.length - 1];
    const v = Math.hypot(b.x - a.x, b.y - a.y) / ((b.t - a.t) || 1);
    if (v > 0.05) { observe('pointerSpeed', v); lastSpeedSample = now; }
  }
  trail.push({ x: e.clientX, y: e.clientY, t: now });
  while (trail.length > 10 || (trail.length && now - trail[0].t > 250)) trail.shift();
  if (current.screen.kind !== 'circles' || busy) return;
  predictTarget(now);
}, { passive: true });

// Extrapolates the pointer's motion: the circle closest to its path, ahead of it, is the target.
function predictTarget(now) {
  if (trail.length < 4) return;
  const a = trail[0], b = trail[trail.length - 1];
  const dt = b.t - a.t || 1, vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
  const speed = Math.hypot(vx, vy);
  let best = null, bestScore = Infinity;
  const over = circleAt(document.elementFromPoint(b.x, b.y));
  if (over && speed < 0.15) best = over; // resting on a circle
  else if (speed > 0.15) {
    for (const n of el.circles.children) {
      if (n.hidden) continue;
      const r = n.getBoundingClientRect();
      const dx = r.left + r.width / 2 - b.x, dy = r.top + r.height / 2 - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 650) continue;
      const cos = (dx * vx + dy * vy) / (dist * speed || 1);
      if (cos < 0.92) continue;
      const score = dist * (2 - cos);
      if (score < bestScore) { bestScore = score; best = n; }
    }
  }
  const id = best ? best.dataset.id : null;
  if (id !== heading) {
    for (const n of el.circles.children) n.classList.toggle('heading', n.dataset.id === id);
    heading = id; headingSince = now;
  } else if (id && now - headingSince > 260 && speed < 0.6) {
    prefetchCircle(id);
  }
}

// ---------------------------------------------------------------- prefetch
let prefetching = null; // circle id in flight

function prefetchCircle(id) {
  const s = current.screen;
  if (s.local || typing() || busy || prefetching === id) return;
  const c = (s.circles || []).find((x) => x.id === id && !x.removed);
  if (!c || c.typed || c.plus === 'more') return;
  const pf = s.prefetch || (s.prefetch = {});
  if (pf[id]) return;
  if (prefetching) call('cancel', { scout: true }).catch(() => {});
  prefetching = id;
  const evt = { event: 'open', target: circleSummary(c), path: [...stack.map((e) => e.label), current.label].filter(Boolean),
    screen: summary(s), language: LANG };
  const att = attentionSummary(s);
  if (att.length) evt.attention = att;
  call('prefetch', evt).then((screen) => {
    if (!screen || !screen.kind) return;
    pf[id] = { screen, at: Date.now(), evt };
    const n = [...el.circles.children].find((x) => x.dataset.id === id);
    if (n && current.screen === s) n.classList.add('ready');
  }).catch(() => {}).finally(() => { if (prefetching === id) prefetching = null; });
}

// Shows a prefetched screen (fresh within 3 minutes) instead of asking; records it as a turn.
function openPrefetched(c, evt) {
  const s = current.screen;
  const p = s.prefetch && s.prefetch[c.id];
  if (!p || Date.now() - p.at > 180000) return false;
  delete s.prefetch[c.id];
  const a = attentionOf(s)[c.id]; if (a) a.opened = true;
  const { note, cacheable, reuse, ...screen } = p.screen;
  call('adopt', { ...p.evt, ...evt, outcome: p.screen }).catch(() => {});
  stack.push(current);
  current = { screen: normalize(screen), label: c.label };
  stopWriting(true);
  render();
  flashStatus(t('ready'));
  return true;
}

// ---------------------------------------------------------------- live refinement
// Screens the AI marks `live` get a background pass that improves circles in place (real counts,
// previews, sharper labels). Changed circles update where they are, with a short glow.

function maybeRefine(s) {
  if (!s.live || s.refined || s.local) return;
  s.refined = true;
  call('refine', { path: [...stack.map((e) => e.label), current.label].filter(Boolean), screen: summary(s), language: LANG })
    .then((r) => {
      for (const patch of (r && r.circles) || []) {
        const c = (s.circles || []).find((x) => x.id === patch.id);
        if (!c) continue;
        let changed = false;
        for (const k of ['label', 'hint', 'icon', 'value']) {
          if (patch[k] != null && patch[k] !== c[k]) { c[k] = patch[k]; changed = true; }
        }
        if (!changed || current.screen !== s || typing()) continue;
        const n = [...el.circles.children].find((x) => x.dataset.id === c.id);
        if (n) { refresh(c, n); const m = [...el.circles.children].find((x) => x.dataset.id === c.id); if (m) m.classList.add('improved'); }
      }
    }).catch(() => {});
}

// ---------------------------------------------------------------- the user
// A behavioral baseline (typing rhythm, pointer speed, decision time, active hours, language,
// screen), measured quietly and stored locally. When this session clearly deviates on several
// measures, the app suspects someone else is using it: a 👤? badge, the AI is told (and keeps
// personal data out), and learning pauses. "It's me" clears it; "Someone else" is guest mode.
// The characteristic tree (what the user is like) is written by a background profiler AI.

const who = { base: null, session: {}, pending: {}, suspect: null, guest: false, turns: 0, dirty: false };
let shownAt = 0, lastKeyAt = 0, lastSpeedSample = 0;
const MIN_SESSION = { typeGap: 25, pointerSpeed: 30, decideMs: 5 };

function welford(st, x) { st.n = (st.n || 0) + 1; const d = x - (st.mean || 0); st.mean = (st.mean || 0) + d / st.n; st.m2 = (st.m2 || 0) + d * (x - st.mean); }
const sdOf = (st) => (st.n > 1 ? Math.sqrt(st.m2 / (st.n - 1)) : 0);
// Combines two running summaries (parallel Welford).
function combine(a, b) {
  if (!b || !b.n) return a || {};
  if (!a || !a.n) return { ...b };
  const n = a.n + b.n, d = b.mean - a.mean;
  return { n, mean: a.mean + d * b.n / n, m2: a.m2 + b.m2 + d * d * a.n * b.n / n };
}
const screenKey = () => Math.round(screen.width / 100) * 100 + 'x' + Math.round(screen.height / 100) * 100;

function observe(f, x) {
  if (!isFinite(x) || who.guest) return;
  welford(who.session[f] || (who.session[f] = {}), x);
  welford(who.pending[f] || (who.pending[f] = {}), x);
  who.dirty = true;
  checkUser();
}

function checkUser() {
  const b = who.base;
  if (!b || who.guest) return;
  const reasons = [];
  let weight = 0;
  for (const f of Object.keys(MIN_SESSION)) {
    const base = b[f], sess = who.session[f];
    if (!base || base.n < 40 || !sess || sess.n < MIN_SESSION[f]) continue;
    const d = Math.abs(sess.mean - base.mean) / Math.max(sdOf(base), base.mean * 0.15, 1e-6);
    const name = { typeGap: ['typing', 'slower', 'faster'], pointerSpeed: ['pointer', 'faster', 'slower'], decideMs: ['choosing', 'slower', 'faster'] }[f];
    if (d > 1.6) { reasons.push(`${name[0]} ${sess.mean > base.mean ? name[1] : name[2]} than usual`); weight += d > 2.5 ? 1.5 : 1; }
  }
  const hours = b.hours || [], total = hours.reduce((x, y) => x + y, 0), h = new Date().getHours();
  if (total >= 60 && (hours[h] || 0) / total < 0.01) { reasons.push(`unusual hour (${h}:00)`); weight += 1; }
  if (b.lang && b.lang !== LANG) { reasons.push(`different language (${LANG})`); weight += 1; }
  if (b.screen && b.screen !== screenKey()) { reasons.push('different screen'); weight += 0.5; }
  const suspect = weight >= 2 ? reasons : null;
  if (suspect && !who.suspect) { who.suspect = suspect; showWho(); flashStatus('👤 ?'); }
  else if (suspect) who.suspect = suspect;
}

// Merges this session's new samples into the baseline (only while it is trusted) and saves it.
function absorb() {
  if (who.suspect || who.guest || !who.base) return;
  for (const [f, st] of Object.entries(who.pending)) who.base[f] = combine(who.base[f], st);
  who.pending = {};
  const hours = who.base.hours || (who.base.hours = Array(24).fill(0));
  hours[new Date().getHours()] += who.turnsSinceAbsorb || 0;
  who.turnsSinceAbsorb = 0;
  who.base.lang = who.base.lang || LANG;
  who.base.screen = who.base.screen || screenKey();
  if (who.dirty) call('profile', { op: 'baseline', baseline: who.base }).catch(() => {});
  who.dirty = false;
}
setInterval(absorb, 30000);
document.addEventListener('visibilitychange', () => { if (document.hidden) absorb(); });

// Every 8 AI turns (trusted user only), the profiler revises the characteristic tree.
function learnSoon() {
  if (who.guest) return;
  who.turnsSinceAbsorb = (who.turnsSinceAbsorb || 0) + 1;
  who.dirty = true;
  if (who.suspect || ++who.turns % 8) return;
  const behavior = {};
  for (const [f, st] of Object.entries(who.base || {})) if (st && st.n) behavior[f] = { mean: Math.round(st.mean * 1000) / 1000, n: st.n };
  call('profile', { op: 'learn', behavior }).catch(() => {});
}

async function initUser() {
  try {
    const r = await call('profile', { op: 'get' });
    who.base = r.baseline && Object.keys(r.baseline).length ? r.baseline : { hours: Array(24).fill(0) };
  } catch { who.base = { hours: Array(24).fill(0) }; }
}

function showWho() {
  el.who.hidden = !(who.suspect || who.guest);
  el.who.textContent = who.guest ? '👤 ' + t('guest') : '👤?';
}

function showWhoScreen() {
  push({
    kind: 'circles', local: 'who', more: false, back: true, title: t('whoTitle'),
    message: who.guest ? t('whoGuestMsg') : t('whoMsg') + (who.suspect ? ' (' + who.suspect.join('; ') + ')' : ''),
    circles: [
      { id: 'me', icon: '🙂', label: t('itsMe'), hint: t('itsMeHint') },
      ...(who.guest ? [] : [{ id: 'guest', icon: '👥', label: t('someoneElse'), hint: t('someoneElseHint') }]),
    ],
  }, '👤');
}

async function whoOpen(c) {
  if (c.id === 'me') {
    // Trusted again: this session's pattern becomes part of the baseline.
    who.suspect = null; who.guest = false;
    for (const [f, st] of Object.entries(who.session)) who.pending[f] = st;
    who.session = {};
    if (who.base) { who.base.lang = LANG; who.base.screen = screenKey(); }
    who.dirty = true; absorb();
  } else {
    who.guest = true; who.suspect = null; who.session = {}; who.pending = {};
    call('reset').catch(() => {}); // a fresh AI session for the guest
  }
  showWho();
  back();
}

// "What AI UI knows about you": the characteristic tree, browsable; × forgets a trait.
async function showProfile(path = []) {
  let r;
  try { r = await call('profile', { op: 'tree', path }); } catch (e) { return toast(e.message); }
  push({
    kind: 'circles', local: 'profile', profPath: path, more: false, back: true,
    title: path.length ? path[path.length - 1] : t('aboutYou'),
    message: r.total ? '' : t('aboutYouEmpty'),
    circles: [
      ...r.branches.map((b) => ({ id: 'b:' + b.name, icon: '📂', label: b.name, hint: String(b.count), branch: true })),
      ...r.traits.map((tr) => ({ id: 't:' + tr.path.join('/'), icon: '•', label: tr.name, hint: tr.value,
        trait: tr.path, value: Math.round(tr.confidence * 100) / 100 })),
    ],
  }, path.length ? path[path.length - 1] : t('aboutYou'));
}

render();
// No AI available yet: ask for one.
call('engine', { op: 'status' }).then((st) => { if (!st.active) showSetup(); else initLanguage(); }).catch(() => {});
initLibrary();
