// aiui — circles UI driven by an AI that knows it lives in this webview.
'use strict';

const $ = (s) => document.querySelector(s);
const el = {
  path: $('#path'), title: $('#title'), message: $('#message'),
  circles: $('#circles'), view: $('#view'), write: $('#write'),
  status: $('#status'), go: $('#go'), toast: $('#toast'),
  prev: $('#prev'), more: $('#more'), stage: $('#stage'), close: $('#close'), top: $('#top'), who: $('#who'), full: $('#full'), ctx: $('#ctx'),
  activity: $('#activity'), procs: $('#procs'), pauseBtn: $('#pauseBtn'), settingsBtn: $('#settingsBtn'),
  console: $('#console'), consoleLog: $('#consoleLog'), consoleForm: $('#consoleForm'), consoleInput: $('#consoleInput'),
  consoleBtn: $('#consoleBtn'), sceneBar: $('#sceneBar'),
  infoBtn: $('#infoBtn'), actscreen: $('#actscreen'), actTitle: $('#actTitle'), actBody: $('#actBody'), actClose: $('#actClose'),
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
// The iOS app answers through a WebKit message handler instead of the aiui:// scheme.
const IOS_BRIDGE = NATIVE && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.aiui;
document.documentElement.classList.toggle('web', !NATIVE);
document.documentElement.classList.toggle('ios', !!IOS_BRIDGE);

// Every expectation has a timed listener: each kind of call has a deadline (the AI turn itself
// is governed by its screen's timeouts and the hard limit). A missed deadline rejects with
// "timeout" and cancels that background channel.
const DEADLINES = {
  ai: 160000, quick: 45000, more: 90000, suggest: 25000, prefetch: 90000, refine: 90000, revise: 120000,
  translate: 90000, profile: 180000, utilities: 10000, engine: 60000, cache: 10000, sys: 60000,
  info: 10000, adopt: 10000, cancel: 10000, reset: 10000, window: 10000,
};
const CHANNEL = { more: 'pager', suggest: 'suggest', prefetch: 'scout', refine: 'refine', revise: 'reviser', quick: 'quick', tests: 'tester', menus: 'menus' };

// AI requests still running, per channel, and what they are for. A request whose answer is no
// longer needed (its screen was left, typing stopped, the full answer came) is cancelled at once.
const running = {}; // channel -> { screen, seq }
let runSeq = 0;
function stale(ch, r) {
  if (ch === 'suggest') return !typing() || r.screen !== current.screen;
  if (ch === 'quick') return !busy;
  return r.screen !== current.screen;
}
function dropStale() {
  for (const [ch, r] of Object.entries(running)) {
    if (!stale(ch, r)) continue;
    delete running[ch];
    log('ai', `✂️ cancelled ${ch}: no longer needed`);
    rawCall('cancel', { [ch]: true }).catch(() => {});
  }
}

// What each kind of call is, in words, for the status bar (trivial calls stay silent).
function activityTitle(name, b = {}) {
  const label = (b.target && b.target.label) || '';
  switch (name) {
    case 'ai':
      if (b.event === 'open') return `${t('actOpening')} «${label}»`;
      if (b.event === 'text') return `${t('actAsking')} «${String(b.text || '').slice(0, 40)}»`;
      if (b.event === 'fix') return t('actRepairing');
      if (b.event === 'context') return `${(b.action && b.action.label) || ''}`;
      return `${t('actThinking')}: ${b.event}`;
    case 'quick': return t('actQuick');
    case 'more': return t('actMore');
    case 'suggest': return `${t('actSuggest')} «${String(b.input || '').slice(0, 30)}»`;
    case 'prefetch': return `${t('actPrefetch')} «${label}»`;
    case 'refine': return t('actRefine');
    case 'revise': return `${t('actRevise')} «${(b.shown && b.shown.title) || label}»`;
    case 'tests': return t('actTests');
    case 'menus': return t('actMenus');
    case 'translate': return t('actTranslate');
    case 'profile': return b.op === 'learn' ? t('actLearn') : null;
    case 'libraries': return b.op === 'ensure' ? t('actLibs') : null;
    default: return null;
  }
}

let actSeq = 0;
function call(name, body) {
  const title = activityTitle(name, body || {});
  const aid = title ? name + ':' + (++actSeq) : null;
  if (aid) activityStart(aid, title);
  return callRaw(name, body).finally(() => { if (aid) activityEnd(aid); });
}

function callRaw(name, body) {
  const ch = CHANNEL[name];
  if (ch) { const id = ++runSeq; running[ch] = { screen: current.screen, seq: id };
    return callTimed(name, body).finally(() => { if (running[ch] && running[ch].seq === id) delete running[ch]; }); }
  return callTimed(name, body);
}
function callTimed(name, body) {
  const ms = DEADLINES[name] || 30000;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (CHANNEL[name]) rawCall('cancel', { [CHANNEL[name]]: true }).catch(() => {});
      reject(new Error('timeout'));
    }, ms);
  });
  return Promise.race([rawCall(name, body), deadline]).finally(() => clearTimeout(timer));
}

async function rawCall(name, body) {
  if (!NATIVE) return WebBackend.call(name, body || {}, (text) => aiui._event({ type: 'progress', text }));
  if (IOS_BRIDGE) {
    const r = await IOS_BRIDGE.postMessage({ name, body: body || {} });
    const data = (r && r.data) || {};
    if (!r || r.status >= 300 || data.error) throw new Error(data.error || ('HTTP ' + (r && r.status)));
    return data;
  }
  const r = await fetch('/api/' + name, { method: 'POST', body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

window.aiui = {
  ready: () => viewReady(),
  call,
  sys: (op) => call('sys', op),
  memory: {
    search: (q) => call('cache', { op: 'search', q }).then((r) => r.results),
    stats: () => call('cache', { op: 'stats' }),
  },
  next: (data) => ask({ event: 'html', data }, { label: data && data.label }),
  // A scene's own activity in the app's list, with quick actions: [{ icon, label, run }].
  menuUsed: () => menuShortcut(),   // every native menu action (its ⌘ was not a lone press)
  network: () => showNetwork(),
  activityScreen: () => toggleActivityScreen(),
  activity: (id, title, actions) => sceneActivity(id, title, (actions || []).map((a) => ({ icon: a.icon, label: a.label, run: a.run }))),
  back: () => back(),
  home: () => home(),
  setup: () => showSetup(),
  profile: () => showProfile([]),
  library: () => showLibrary([]),
  system: () => showSystem(),
  state: { load: async () => sceneState(), save: (obj) => saveSceneState(obj) },
  app: { get: (k) => appGet(k), set: (k, v) => appSet(k, v), subscribe: (k, fn) => appSubscribe(k, fn) },
  media: { play: (url, title) => mediaPlay(url, title), pause: () => mediaPause(), resume: () => mediaResume(),
    stop: () => mediaStop(), state: () => mediaInfo() },
  goTo: (i) => goTo(i), switchPath: (i) => switchPath(i), closePath: (i) => closePath(i), setting: (k, v) => setSetting(k, v), action: (n, a) => settingsAction(n, a),
  settings: () => ({ ...settings, paused }),
  reloadScene: () => reloadScene(), find: () => find(), forward: () => forward(), zoom: (d) => zoom(d), print: () => printScene(),
  jsLibraries: () => showJSLibraries(),
  nativeLibraries: () => showNativeLibraries(),
  get screen() { return current.screen; },
  _event(e) {
    if (e.type === 'consoleProgress') return log('ai', e.text);
    if (e.type === 'appChanged') { log('activity', `app ↺ ${e.key}`); return appNotify(e.key, e.value); }
    if (e.type === 'improved') { log('done', `✨ improved «${e.title}»`); return onImproved(e); }
    if (e.type === 'componentImproved') return onComponentImproved(e);
    if (e.type === 'merged') { for (const x of [current, ...stack]) if (x.key === e.from) x.key = e.into; return onImproved({ key: e.into }); }
    if (e.type === 'aicoinLink') return onAicoinLink(e);
    if (e.type === 'activity') { if (e.done) activityEnd(e.id); else activityStart(e.id, nativeTitle(e), e.key || null, true, nativeActions(e)); return; }
    if (e.type !== 'progress') return;
    activityDetail('ai', e.text);
    log('ai', e.text);
    el.status.textContent = e.text;
    // The circle being opened shows what is happening inside it.
    const hint = pendingCircle && pendingCircle.querySelector('.progress');
    if (hint) hint.textContent = e.text;
  },
};

// ---------------------------------------------------------------- AI turns

// A screen shown from memory (visited before) is brought up to date in the background and
// replaced where it is (on screen or back in the history), keeping the page the user is on.
async function revise(entry, payload) {
  if (paused) return;
  const shown = entry.screen;
  try {
    const r = await call('revise', { ...payload, shown });
    if (!r || !r.screen || !r.screen.kind || entry.screen !== shown) return;
    const { note, cacheable, reuse, publish, merge, ...x } = r.screen;
    const next = normalize(x);
    if (JSON.stringify(summary(next)) === JSON.stringify(summary(shown)) && next.kind !== 'html') return;
    if (shown.page) next.page = shown.page;
    entry.screen = next;
    if (current === entry && !typing()) { render(); flashStatus(t('updated')); }
  } catch {}
}

// Is `next` the screen `here` again: same title, mostly the same circles, or the clicked one again?
function repeatsScreen(next, here, target) {
  const norm = (x) => String(x || '').trim().toLowerCase();
  if (!next || !here) return false;
  if (next.title && norm(next.title) === norm(here.title)) return true;
  const a = new Set((next.circles || []).map((c) => norm(c.label)).filter(Boolean));
  if (!a.size) return false;
  if (target && target.label && a.has(norm(target.label))) return true;
  const b = new Set((here.circles || []).filter((c) => !c.removed).map((c) => norm(c.label)).filter(Boolean));
  const shared = [...a].filter((l) => b.has(l)).length;
  return shared >= 3 && shared / Math.min(a.size, b.size) >= 0.5;
}

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

async function ask(evt, { label, replace = false, circle = null, retried = false } = {}) {
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
  // Time budget, as the screen declared it for this action (or the circle's own `expect`):
  // when it runs out → `interim` (a quick screen now, the full one replaces it in place),
  // `wait` (keep waiting) or `cancel`. A hard limit ends any wait.
  const policy = timeoutFor(evt, circle);
  let interim = null;     // the history entry showing the interim screen
  const started = performance.now();
  const countdown = setInterval(() => {
    if (my !== seq) return clearInterval(countdown);
    const left = Math.max(0, Math.round(policy.seconds - (performance.now() - started) / 1000));
    if (policy.label) { el.status.textContent = policy.label + (left ? ` · ${left}s` : ' · …'); }
    for (const [id, a] of activities) if (id.startsWith('ai:')) { a.detail = (policy.label || t('actThinking')) + (left ? ` · ${left}s` : ''); }
    renderActivity();
  }, 1000);
  const quickTimer = setTimeout(async () => {
    if (my !== seq || replace) return;
    if (policy.then === 'wait') { flashStatus((policy.label ? policy.label + ' · ' : '') + t('stillWorking')); return; }
    if (policy.then === 'cancel') {
      call('cancel').catch(() => {});
      seq++; setBusy(false);
      return toast(policy.label ? `${policy.label}: ${t('tooLong')}` : t('tooLong'));
    }
    try {
      const q = await call('quick', payload);
      if (my !== seq || interim || !busy || !q || !q.kind) return;
      const { note, cacheable, reuse, publish, ...screen } = q;
      // A quick screen that repeats this one (or lists the circle just clicked again) only looks
      // like the click did nothing: keep waiting, with the circle still showing it is loading.
      if (repeatsScreen(screen, current.screen, evt.target)) { log('ai', 'quick screen repeated this one: still waiting'); flashStatus(t('stillWorking')); return; }
      stack.push(current);
      interim = { screen: { ...normalize(screen), interim: true }, label: label || screen.title || evt.event };
      current = interim;
      stopWriting(true);
      setBusy(false);
      document.body.classList.add('updating');
      render();
    } catch {}
  }, policy.seconds * 1000);
  const hardTimer = setTimeout(() => {
    if (my !== seq) return;
    call('cancel').catch(() => {});
    seq++;
    setBusy(false);
    document.body.classList.remove('updating');
    if (!interim) toast(t('tooLong'));
    journal('timeout', current.screen, `no screen within ${HARD_LIMIT_MS / 1000}s for ${evt.event} ${(evt.target && evt.target.label) || evt.text || ''}`);
  }, HARD_LIMIT_MS);
  try {
    const { screen, cached, published, key: sceneKey, returned, stale } = await call('ai', payload);
    if (my !== seq) return; // cancelled or superseded
    if (cached) flashStatus(t('fromMemory'));
    if (published) setTimeout(() => flashStatus('🧩 +' + published), 300);
    if (!cached) learnSoon();
    const next = normalize(screen);
    if (interim) {
      // Replace the interim screen wherever it is now: on screen (an applet's scratch version
      // seamlessly, when the user is idle), or back in the history.
      interim.key = sceneKey;
      document.body.classList.remove('updating');
      if (current === interim && next.kind === 'html' && interim.screen.kind === 'html') { seamlessUpdate(interim, next, t('updated')); return; }
      interim.screen = next;
      if (current === interim && !typing()) { render(); flashStatus(t('updated')); }
      return;
    }
    // An applet already open (here or back in the history) is returned to, not opened twice.
    if (returned) flashStatus('↩︎ ' + t('returnedTo') + ' «' + (next.title || '') + '»');
    if (!replace && sceneKey && (returned || next.kind === 'html') && returnTo(sceneKey, next)) { stopWriting(true); render(); return; }
    if (replace) {
      current.screen = next;
    } else {
      forwardStack = [];
      stack.push(current);
      current = { screen: next, label: label || next.title || evt.event, evt: payload, key: sceneKey };
    }
    stopWriting(true);
    render();
    if (stale) revise(current, payload);
  } catch (e) {
    if (my === seq) {
      if (e.message === 'no-ai') { setBusy(false); return showSetup(); }
      // Cancelled by something other than the user (another request took the AI session):
      // try once more instead of showing an error.
      if (e.message === 'cancelled' && !retried && !interim) { setBusy(false); return ask(evt, { label, replace, circle, retried: true }); }
      if (!interim) toast(e.message);
      if (e.message !== 'cancelled') journal('error', current.screen, `${evt.event}: ${e.message}`);
    }
  } finally {
    clearTimeout(quickTimer);
    clearTimeout(hardTimer);
    clearInterval(countdown);
    if (my === seq) { setBusy(false); document.body.classList.remove('updating'); }
  }
}

let QUICK_AFTER_MS = 6000;       // default budget: no screen yet → interim screen (Settings)

// The budget for an action: the circle's `expect`, else the screen's `timeouts[event]`,
// else its `timeouts.default`, else 6 s → interim.
function timeoutFor(evt, circleNode) {
  const s = current.screen;
  const c = circleNode && (s.circles || []).find((x) => x.id === circleNode.dataset.id);
  const p = (c && c.expect) || (s.timeouts && (s.timeouts[evt.event] || s.timeouts.default)) || {};
  const seconds = Math.max(0.2, Math.min(Number(p.seconds) || QUICK_AFTER_MS / 1000, HARD_LIMIT_MS / 1000 - 5));
  return { seconds, then: ['interim', 'wait', 'cancel'].includes(p.then) ? p.then : 'interim', label: p.label || '' };
}
const HARD_LIMIT_MS = 150000;    // give up on the full answer

function normalize(s) {
  s = s && typeof s === 'object' ? s : {};
  // A screen's declared bottom-bar icons (kept apart from the live list a scene builds).
  if (Array.isArray(s.bar)) { s.declaredBar = s.bar; delete s.bar; }
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
  journal('cancel', current.screen, 'the user cancelled a request in progress');
  seq++;
  setBusy(false);
  try { await call('cancel'); } catch {}
}

function setBusy(on, circle) {
  busy = on;
  if (!on) setTimeout(dropStale);
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

// Several paths from the root, one active (the others keep their place). App-owned screens
// (network, settings, libraries, profile, AI provider…) open in a path of their own, and opening
// one again returns to its path. The title bar shows them all; a click switches, × closes.
let paths = []; // the inactive paths: { stack, current, forwardStack }
const pathTop = (p) => (p.stack.length > 1 ? p.stack[1] : p.current);
function pushPath(screen, label) {
  const family = screen.local;
  const top = pathTop({ stack, current });
  if (!family || (stack.length && top.screen && top.screen.local === family)) return push(screen, label); // deeper in its own path
  const i = paths.findIndex((p) => pathTop(p).screen && pathTop(p).screen.local === family);
  if (i >= 0) {                      // its path exists: switch there, refreshed at its first level
    const p = paths.splice(i, 1)[0];
    saveActivePath();
    ({ stack, current, forwardStack } = { stack: p.stack.slice(0, 1), current: { screen, label }, forwardStack: [] });
  } else {
    saveActivePath();
    stack = [{ screen: clone(ROOT), label: null }];
    current = { screen, label };
    forwardStack = [];
  }
  stopWriting(true);
  render();
}
function saveActivePath() {
  if (!stack.length && current.screen.kind === 'circles' && !current.label) return; // just the root: nothing to keep
  paths.push({ stack, current, forwardStack });
}
function switchPath(i) {
  const p = paths[i];
  if (!p) return;
  if (busy) cancel();
  paths.splice(i, 1);
  saveActivePath();
  ({ stack, current, forwardStack } = p);
  stopWriting(true);
  render();
}
function closePath(i) {
  paths.splice(i, 1);
  updateAddress();
}

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
    id: o.kind === 'aicoin' ? 'aicoin' : 'use:' + o.id, label: o.label,
    icon: o.kind === 'cli' ? '⌨️' : o.kind === 'aicoin' ? '🪙' : '🔑',
    hint: o.kind === 'cli' ? 'agent CLI on this Mac'
      : o.kind === 'aicoin' ? (o.balance != null ? `${Math.floor(o.balance)} coins` : 'free coins to start, no key')
      : 'saved API key',
    selected: !!(st.active && st.active.id === o.id),
    size: o.kind === 'aicoin' ? 1.15 : 1,
  }));
  circles.push({ id: 'key', label: 'API Key', icon: '🔑', hint: 'any provider', size: 1.1 });
  if (NATIVE) circles.push(...await aicoinLinkCircles());
  if ((st.options || []).some((o) => o.kind === 'key')) circles.push({ id: 'forget', label: 'Forget Key', icon: '🗑️', size: 0.8 });
  pushPath({
    kind: 'circles', local: 'setup', more: false, back: stack.length > 0,
    title: st.active ? 'AI' : 'Connect an AI',
    message: !NATIVE
      ? (st.active ? `Using ${st.active.label}. ` : '') +
        'Web version: your API key stays in this browser and goes only to its provider. No system access here — the AI UI Mac app has it.'
      : st.active
        ? `Using ${st.active.label}. Pick another, or add an API key.`
        : IOS_BRIDGE
          ? 'Choose how AI UI reaches AI: AICoin — free coins to start, no account or key — or your own API key.'
          : 'No AI command-line tool was found on this Mac. Use AICoin, or paste an API key from any provider.',
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
    ...r.utilities.map((u) => ({ id: 'util:' + u.id, icon: u.icon || '🧩', label: u.name, hint: u.description,
      util: u.id, value: u.uses })),
  ];
  pushPath({ kind: 'circles', local: 'library', libPath: path, more: false, back: true,
    title: path.length ? path[path.length - 1] : t('library'),
    message: path.length ? '' : (r.total ? t('libraryMsg') : t('libraryEmpty')), circles }, path.length ? path[path.length - 1] : t('library'));
}

async function localOpen(c) {
  const kind = current.screen.local;
  if (kind === 'who') return whoOpen(c);
  if (kind === 'network') return networkOpen(c);
  if (kind === 'profile') {
    if (c.branch) return showProfile([...current.screen.profPath, c.label]);
    return; // a trait: nothing to open (× forgets it)
  }
  if (kind === 'library') {
    if (c.cat) return showLibrary([...current.screen.libPath, c.label]);
    return; // a module: nothing to open (× removes it)
  }
  if (kind !== 'setup') return;
  if (c.id === 'aicoinLink' || c.id === 'aicoinUnlink') return aicoinLinkOpen(c);
  if (c.id === 'key') {
    return push({
      kind: 'text', local: 'key', go: 'Connect', title: 'Paste an API key',
      message: 'Anthropic, OpenAI, Google, OpenRouter, Groq or xAI is recognised from the key. ' +
        'Any other OpenAI-compatible provider: <base-url> <key> [model]. ' +
        (!NATIVE ? 'Stored only in this browser.' : 'Stored in your iCloud Keychain, shared with your other devices.'),
      text: '',
    }, 'API Key');
  }
  try {
    if (c.id === 'forget') await call('engine', { op: 'forget' });
    else if (c.id === 'aicoin') { flashStatus('🪙 …'); await call('engine', { op: 'aicoin' }); }
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
  const s = current.screen;
  if (s.kind === 'html' && s.listens && s.listens.back) {
    return invokeScene('back').then((handled) => { if (!handled && current.screen === s) leaveBack(); });
  }
  leaveBack();
}

// Goes back to the history entry showing applet `key` (updating its screen if one is given).
function returnTo(key, screen) {
  if (current.key === key) { if (screen) current.screen = screen; return true; }
  const i = stack.findIndex((e) => e.key === key);
  if (i < 0) return false;
  forwardStack = [];
  current = stack[i];
  stack = stack.slice(0, i);
  if (screen) current.screen = screen;
  return true;
}
// Opens applet `key`: returns to it when it is in the history, else shows its stored scene.
async function openApplet(key, label) {
  if (returnTo(key)) { stopWriting(true); render(); return true; }
  try {
    const { screen } = await callRaw('usage', { op: 'outcome', key });
    if (!screen) return false;
    forwardStack = [];
    stack.push(current);
    current = { screen: normalize(screen), label: label || screen.title, key };
    stopWriting(true);
    render();
    return true;
  } catch { return false; }
}

function leaveBack() {
  if (!stack.length) return;
  // Left an AI screen within 3 seconds of it appearing: probably not what was wanted.
  const s = current.screen;
  if (!s.local && s.shownAt && Date.now() - s.shownAt < 3000) journal('bounce', s, `left ${s.kind} screen after ${Date.now() - s.shownAt} ms`);
  forwardStack.push(current);
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
  // A lab still testing a screen the user has left is dropped (its screen is gone).
  if (labFor && labFor.screen !== s) { labFor.frame.remove(); labFor = null; activityEnd('lab'); }
  for (const [id, a] of activities) if (id.startsWith('scene:') && a.entry !== current && !stack.includes(a.entry)) activityEnd(id);
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
  continueSceneAudio();
  // A seamless update keeps the outgoing version on top until the new one is ready.
  for (const n of [...el.view.children]) if (!n.classList.contains('outgoing') || s.kind !== 'html') n.remove();
  dropStale();

  if (s.kind === 'circles') renderCircles(s);
  else if (s.kind === 'html') { renderHTML(s); watchView(s); }
  else if (s.kind === 'text') startWriting(s.text || '');
  updateGo();
  fitStage();
  layoutPages(typing());
  if (!s.barApplied) {
    s.barApplied = true;
    for (const id of s.barRemove || []) barRemove(id);
    for (const b of (s.declaredBar || [])) barAdd(b, false);
  }
  if (s.kind === 'circles') { initFocus(s); maybeRefine(s); if (!s.local) scheduleMenus(s, ['circle', 'empty-space']); }
  updateAddress();
  renderActivity();
  trackUsage();
  renderSceneBar();
  saveNav();
  setTimeout(tellSceneNowPlaying, 300);
  s.shownAt = s.shownAt || Date.now();
  el.full.hidden = !s.fullscreen;
  if (!s.fullscreen && document.body.classList.contains('immersive')) setImmersive(false);
  shownAt = s.local ? 0 : performance.now();
  trail.length = 0;
}

// Keeps each circle's text inside it: a label that wraps leaves the hint one line; a label
// that still overflows gets a smaller size.
function fitText(node) {
  const label = node.querySelector('.label'), hint = node.querySelector('.hint');
  if (!label) return;
  const lh = parseFloat(getComputedStyle(label).lineHeight) || 17;
  const lines = Math.round(label.scrollHeight / lh);
  node.classList.toggle('long', lines >= 2);
  node.classList.toggle('longer', lines >= 3);
  if (hint) hint.style.webkitLineClamp = lines >= 2 ? '1' : '';
}

function renderCircles(s) {
  const before = new Set([...el.circles.children].map((n) => n.dataset.id));
  el.circles.innerHTML = '';
  visibleCircles(s).forEach((c) => {
    if (c.removed) return;
    const node = circleEl(c, 0);
    if (before.has(c.id)) node.style.animation = 'none'; // only new circles animate in
    el.circles.appendChild(node);
    fitText(node);
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
  // Measuring hides and re-shows circles, which would replay their entrance: circles already
  // on screen must stay still.
  const wasShown = nodes.filter((n) => !n.hidden && n.dataset.shown != null);

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
  for (const n of wasShown) n.style.animation = 'none';
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
    const appearing = on && n.hidden;
    n.hidden = !on;
    if (on) n.dataset.shown = String(s.page);
    if (appearing) fitText(n);
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
  const listens = s.kind === 'html' && s.listens ? s.listens : {};
  el.more.classList.toggle('on', (circles && page < lastPage()) || !!s.more || !!listens.more);
  if (listens.back && stack.length) el.prev.classList.add('on');
  el.more.classList.toggle('loading', circles && page >= lastPage() && paging.loading && wantNext);
  maybePreload();
}

function nextPage() {
  const s = current.screen;
  if (s.kind !== 'circles') {
    // A scene listening for More extends itself; otherwise the AI extends the screen.
    if (s.kind === 'html' && s.listens && s.listens.more) {
      invokeScene('more').then((handled) => { if (!handled && s.more && current.screen === s) ask({ event: 'more' }, { label: 'More' }); });
      return;
    }
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
  if (s.kind !== 'circles' || !s.more || s.local || typing() || paging.loading || paging.failed || busy || paused) return;
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
      el.circles.appendChild(node);
      fitText(node);
      node.hidden = true;
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

el.prev.addEventListener('click', (e) => {
  e.stopPropagation();
  if (longPressed) { longPressed = false; return; } // the long press already acted
  if (!prevPage()) back();
});

// Long press on Back (or holding Backspace): close the app/scene and return to the circles.
let longTimer = 0, longPressed = false;
function backToCircles() {
  if (busy) cancel();
  stopWriting(true);
  while (stack.length && (current.screen.kind !== 'circles' || current.screen.local)) current = stack.pop();
  render();
  flashStatus('⟲');
}
el.prev.addEventListener('pointerdown', () => {
  longPressed = false;
  clearTimeout(longTimer);
  longTimer = setTimeout(() => { longPressed = true; backToCircles(); }, 550);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.prev.addEventListener(ev, () => clearTimeout(longTimer));
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
    <div class="face">
      ${c.icon ? `<span class="icon">${esc(c.icon)}</span>` : ''}
      <span class="label">${esc(c.label)}</span>
      ${c.hint && size >= 0.9 ? `<span class="hint">${esc(c.hint)}</span>` : ''}
      ${showValue ? `<span class="value">${esc(String(c.value))}</span>` : ''}
      ${c.expect && c.expect.seconds >= 8 ? `<span class="expect" title="${esc(c.expect.label || '')}">⏱ ${fmtSecs(c.expect.seconds)}</span>` : ''}
    </div>
`;

  node.querySelector('.face').addEventListener('click', (e) => {
    e.stopPropagation();
    // While a circle is generating the others are locked; the generating one cancels it.
    if (busy) { if (node.classList.contains('pending')) cancel(); return; }
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
  if (c.typed) return submitText(node);
  if (c.known) { stopWriting(true); return c.open(); }
  if (current.screen.local) return localOpen(c);
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
  if (current.screen.local === 'jslibs' && c.jslib) {
    call('libraries', { op: 'remove', id: c.jslib }).catch(() => {});
    c.removed = true;
    node.classList.add('leaving');
    node.addEventListener('animationend', () => { node.remove(); layoutPages(); }, { once: true });
    return;
  }
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
  fitText(fresh);
  pages = pages.map((p) => p.map((n) => (n === node ? fresh : n)));
  updateGo();
}

// The app's theme variables, resolved for the current appearance (light or dark).
const THEME_VARS = ['color-scheme', '--bg', '--fg', '--muted', '--faint', '--accent', '--on-accent', '--surface',
  '--line', '--line-strong', '--chip', '--danger', '--accent-soft', '--accent-glow'];
const PALETTES = {
  dark: { 'color-scheme': 'dark', '--bg': '#0b0b0f', '--fg': '#e8e8ee', '--muted': '#8a8a99', '--faint': '#4a4a58', '--accent': '#7c9cff',
    '--on-accent': '#0b0b0f', '--surface': 'rgba(255,255,255,.05)', '--line': 'rgba(255,255,255,.09)', '--line-strong': 'rgba(255,255,255,.22)',
    '--chip': '#15151c', '--danger': '#ff7c8a', '--accent-soft': 'rgba(124,156,255,.16)', '--accent-glow': 'rgba(124,156,255,.22)' },
  light: { 'color-scheme': 'light', '--bg': '#f5f5f8', '--fg': '#17171e', '--muted': '#6b6b7b', '--faint': '#a6a6b4', '--accent': '#4263eb',
    '--on-accent': '#ffffff', '--surface': 'rgba(0,0,0,.04)', '--line': 'rgba(0,0,0,.08)', '--line-strong': 'rgba(0,0,0,.2)',
    '--chip': '#ffffff', '--danger': '#c2334a', '--accent-soft': 'rgba(66,99,235,.14)', '--accent-glow': 'rgba(66,99,235,.2)' },
};
// The theme variables: the current appearance's, or a given one (dark = true/false).
function themeVars(dark) {
  if (dark === true || dark === false) return Object.entries(PALETTES[dark ? 'dark' : 'light']).map(([k, v]) => `${k}:${v}`).join(';');
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

// Health monitor injected first into every AI-written view: reports script errors, failed or
// slow fetches (20 s) and images (15 s) to the app, which also expects aiui.ready().
const HEALTH_SHIM = `<script>(() => {
  const report = (kind, detail) => { try { parent.postMessage({ aiuiHealth: { kind, detail: String(detail).slice(0, 300) } }, '*'); } catch {} };
  addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) report('resource', (t.tagName || '') + ' failed: ' + (t.src || t.href));
    else report('error', (e.message || 'error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''));
  }, true);
  addEventListener('unhandledrejection', (e) => report('error', 'unhandled: ' + ((e.reason && e.reason.message) || e.reason)));
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = (input && input.url) || String(input);
    const ctl = new AbortController();
    if (init.signal) init.signal.addEventListener('abort', () => ctl.abort());
    const timer = setTimeout(() => { ctl.abort(); report('timeout', 'fetch over 20s: ' + url); }, 20000);
    return realFetch(input, { ...init, signal: ctl.signal }).then((r) => {
      if (!r.ok) report('fetch', r.status + ' ' + url);
      return r;
    }, (err) => { report('fetch', 'failed ' + url + ': ' + err.message); throw err; }).finally(() => clearTimeout(timer));
  };
  const RealImage = window.Image;
  const watch = (img) => {
    let t = null;
    const arm = () => { clearTimeout(t); t = setTimeout(() => { if (img.src && !img.complete) report('timeout', 'image over 15s: ' + img.src); }, 15000); };
    img.addEventListener('load', () => clearTimeout(t));
    img.addEventListener('error', () => { clearTimeout(t); report('resource', 'IMG failed: ' + img.src); });
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(img, 'src', { get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); arm(); } });
    return img;
  };
  window.Image = function (w, h) { return watch(new RealImage(w, h)); };
  window.Image.prototype = RealImage.prototype;
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.tagName === 'IMG' && !n.__w) { n.__w = 1; watch(n); } })
    .observe(document.documentElement, { childList: true, subtree: true });
})();<\/script>`;

// Scene QA (web/qa.js): layout, readability, accessibility and UX scores, plus every
// interaction in the lab clone. Loaded once; injected into each view.
let QA_SRC = '';
fetch('qa.js').then((r) => r.text()).then((t) => { QA_SRC = t.replace(/<\/script/gi, '<\\/script'); }).catch(() => {});
const qaShim = (mode) => QA_SRC ? `<script>window.__qaMode = '${mode}';<\/script><script>${QA_SRC}<\/script>` : '';

// Scene listeners: a view registers aiui.onBack(fn) / aiui.onMore(fn); the app's Back and More
// (buttons, Backspace, swipes) go to the scene first. A handler returning false passes it on.
const SCENE_SHIM = `<script>(() => {
  // Object classes for context menus.
  window.__aiuiClassify = (el) => {
    const t = el.closest('img,picture,a[href],h1,h2,h3,h4,h5,h6,button,[role=button],input,textarea,select,canvas,svg,video,audio,table,pre,code,li');
    if (t) { const n = t.tagName.toLowerCase();
      if (n === 'img' || n === 'picture') return 'image'; if (n === 'a') return 'link'; if (/^h\\d$/.test(n)) return 'heading';
      if (n === 'button' || t.getAttribute('role') === 'button') return 'button'; if (/^(input|textarea|select)$/.test(n)) return 'input';
      if (n === 'canvas' || n === 'svg') return 'canvas'; if (n === 'video' || n === 'audio') return 'media';
      if (n === 'table') return 'table'; if (n === 'pre' || n === 'code') return 'code'; if (n === 'li') return 'list-item'; }
    return [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim().length > 1) ? 'text' : 'empty-space';
  };
  const ctx = (el, x, y) => {
    const c = window.__aiuiClassify(el), a = el.closest && el.closest('a[href]'), img = el.closest && el.closest('img');
    parent.postMessage({ aiuiContext: { cls: c, x, y, text: (el.innerText || el.alt || el.value || '').trim().slice(0, 500),
      href: a ? a.href : '', src: img ? img.currentSrc || img.src : '' } }, '*');
  };
  addEventListener('contextmenu', (e) => { e.preventDefault(); ctx(e.target, e.clientX, e.clientY); });
  let hold = 0;
  addEventListener('touchstart', (e) => { const p = e.touches[0], t = e.target; hold = setTimeout(() => ctx(t, p.clientX, p.clientY), 550); }, { passive: true });
  for (const ev of ['touchend', 'touchmove', 'touchcancel']) addEventListener(ev, () => clearTimeout(hold), { passive: true });
  const handlers = {};
  const reg = (k) => (fn) => { handlers[k] = fn; parent.postMessage({ aiuiListen: k }, '*'); };
  aiui.onBack = reg('back');
  aiui.onMore = reg('more');
  aiui.onFind = (fn) => { handlers.find = fn; };
  // Reloads keep audio going: playing media is handed to the app player, and a reloaded scene
  // doesn't start a second copy of what the app is already playing.
  let appPlaying = window.__appPlaying || null;
  const played = new Set(); // every media element this scene played, in the DOM or not (new Audio())
  const realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!played.has(this)) {
      played.add(this);
      for (const ev of ['playing', 'pause', 'ended', 'seeked', 'ratechange', 'emptied']) this.addEventListener(ev, () => reportPlaying());
    }
    if (appPlaying && (this.currentSrc || this.src) === appPlaying) return Promise.resolve();
    return realPlay.call(this);
  };
  // Sound playing now (video only when it isn't seen — leaving a visible video stops it).
  const playingNow = () => [...played, ...document.querySelectorAll('audio,video')].find((x) => !x.paused && !x.ended && (x.currentSrc || x.src)
    && (x.tagName !== 'VIDEO' || !x.isConnected || !x.offsetWidth));
  addEventListener('message', (e) => {
    const d = e.data || {};
    if ('aiuiNowPlaying' in d) appPlaying = d.aiuiNowPlaying;
    if (d.aiuiHandoff) {
      window.__handedOff = true;
      const m = playingNow();
      parent.postMessage({ aiuiHandoffReply: m ? { url: m.currentSrc || m.src, time: m.currentTime, title: m.title || document.title || '' } : null }, '*');
      if (m) m.pause();
    }
  });
  // Typing on a scene: a key that no handler of the scene does anything with goes to the app's
  // text input. A handler "does something" when it prevents the default, stops the event,
  // changes the page, draws, schedules work, loads, plays or moves focus. Scenes that track held
  // keys (keyup handlers, as games do) keep every key. A lone ⌘ press, or ⌘T, opens the input.
  const realAdd = EventTarget.prototype.addEventListener, realRemove = EventTarget.prototype.removeEventListener;
  const realTimeout = window.setTimeout.bind(window);
  let keyListeners = 0, heldKeys = 0, inKey = 0, keyEffect = false;
  const effect = () => { if (inKey) keyEffect = true; };
  const watched = (obj, names) => { for (const n of names) { const o = obj && obj[n]; if (typeof o === 'function') obj[n] = function (...a) { effect(); return o.apply(this, a); }; } };
  watched(window, ['setTimeout', 'setInterval', 'requestAnimationFrame', 'fetch', 'open', 'alert', 'confirm', 'prompt']);
  watched(Event.prototype, ['stopPropagation', 'stopImmediatePropagation']);
  watched(XMLHttpRequest.prototype, ['send']);
  watched(HTMLMediaElement.prototype, ['play', 'pause']);
  watched(History.prototype, ['pushState', 'replaceState', 'back', 'forward']);
  watched(Storage.prototype, ['setItem', 'removeItem']);
  watched(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, ['fillRect', 'clearRect', 'strokeRect', 'fill', 'stroke', 'drawImage', 'putImageData', 'fillText', 'strokeText']);
  for (const G of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) watched(G && G.prototype, ['drawArrays', 'drawElements', 'clear']);
  const wrapped = new WeakMap();
  const editable = (t) => t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn && (type === 'keyup') && !editable(this)) heldKeys++;
    if (fn && (type === 'keydown' || type === 'keypress')) {
      keyListeners++;
      if (!wrapped.has(fn)) wrapped.set(fn, function (e) {
        const mo = new MutationObserver(() => {}), prevented = e.defaultPrevented, focus = document.activeElement;
        mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        inKey++;
        try { return typeof fn === 'function' ? fn.call(this, e) : fn.handleEvent(e); }
        finally {
          inKey--;
          if (mo.takeRecords().length || e.defaultPrevented !== prevented || document.activeElement !== focus) keyEffect = true;
          mo.disconnect();
        }
      });
      return realAdd.call(this, type, wrapped.get(fn), opts);
    }
    return realAdd.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    return realRemove.call(this, type, (fn && wrapped.get(fn)) || fn, opts);
  };
  const keyProps = () => !!(window.onkeydown || window.onkeypress || document.onkeydown || document.onkeypress
    || (document.body && (document.body.onkeydown || document.body.onkeypress)));
  let metaDown = 0;
  realAdd.call(window, 'keydown', (e) => {
    if (e.key === 'Meta') { metaDown = performance.now(); return; }
    metaDown = 0;
    const t = e.target;
    if (editable(t) || e.isComposing) return;
    if (e.key.length !== 1 || e.key === '\`' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (e.key === ' ' && t !== document.body && t !== document.documentElement) return;
    if (heldKeys || keyProps()) return;
    if (!keyListeners) { e.preventDefault(); parent.postMessage({ aiuiType: e.key }, '*'); return; }
    // The scene's handlers run after this one: decide once the event has been through all of them.
    keyEffect = false;
    const key = e.key;
    realTimeout(() => { if (!keyEffect && !e.defaultPrevented) parent.postMessage({ aiuiType: key }, '*'); }, 0);
  }, true);
  realAdd.call(window, 'keyup', (e) => {
    if (e.key === 'Meta' && metaDown && performance.now() - metaDown < 600) parent.postMessage({ aiuiType: '' }, '*');
    metaDown = 0;
  });
  realAdd.call(window, 'mousedown', () => { metaDown = 0; }, true);
  realAdd.call(window, 'message', (e) => { if (e.data && e.data.aiuiMetaUsed) metaDown = 0; });
  // The app updates a scene only while the user is idle: it is told about input here.
  let inputAt = 0;
  const input = () => { const n = Date.now(); if (n - inputAt > 400) { inputAt = n; parent.postMessage({ aiuiInput: 1 }, '*'); } };
  realAdd.call(window, 'pointerdown', input, true); realAdd.call(window, 'keydown', input, true); realAdd.call(window, 'wheel', input, { capture: true, passive: true });
  realAdd.call(window, 'blur', () => { metaDown = 0; });
  // What plays here (so the app keeps playing it when this scene is left).
  function reportPlaying() {
    if (window.__handedOff) return;
    const m = playingNow();
    const url = m && (m.currentSrc || m.src);
    parent.postMessage({ aiuiPlaying: url && !/^blob:/.test(url) ? { url, time: m.currentTime, rate: m.playbackRate || 1, title: m.title || document.title || '' } : null }, '*');
  }
  for (const ev of ['playing', 'pause', 'ended', 'seeked', 'ratechange', 'emptied']) document.addEventListener(ev, reportPlaying, true);
  addEventListener('message', (e) => { const d = e.data || {}; if (d.aiuiAppChanged && window.__appSubs && window.__appSubs[d.key]) window.__appSubs[d.key](d.value); });
  // Icons in the app's bottom bar (left), while this scene is on screen.
  const barFns = {};
  aiui.bar = {
    // fn: runs in this scene; a string: a request to the AI. { global: true } keeps it across
    // screens and launches (prompt only — the scene's own code can't run after it is left).
    add(id, icon, title, fn, opts = {}) {
      if (typeof fn === 'function') barFns[id] = fn;
      parent.postMessage({ aiuiBar: { id: String(id), icon: String(icon).slice(0, 4), title: String(title || '').slice(0, 60),
        prompt: typeof fn === 'string' ? fn.slice(0, 500) : undefined, global: !!opts.global } }, '*');
    },
    remove(id) { delete barFns[id]; parent.postMessage({ aiuiBarRemove: String(id) }, '*'); },
  };
  addEventListener('message', (e) => { const d = e.data || {}; if (d.aiuiBarClick && barFns[d.aiuiBarClick]) barFns[d.aiuiBarClick](); });
  // Usage: interactions, reported every few seconds.
  let interactions = 0;
  for (const ev of ['pointerdown', 'keydown']) realAdd.call(window, ev, () => { interactions++; }, true);
  setInterval(() => { if (interactions) { parent.postMessage({ aiuiUsage: interactions }, '*'); interactions = 0; } }, 5000);
  // Live screenshot on request (html2canvas from the library store, else the CDN).
  addEventListener('message', async (e) => {
    if (!e.data || !e.data.aiuiShotRequest) return;
    try {
      if (!window.html2canvas) await new Promise((ok, no) => {
        const tryLoad = (src, next) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = next; document.head.appendChild(sc); };
        tryLoad(e.data.local, () => tryLoad('https://cdn.jsdelivr.net/npm/html2canvas@1/dist/html2canvas.min.js', no));
      });
      const scale = Math.min(1, 900 / Math.max(1, innerWidth));
      const c = await html2canvas(document.body, { scale, logging: false, useCORS: true, backgroundColor: null });
      parent.postMessage({ aiuiShot: c.toDataURL('image/jpeg', 0.6) }, '*');
    } catch (err) { parent.postMessage({ aiuiShot: null }, '*'); }
  });
  addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.aiuiFind) { if (handlers.find) handlers.find(d.aiuiFind); else if (window.find) window.find(d.aiuiFind); }
    if (d.aiuiPrint) print();
  });
  addEventListener('message', async (e) => {
    const d = e.data || {};
    if (!d.aiuiInvoke) return;
    let handled = false;
    try { const fn = handlers[d.aiuiInvoke]; if (fn) handled = (await fn()) !== false; } catch { handled = false; }
    parent.postMessage({ aiuiInvoked: d.id, handled }, '*');
  });
})();<\/script>`;

// The lab: a hidden clone of each view with every aiui call mocked (no system actions, no
// navigation), where every interaction is exercised: each control is checked for being
// reachable, then clicked / typed into / changed; errors and dead controls are reported, and
// the scene's Back/More listeners are invoked too.
const LAB_MOCK = `<script>(() => {
  window.__mockCalls = 0; window.__activity = 0; window.__handlers = {};
  window.__realSetTimeout = window.setTimeout.bind(window);
  const mc = (v) => (...a) => { window.__mockCalls++; return Promise.resolve(v); };
  window.aiui = { ready() { window.postMessage({ aiuiReadySignal: true }, '*'); },
    sys: mc({ ok: true, code: 0, stdout: '', stderr: '', text: '' }), next: mc(null), back: mc(null), home: mc(null), activity: mc(null),
    memory: { search: mc([]), stats: mc({}) },
    onBack(fn) { window.__handlers.back = fn; }, onMore(fn) { window.__handlers.more = fn; },
    state: { _s: null, async load() { return this._s; }, save(o) { this._s = JSON.parse(JSON.stringify(o)); window.__mockCalls++; } },
    bar: { add(id, icon, title, fn) { (window.__handlers.bar = window.__handlers.bar || {})[id] = fn; }, remove() {} },
    app: { _v: {}, async get(k) { return this._v[k] ?? null; }, set(k, v) { this._v[k] = v; window.__mockCalls++; }, subscribe() {} },
    media: { play: mc(null), pause: mc(null), resume: mc(null), stop: mc(null), state: mc({}) } };
  const of = window.fetch.bind(window); window.fetch = (...a) => { window.__activity++; return of(...a); };
  for (const k of ['setTimeout', 'setInterval', 'requestAnimationFrame']) { const o = window[k].bind(window); window[k] = (...a) => { window.__activity++; return o(...a); }; }
  const op = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__activity++; return op.call(this).catch(() => {}); };
  addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a) { e.preventDefault(); window.__mockCalls++; } }, true);
  addEventListener('submit', (e) => { e.preventDefault(); window.__mockCalls++; }, true);
})();<\/script>`;

// Starts the hidden lab clone for a view; reports interaction problems to the repair.
function runLab(s, sharedHead, html, mode = 'lab', tests = null) {
  if (s.local || paused || !settings.qa) return;
  if (mode === 'lab') { if (s.labbed) return; s.labbed = true; }
  if (labFor) return setTimeout(() => runLab(s, sharedHead, html, mode, tests), 1500); // one lab at a time
  s.labHead = sharedHead;
  let lab = document.getElementById('lab');
  if (!lab) { lab = document.createElement('div'); lab.id = 'lab'; document.body.appendChild(lab); }
  // Another screen mode than the one on display: phone size, the other colour theme.
  lab.style.width = '390px';
  lab.style.height = '844px';
  const f = document.createElement('iframe');
  if (!NATIVE) f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
  const otherTheme = `<style>:root{${themeVars(!matchMedia('(prefers-color-scheme: dark)').matches)}}</style>`;
  const testData = tests ? `<script>window.__aiTests = ${JSON.stringify(tests).replace(/</g, '\\u003c')};<\/script>` : '';
  const head = sharedHead.base + otherTheme + LAB_MOCK + testData + qaShim(mode) + sharedHead.libs;
  f.srcdoc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head)
    : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  lab.appendChild(f);
  labFor = { frame: f, screen: s };
  activityStart('lab', mode === 'tests' ? t('actRunDoD') : t('actLab'));
  setTimeout(() => { if (labFor && labFor.frame === f) { f.remove(); labFor = null; } }, 25000);
}
let labFor = null;

function labResult(r) {
  activityEnd('lab');
  if (r && r.scores) log('qa', `lab (phone, other theme) — UX ${r.scores.ux} · readability ${r.scores.readability} · accessibility ${r.scores.accessibility} · ${(r.corners || []).filter((c) => !c.ok).length} corner case(s) failing`);
  if (!labFor) return;
  const { frame, screen: s } = labFor;
  frame.remove(); labFor = null;
  (s.quality || (s.quality = {})).lab = r;
  lastQuality = { title: s.title, ...s.quality };
  componentFeedback(s, r);
  requestSceneTests(s);
  if (!qaFails(r) || s.fixed) return;
  (s.health || (s.health = [])).push(...(r.issues || []).map((x) => 'phone/other theme: ' + x));
  if (current.screen === s && !s.fixing) selfFix(s, qaReason(`interaction lab (${r.tested} controls, phone, other theme)`, r));
}

// "What should be tested for this scene?" — the AI writes scene-specific tests; they run in a
// second lab pass; failures go to the repair like any other finding.
async function requestSceneTests(s) {
  if (paused || !settings.dod) return;
  if (s.testsRequested || s.local || s.kind !== 'html' || !s.labHead) return;
  s.testsRequested = true;
  try {
    const r = await call('tests', { screen: { title: s.title, html: String(s.html || '').slice(0, 14000), uses: s.uses, libs: s.libs },
      path: [...stack.map((e) => e.label), current.label].filter(Boolean), language: LANG });
    s.dod = (r.dod || []).slice(0, 10);
    const tests = (r.tests || []).filter((x) => x && x.code).slice(0, 10);
    if (tests.length && !s.fixed) { s.aiTests = tests; runLab(s, s.labHead, String(s.html || ''), 'tests', tests); }
  } catch {}
}

function testsResult(r) {
  activityEnd('lab');
  if (!labFor) return;
  const { frame, screen: s } = labFor;
  frame.remove(); labFor = null;
  const results = (r.results || []).map((x, i) => ({ ...x, criterion: (s.aiTests[i] || {}).criterion }));
  (s.quality || (s.quality = {})).tests = results;
  // The Definition of Done, each criterion met when all its tests passed.
  s.quality.dod = (s.dod || []).map((text, i) => {
    const mine = results.filter((x) => x.criterion === i);
    return { text, ok: mine.length ? mine.every((x) => x.ok) : null, notes: mine.filter((x) => !x.ok).map((x) => x.note) };
  });
  lastQuality = { title: s.title, ...s.quality };
  const unmet = s.quality.dod.filter((d) => d.ok === false);
  const failed = results.filter((x) => !x.ok);
  if (!failed.length || s.fixed) return;
  (s.health || (s.health = [])).push(...failed.map((x) => `DoD test "${x.name}" failed: ${x.note}`));
  journal('dod', s, `${unmet.length} DoD criteria unmet: ${unmet.map((d) => d.text).join(' | ')}`);
  if (current.screen === s && !s.fixing) selfFix(s, `Definition of Done not met (${unmet.length} of ${s.dod.length}): ${unmet.map((d) => d.text).join('; ')}`);
}

// Scene listeners from the real frame, and the round trip to invoke them.
const sceneCalls = {};
let sceneSeq = 0;
function invokeScene(kind) {
  const s = current.screen;
  const f = el.view.querySelector('iframe');
  if (s.kind !== 'html' || !s.listens || !s.listens[kind] || !f) return Promise.resolve(false);
  const id = ++sceneSeq;
  return new Promise((resolve) => {
    sceneCalls[id] = resolve;
    f.contentWindow.postMessage({ aiuiInvoke: kind, id }, '*');
    setTimeout(() => { if (sceneCalls[id]) { delete sceneCalls[id]; resolve(false); } }, 1200);
  });
}

// The view's health, its readiness, and the self-fix when it gets stuck.
function viewHealth(h) {
  const s = current.screen;
  if (s.kind !== 'html') return;
  (s.health || (s.health = [])).push(h.kind + ': ' + h.detail);
  if (s.health.length > 30) s.health.shift();
  // Into the indexed avoid record (rechecked in the background with backoff).
  const m = String(h.detail).match(/https?:\/\/\S+/);
  if (m && h.kind !== 'error') reportFailure(m[0], h.kind === 'timeout' ? 'timeout' : (String(h.detail).match(/^(\d{3}) /) || [])[1] || 'failed');
  // Failures matter even after ready(): once things go quiet, repair the view if they add up.
  s.failures = (s.failures || 0) + (h.kind === 'error' || h.kind === 'fetch' ? 2 : 1);
  clearTimeout(s.failTimer);
  s.failTimer = setTimeout(() => {
    if (current.screen === s && (s.failures || 0) >= 2) selfFix(s, `${s.health.length} failures reported`);
  }, 2000);
}

// Failed resources go to the avoid record in small batches.
let failQueue = [], failTimer = 0;
function reportFailure(url, reason) {
  failQueue.push({ url, reason });
  clearTimeout(failTimer);
  failTimer = setTimeout(() => {
    const items = failQueue.splice(0);
    if (items.length) call('avoid', { op: 'record', items }).catch(() => {});
  }, 800);
}

function viewReady() {
  const s = current.screen;
  if (s.kind !== 'html') return;
  s.ready = true;
  finishSeamless();
  const f = el.view.querySelector('iframe');
  try { f && f.contentWindow.postMessage({ aiuiReadySignal: true }, '*'); } catch {}
  // A global icon opened this applet: run its action now that the scene is up.
  if (pendingBarClick && pendingBarClick.key === current.key) {
    const id = pendingBarClick.id; pendingBarClick = null;
    setTimeout(() => { try { f && f.contentWindow.postMessage({ aiuiBarClick: id }, '*'); } catch {} }, 50);
  }
}

// The in-frame UI test reported: reveal the tested render; repair it if anything is wrong.
// Repair needed: hard failures (layout, broken interactions) or any score under 70.
let QA_MIN = 70;                 // Settings
function qaFails(r) {
  const hard = (r.issues || []).some((x) => /^(layout|ux|security):/.test(x));
  const low = Object.values(r.scores || {}).some((v) => v < QA_MIN);
  return hard || low;
}
function qaReason(where, r) {
  const sc = r.scores || {};
  return `${where} at ${r.width}×${r.height} — UX ${sc.ux}, readability ${sc.readability}, accessibility ${sc.accessibility}` +
    (sc.security != null ? `, security ${sc.security}` : '') +
    ` (repair below ${QA_MIN}): ${(r.issues || []).length} issue(s)` +
    (r.corners && r.corners.some((c) => !c.ok) ? '; corner cases failing: ' + r.corners.filter((c) => !c.ok).map((c) => c.case).join(', ') : '');
}

function viewReview(r) {
  const s = current.screen;
  if (r && r.scores) log('qa', `«${s.title}» on screen — UX ${r.scores.ux} · readability ${r.scores.readability} · accessibility ${r.scores.accessibility}${(r.issues || []).length ? ' · ' + r.issues.length + ' issue(s): ' + r.issues.slice(0, 3).join(' | ') : ''}`);
  if (s.kind !== 'html' || s.reviewed) return;
  s.reviewed = true;
  markChecked(s);
  revealView();
  (s.quality || (s.quality = {})).screen = r;
  lastQuality = { title: s.title, ...s.quality };
  if (r.classes) scheduleMenus(s, r.classes);
  componentFeedback(s, r);
  if (qaFails(r) && !s.fixed && !s.local) {
    (s.health || (s.health = [])).push(...(r.issues || []));
    selfFix(s, qaReason('UI test on screen', r));
  }
}
let lastQuality = null;

// Versions of HTML scenes that went through the hidden check (a hash of their html).
const CHECKED = 'aiui.checked';
function htmlHash(s) {
  const x = String(s.html || '');
  let h = 5381;
  for (let i = 0; i < x.length; i++) h = ((h * 33) ^ x.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + x.length.toString(36);
}
function checkedBefore(s) { try { return (JSON.parse(localStorage.getItem(CHECKED)) || []).includes(htmlHash(s)); } catch { return false; } }
function markChecked(s) {
  try {
    const h = htmlHash(s), list = (JSON.parse(localStorage.getItem(CHECKED)) || []).filter((x) => x !== h);
    localStorage.setItem(CHECKED, JSON.stringify([...list, h].slice(-400)));
  } catch {}
}

function revealView() {
  activityEnd('review');
  el.view.classList.remove('checking');
  const f = el.view.querySelector('iframe');
  if (f) f.classList.remove('testing');
}

function watchView(s) {
  if (s.kind !== 'html' || s.fixed || s.local) return;
  const budget = Math.max(4, Math.min(Number(s.timeouts && s.timeouts.render && s.timeouts.render.seconds) || 15, 90));
  setTimeout(() => {
    if (current.screen !== s || s.ready) return;
    selfFix(s, `not ready after ${budget}s` + (s.health && s.health.length ? '' : ' (no errors reported)'));
  }, budget * 1000);
}

// Asks the AI to repair a stuck or broken view; replaces it in place; drops the broken cached copy.
async function selfFix(s, reason) {
  if (s.fixing || (s.fixAttempts || 0) >= 1) return;
  journal('repair', s, reason + ' · ' + (s.health || []).slice(-6).join(' | '));
  s.fixing = true; s.fixAttempts = (s.fixAttempts || 0) + 1;
  const entry = current;
  document.body.classList.add('updating');
  flashStatus(t('fixing'));
  try {
    if (entry.evt) call('cache', { op: 'invalidate', action: entry.evt }).catch(() => {});
    const { screen } = await call('ai', {
      event: 'fix',
      problem: { reason, errors: (s.health || []).slice(-15) },
      broken: { title: s.title, kind: s.kind, uses: s.uses, html: String(s.html || '').slice(0, 8000) },
      path: [...stack.map((e) => e.label), current.label].filter(Boolean),
      screen: summary(s), language: LANG,
    });
    const fixed = normalize(screen);
    fixed.fixed = true;
    if (current === entry) await handoffMedia();
    entry.screen = fixed;
    if (current === entry && !typing()) { render(); flashStatus(t('fixed')); }
  } catch (e) {
    if (current === entry && e.message !== 'cancelled') toast(t('couldNotFix') + ' ' + e.message);
  } finally {
    s.fixing = false;
    document.body.classList.remove('updating');
  }
}

// On the web, AI-written views run in a sandboxed frame (no access to this page or the stored key);
// they reach `aiui` through postMessage.
const FRAME_SHIM = `<script>(() => {
  let n = 0; const pend = {};
  addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.aiuiActivityAction != null) { const f = (window.__actFns || {})[d.aiuiActivityAction]; if (f) f(); return; }
    if (!d || d.aiuiReply == null || !pend[d.aiuiReply]) return;
    const p = pend[d.aiuiReply]; delete pend[d.aiuiReply];
    d.error ? p.rej(new Error(d.error)) : p.res(d.value);
  });
  const rpc = (m, a) => new Promise((res, rej) => { const id = ++n; pend[id] = { res, rej }; parent.postMessage({ aiuiCall: id, m, a }, '*'); });
  window.aiui = {
    state: { load: () => rpc('state.load'), save: (o) => rpc('state.save', o) },
    app: { get: (k) => rpc('app.get', k), set: (k, v) => rpc('app.set', [k, v]),
      subscribe: (k, fn) => { (window.__appSubs = window.__appSubs || {})[k] = fn; rpc('app.subscribe', k); } },
    media: { play: (u, t) => rpc('media.play', [u, t]), pause: () => rpc('media.pause'), resume: () => rpc('media.resume'),
      stop: () => rpc('media.stop'), state: () => rpc('media.state') },
    ready: () => rpc('ready'), setting: (k, v) => rpc('setting', [k, v]), action: (n, a) => rpc('action', [n, a]),
    activity: (id, title, actions) => { const fns = window.__actFns = window.__actFns || {};
      const acts = (actions || []).map((a, i) => { fns[id + '#' + i] = a.run; return { icon: a.icon, label: a.label, n: i }; });
      return rpc('activity', [id, title, acts]); },
    settings: () => rpc('settings'), sys: (o) => rpc('sys', o), next: (d) => rpc('next', d), back: () => rpc('back'), home: () => rpc('home'),
    memory: { search: (q) => rpc('memory.search', q), stats: () => rpc('memory.stats') } };
  addEventListener('keydown', (e) => {
    if (e.key === '\`' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); parent.postMessage({ aiuiKey: '\`' }, '*'); return; }
  }, true);
  addEventListener('keydown', (e) => {
    const t = e.target; if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'Backspace' || e.key === 'Escape' || e.key === '\`') { e.preventDefault(); parent.postMessage({ aiuiKey: e.key }, '*'); }
    if ((e.metaKey || e.ctrlKey) && /^[fp=\\-0\\[\\]rtni]$/i.test(e.key)) { e.preventDefault(); parent.postMessage({ aiuiKey: e.key, meta: true, shift: e.shiftKey }, '*'); }
  });
  addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    if (/^(https?:|mailto:|tel:)/i.test(a.getAttribute('href'))) { e.preventDefault(); rpc('sys', { op: 'open', target: a.href }); }
  });
})();<\/script>`;

window.addEventListener('message', async (e) => {
  if (labFor && e.source === labFor.frame.contentWindow) {
    if (e.data && e.data.aiuiInteract) labResult(e.data.aiuiInteract);
    if (e.data && e.data.aiuiTests) testsResult(e.data.aiuiTests);
    return;
  }
  const frame = el.view.querySelector('iframe');
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.aiuiListen) {
    const s = current.screen;
    (s.listens || (s.listens = {}))[d.aiuiListen] = true;
    return updatePager();
  }
  if (d.aiuiBar) return barAdd(d.aiuiBar, true);
  if (d.aiuiBarRemove) return barRemove(d.aiuiBarRemove);
  if ('aiuiType' in d) { typeFromScene(d.aiuiType); return; }
  if ('aiuiPlaying' in d) { scenePlaying = d.aiuiPlaying ? { ...d.aiuiPlaying, at: Date.now() } : null; return; }
  if ('aiuiHandoffReply' in d) { const r = handoffWait; handoffWait = null; if (r) r(d.aiuiHandoffReply); return; }
  if (d.aiuiInput) { lastInputAt = Date.now(); return; }
  if (d.aiuiUsage) { usageNote(current, { interactions: d.aiuiUsage }); return; }
  if ('aiuiShot' in d) { if (d.aiuiShot) usageNote(current, { screenshot: d.aiuiShot }); return; }
  if (d.aiuiContext) {
    const r = frame.getBoundingClientRect();
    return openContext(d.aiuiContext.cls, { text: d.aiuiContext.text, href: d.aiuiContext.href, src: d.aiuiContext.src },
      r.left + d.aiuiContext.x, r.top + d.aiuiContext.y);
  }
  if (d.aiuiInvoked != null) { const r = sceneCalls[d.aiuiInvoked]; delete sceneCalls[d.aiuiInvoked]; if (r) r(!!d.handled); return; }
  if (d.aiuiHealth) return viewHealth(d.aiuiHealth);
  if (d.aiuiReview) return viewReview(d.aiuiReview);
  if (d.aiuiKey) return onKey(new KeyboardEvent('keydown', { key: d.aiuiKey, metaKey: !!d.meta, shiftKey: !!d.shift }));
  if (d.aiuiCall == null) return;
  if (d.aiuiHealth) return viewHealth(d.aiuiHealth);
  if (d.aiuiReview) return viewReview(d.aiuiReview);
  const src = e.source;
  const fns = { sys: (a) => aiui.sys(a), next: (a) => aiui.next(a), back: () => aiui.back(), home: () => aiui.home(),
    'state.load': () => sceneState(), 'state.save': (o) => saveSceneState(o),
    'app.get': (k) => appGet(k), 'app.set': (a) => appSet(a[0], a[1]), 'app.subscribe': (k) => appSubscribeFrame(k, e.source),
    'media.play': (a) => mediaPlay(a[0], a[1]), 'media.pause': () => mediaPause(), 'media.resume': () => mediaResume(),
    'media.stop': () => mediaStop(), 'media.state': () => mediaInfo(),
    ready: () => viewReady(), setting: (a) => setSetting(a[0], a[1]), action: (a) => settingsAction(a[0], a[1]),
    settings: () => aiui.settings(),
    activity: (a) => sceneActivity(a[0], a[1], (a[2] || []).map((x) => ({ icon: x.icon, label: x.label,
      run: () => src.postMessage({ aiuiActivityAction: a[0] + '#' + x.n }, '*') }))),
    'memory.search': (q) => aiui.memory.search(q), 'memory.stats': () => aiui.memory.stats() };
  try {
    const value = await (fns[d.m] ? fns[d.m](d.a) : Promise.reject(new Error('unknown call')));
    e.source.postMessage({ aiuiReply: d.aiuiCall, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }, '*');
  } catch (err) {
    e.source.postMessage({ aiuiReply: d.aiuiCall, error: err.message }, '*');
  }
});

// The JS libraries a screen declares in `libs`: script/link tags (local when installed).
async function jsLibsFor(s) {
  if (!s.libs || !s.libs.length) return '';
  try {
    const { tags } = await call('libraries', { op: 'ensure', ids: s.libs });
    const attr = (x) => String(x).replace(/"/g, '&quot;');
    return (tags || []).map((t) => t.type === 'css' ? `<link rel="stylesheet" href="${attr(t.src)}">`
      : `<script src="${attr(t.src)}"><\/script>`).join('');
  } catch { return ''; }
}

async function libraryFor(s) {
  if (!s.uses || !s.uses.length) return '';
  try {
    const b = await call('utilities', { op: 'bundle', ids: s.uses });
    const safe = (x) => String(x || '').replace(/<\/(script|style)/gi, '<\\/$1');
    return '<script>window.lib = window.lib || {};<\/script>' +
      (b.css ? `<style>${safe(b.css)}</style>` : '') + (b.js ? `<script>${safe(b.js)}<\/script>` : '');
  } catch { return '<script>window.lib = window.lib || {};<\/script>'; }
}

function renderHTML(s) {
  const frame = document.createElement('iframe');
  // Rendered hidden first: the UI test runs on this very render, which is then revealed.
  // A version already checked before (this session or an earlier one) shows at once; the check
  // still runs on it in the background.
  if (!s.local && !s.reviewed) {
    if (!checkedBefore(s) && !el.view.querySelector('.outgoing')) {
      frame.classList.add('testing');
      el.view.classList.add('checking');
      setTimeout(() => { if (current.screen === s) revealView(); }, 2500); // never hidden for long
    }
    activityStart('review', t('actReview'));
  }
  if (!NATIVE) frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; autoplay; fullscreen; microphone; camera; geolocation');
  const base = `<meta charset="utf-8"><style>
    :root{${themeVars()}}
    html,body{margin:0;background:transparent;color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    body{padding:16px 48px 110px;max-width:1100px;margin:0 auto}
    a{color:var(--accent)} ::selection{background:var(--accent-soft)}
    ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
  </style>`;
  const real = HEALTH_SHIM + (s.local ? '' : qaShim('review')) +
    (NATIVE ? '<script>window.aiui = Object.create(parent.aiui);<\/script>' : FRAME_SHIM) +
    `<script>window.__appPlaying = ${JSON.stringify(nowPlaying && !player.paused ? nowPlaying.url : null).replace(/</g, '\\u003c')};<\/script>` + SCENE_SHIM;
  el.view.prepend(frame); // before an outgoing version (which stays on top until this one is ready)
  const screen = s;
  Promise.all([jsLibsFor(s), libraryFor(s)]).then(([libs, lib]) => {
    if (current.screen !== screen) return;
    let html = String(s.html || '');
    const head = base + real + libs + lib;
    // The interaction test runs in a hidden mocked clone alongside (the screen doesn't wait).
    if (!s.local && !s.fixed) setTimeout(() => runLab(s, { base, libs: libs + lib }, String(s.html || '')), 50);
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + head);
    else html = `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
    frame.srcdoc = html;
  });
  frame.addEventListener('load', () => {
    if (!NATIVE) return; // sandboxed: the shim handles keys and links
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.addEventListener('keydown', (e) => {
      if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); return toggleConsole(); }
      onKey(e);
    }, true);
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
  const goT = s.timeouts && (s.timeouts.go || s.timeouts.default);
  if (label && goT && goT.seconds >= 8 && !typing()) el.go.textContent += ' · ⏱ ' + fmtSecs(goT.seconds);
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

const live = { focus: '__typed', circles: [], q: '', timer: 0, token: 0, understood: null };

function typing() {
  return document.body.classList.contains('typing');
}

function startWriting(text) {
  const s = current.screen;
  document.body.classList.add('typing');
  document.body.classList.toggle('typing-text', s.kind === 'text');
  if (text != null) el.write.value = text;
  el.write.placeholder = s.kind === 'text' ? '' : s.kind === 'html' ? t('typeOnScene') : t('typeHint');
  el.write.focus();
  autosize();
  fitStage();
  if (s.kind === 'circles') { live.focus = '__typed'; focusManual = false; rerenderLive(); }
  updateGo();
}

// A character typed on a scene (or a lone ⌘: '') opens the input with it.
function typeFromScene(ch) {
  if (busy && !ch) return;
  if (!typing()) startWriting(el.write.value + (ch || ''));
  else if (ch) el.write.setRangeText(ch, el.write.selectionStart, el.write.selectionEnd, 'end');
  el.write.focus();
  if (ch) onInput();
}
// A lone ⌘ press opens the input on any screen.
let metaDownAt = 0;
// A ⌘ shortcut the native menu handled never reaches the page: its ⌘ was not a lone press.
function menuShortcut() {
  metaDownAt = 0;
  const f = el.view.querySelector('iframe');
  try { f && f.contentWindow.postMessage({ aiuiMetaUsed: true }, '*'); } catch {}
}
document.addEventListener('keydown', (e) => { metaDownAt = e.key === 'Meta' ? performance.now() : 0; }, true);
document.addEventListener('keyup', (e) => {
  if (e.key === 'Meta' && metaDownAt && performance.now() - metaDownAt < 600 && !typing() && el.console.hidden) typeFromScene('');
  metaDownAt = 0;
}, true);
document.addEventListener('mousedown', () => { metaDownAt = 0; }, true);
window.addEventListener('blur', () => { metaDownAt = 0; });

function stopWriting(clear) {
  const was = typing();
  document.body.classList.remove('typing', 'typing-text');
  if (clear) el.write.value = '';
  el.write.blur();
  clearTimeout(live.timer);
  live.circles = []; live.q = ''; live.understood = null; live.token++;
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

// Sends the typed text. The typed circle (when there is one) shows the same loading as any
// other circle: pulsing ring and progress inside it.
function submitText(node) {
  const text = el.write.value.trim();
  if (!text) return;
  rememberTyped(text);
  if (current.screen.local === 'key') return connectKey(text);
  if (current.screen.local === 'wifipass') return joinNetwork(current.screen.ssid, text);
  const circle = node || [...el.circles.children].find((n) => n.dataset.id === '__typed' && !n.hidden) || null;
  // Straight into the screen that does it, as understood.
  const u = live.understood && live.q === text ? live.understood.label : null;
  const label = u || (text.length > 28 ? text.slice(0, 26) + '…' : text);
  ask({ event: 'text', text, direct: true, ...(u ? { understood: u } : {}) }, { label, circle });
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
  const q = typedText().trim();
  if (!typing() || !q || s.kind !== 'circles') return s.circles || [];
  const ql = q.toLowerCase();
  // The main circle: the raw text, until the AI says how it understood it.
  const u = live.understood && live.q === q ? live.understood : null;
  const typed = u
    ? { id: '__typed', typed: true, understood: true, icon: u.icon || '💡', label: u.label, hint: u.hint || t('asUnderstood'), size: 1.15 }
    : { id: '__typed', typed: true, icon: '✍️', label: q.length > 42 ? q.slice(0, 40) + '…' : q, hint: t('asTyped'), size: 1.1 };
  const matches = (s.circles || []).filter((c) => !c.removed)
    .map((c) => [c, matchScore(c, ql)]).filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const seen = new Set(matches.map((c) => c.label.toLowerCase()));
  // Already available elsewhere (app screens, the root, screens in this and other paths, applets).
  const known = knownCircles().map((c) => [c, matchScore(c, ql)]).filter(([c, v]) => v >= 2 && !seen.has(c.label.toLowerCase()))
    .sort((a, b) => b[1] - a[1]).map(([c]) => c).filter((c) => seen.add(c.label.toLowerCase())).slice(0, 6);
  const sugg = live.circles.filter((c) => !seen.has(c.label.toLowerCase()) && seen.add(c.label.toLowerCase()));
  return [typed, ...matches, ...known, ...sugg];
}

// Circles that already exist somewhere the user can go: proposed while typing, opened directly.
let knownApplets = [], knownAppletsAt = 0;
function refreshKnownApplets() {
  if (Date.now() - knownAppletsAt < 60000) return;
  knownAppletsAt = Date.now();
  callRaw('usage', { op: 'applets' }).then((r) => { knownApplets = (r && r.applets) || []; if (typing()) rerenderLive(); }).catch(() => {});
}
function knownCircles() {
  const out = [];
  const add = (c, open) => out.push({ ...c, id: 'k~' + out.length, known: true, open, size: 0.9 });
  const appScreens = [['📶', t('network'), () => showNetwork()], ['ⓘ', t('actScreen'), () => toggleActivityScreen(true)],
    ['⚙️', t('system'), () => showSystem()], ['📦', t('jsLibs'), () => showJSLibraries()], ['🧰', t('utilityLibrary') , () => showLibrary()],
    ['👤', t('profileTitle'), () => showProfile()], ['🤖', 'AI', () => showSetup()]];
  for (const [icon, label, open] of appScreens) add({ icon, label, hint: t('appName') }, open);
  if (stack.length) for (const c of ROOT.circles) add({ icon: c.icon, label: c.label, hint: t('appName') }, () => openKnown(null, c));
  const where = (labels) => labels.filter(Boolean).slice(-2).join(' › ');
  stack.forEach((entry, i) => { for (const c of (entry.screen.circles || []).filter((x) => !x.removed && !x.typed))
    add({ icon: c.icon, label: c.label, hint: where([...stack.slice(1, i + 1).map((e) => e.label)]) || t('appName') }, () => openKnown({ level: i }, c)); });
  paths.forEach((p, pi) => { for (const entry of [...p.stack, p.current]) for (const c of (entry.screen.circles || []).filter((x) => !x.removed && !x.typed))
    add({ icon: c.icon, label: c.label, hint: where(pathLabels(p)) }, () => openKnown({ path: pi, entry }, c)); });
  for (const a of knownApplets) if (a.key !== current.key) add({ icon: '🧩', label: a.title, hint: `${a.opens || 0} ×` }, () => openApplet(a.key, a.title));
  return out;
}
// Goes where a known circle lives (a level of this path, another path, or the root) and opens it.
function openKnown(at, c) {
  stopWriting(true);
  if (!at) home();
  else if (at.path != null) {
    switchPath(at.path);
    const i = stack.indexOf(at.entry);
    if (i >= 0) goTo(i);
  } else goTo(at.level);
  const n = [...el.circles.children].find((x) => x.dataset.id === c.id);
  const real = (current.screen.circles || []).find((x) => x.id === c.id) || c;
  openCircle(real, n || null);
}

function rerenderLive() {
  if (current.screen.kind !== 'circles') return;
  renderCircles(current.screen);
  layoutPages(true);
  const ids = [...el.circles.children].map((n) => n.dataset.id);
  setFocus(ids.includes(live.focus) ? live.focus : ids[0]);
  updateGo();
}

// What the user actually typed: the text without an autocompleted (selected) tail.
function typedText() {
  const w = el.write;
  return (w.selectionStart < w.value.length && w.selectionEnd === w.value.length ? w.value.slice(0, w.selectionStart) : w.value);
}

// Autocomplete to the most recent continuation: past texts that start with what is typed.
function typedHistory() { try { return JSON.parse(localStorage.getItem('aiui.typed')) || []; } catch { return []; } }
function rememberTyped(text) {
  const h = [text, ...typedHistory().filter((x) => x !== text)].slice(0, 300);
  try { localStorage.setItem('aiui.typed', JSON.stringify(h)); } catch {}
}
function autocomplete(ev) {
  const w = el.write;
  if (!ev || !/^insert/.test(ev.inputType || '') || w.selectionStart !== w.value.length) return;
  const typed = w.value;
  if (typed.trim().length < 2) return;
  const match = typedHistory().find((x) => x.length > typed.length && x.toLowerCase().startsWith(typed.toLowerCase()));
  if (!match) return;
  w.value = typed + match.slice(typed.length);
  w.setSelectionRange(typed.length, w.value.length);
}

function onInput(ev) {
  autocomplete(ev);
  autosize();
  updateGo();
  const s = current.screen;
  if (s.kind !== 'circles') return;
  const q = typedText().trim();
  if (!q) { live.circles = []; live.focus = '__typed'; }
  else refreshKnownApplets();
  if (live.q !== q) live.understood = null; // the text changed: back to the raw text until re-understood
  if (!focusManual) live.focus = '__typed';
  focusManual = false;
  rerenderLive();
  // Ask the AI for circles inspired by the input once typing pauses.
  clearTimeout(live.timer);
  if (!q || s.local) return;
  if (!paused) live.timer = setTimeout(() => suggestFor(q), 650);
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
    live.understood = r.understood && r.understood.label ? r.understood : null;
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
  if (document.body.classList.contains('immersive')) { el.stage.style.paddingTop = '12px'; el.view.style.top = '0'; return; }
  const top = el.top.getBoundingClientRect().bottom;
  // AI views start right below the header, so the header never covers their content.
  el.view.style.top = Math.round(top + 6) + 'px';
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
  const w = el.write;
  if ((e.key === 'Tab' || e.key === 'End') && !e.shiftKey && w.selectionEnd === w.value.length && w.selectionStart < w.value.length) {
    e.preventDefault();
    w.setSelectionRange(w.value.length, w.value.length);
    return onInput();
  }
  if (kind === 'circles') {
    const empty = !el.write.value;
    // Plain arrows move between the circles; with ⌥/⌘/Shift they edit the text as usual.
    const plain = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
    const map = { Tab: e.shiftKey ? 'prev' : 'next' };
    if (plain) Object.assign(map, { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' });
    if (map[e.key]) { e.preventDefault(); moveFocus(map[e.key]); return; }
    if (e.key === 'Backspace' && empty) { e.preventDefault(); return stopWriting(true); }
  }
  e.stopPropagation();
});

// A click on any empty place opens the text input.
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.pointerType === 'touch') return; // touch: handled as a tap below
  const t = e.target;
  if (t === el.write || t.closest('.circle, #nav, #view iframe, #toast, #close, #who, #webnote, #full')) return;
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
      !target.closest('.circle, #nav, #view, #toast, #close, #write, #who, #full, a, button')) {
    startWriting();
  }
}, { passive: true });

// ---------------------------------------------------------------- keys

function isEditable(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); return toggleConsole(); }
  if (e.metaKey && e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); return showSystem(); }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    const acts = { f: find, '=': () => zoom(1), '+': () => zoom(1), '-': () => zoom(-1), '0': () => zoom(0), p: printScene,
      ']': forward, r: () => (e.shiftKey ? location.reload() : reloadScene()), t: () => typeFromScene(''),
      ...(NATIVE ? {} : { n: () => showNetwork(), i: () => toggleActivityScreen() }) }; // the Mac app's menu has them
    if (acts[k]) { e.preventDefault(); return acts[k](); }
  }
  if (!isEditable(e.target) && current.screen.kind === 'circles' && (e.key === 'Home' || e.key === 'End')) {
    e.preventDefault();
    current.screen.page = e.key === 'Home' ? 0 : lastPage();
    return showPage();
  }
  if (e.key === 'Escape' && ctxOpen) { e.preventDefault(); return closeContext(); }
  if (e.key === 'Escape' && typing()) { e.preventDefault(); return escapeWriting(); }
  if (e.key === 'Escape' && document.body.classList.contains('immersive')) { e.preventDefault(); return setImmersive(false); }
  if (isEditable(e.target)) return;
  const circles = current.screen.kind === 'circles' && !busy; // locked while a circle is generating
  const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Tab: e.shiftKey ? 'prev' : 'next' };
  if (e.key === 'Backspace' && e.repeat) {
    // Held down: once it has repeated for ~half a second, back to the circles.
    e.preventDefault();
    if (!backspaceHeldAt) backspaceHeldAt = performance.now();
    else if (performance.now() - backspaceHeldAt > 450 && !backspaceDone) { backspaceDone = true; backToCircles(); }
    return;
  }
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
// ` toggles the console from anywhere — before any input or scene handler sees it.
window.addEventListener('keydown', (e) => {
  if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target !== el.consoleInput) { e.preventDefault(); e.stopImmediatePropagation(); toggleConsole(); }
}, true);
let backspaceHeldAt = 0, backspaceDone = false;
document.addEventListener('keyup', (e) => { if (e.key === 'Backspace') { backspaceHeldAt = 0; backspaceDone = false; } });

// ---------------------------------------------------------------- misc

function fmtSecs(n) { n = Math.round(n); return n >= 90 ? Math.round(n / 60) + 'm' : n + 's'; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let flashTimer;
function flashStatus(text) {
  el.status.textContent = text;
  if (!activities.size) el.activity.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(renderActivity, 2500);
}

let toastTimer;
function toast(msg) {
  log('error', msg);
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
  asTyped: 'as typed', asUnderstood: 'as understood', typeOnScene: 'Type about this scene — Enter sends, Esc closes',
  typeHint: 'Type — arrows pick a circle, Enter opens it, ⌥Enter new line, Esc closes',
  guest: 'guest', whoTitle: 'Is it still you?',
  whoMsg: 'This session looks different from how you usually use AI UI.',
  whoGuestMsg: 'Guest mode: no personal history is used.',
  itsMe: "It's me", itsMeHint: 'keep going, learn this', someoneElse: 'Someone else', someoneElseHint: 'guest mode',
  aboutYou: 'About you', aboutYouEmpty: 'Nothing learned yet. It builds up as you use the app.',
  tooLong: 'This took too long — try again, or ask differently.',
  fixing: 'this screen got stuck — fixing…', fixed: 'fixed', couldNotFix: 'Could not fix this screen:', stillWorking: 'still working', updated: 'updated', updating: 'updating…',
  improvedLive: 'improved — reloaded live, state kept', returnedTo: 'back to', processes: 'Running now', mediaFailed: 'could not play', checking: 'checking the scene…', scenesTitle: 'Scenes — usage and self-improvement',
  settingsTitle: 'Settings', setPause: 'Pause all background work', setPrefetch: 'Prepare screens while the pointer heads to a circle',
  setRefine: 'Refresh live circles with real data', setMenus: 'AI context menus', setQa: 'Test every scene (layout, interactions, accessibility)',
  setDod: 'Definition of Done + tests for every scene', setQuick: 'Interim screen after', setQaMin: 'Repair scenes scoring below',
  setBudget: 'Libraries + cache budget', setProvider: 'AI provider…', setRetro: 'Run a retrospective now', setLibrarian: 'Review the utility library',
  setClearCache: 'Clear memory cache', setClearAvoid: 'Clear avoid record',
  library: 'Utility library', libraryMsg: 'Code the AI wrote once and reuses across screens. Reviewed now and then.',
  libraryEmpty: 'Empty so far: screens publish reusable code here as the AI builds them.',
  fullscreen: 'Full screen', find: 'Find', system: 'Settings & System', appName: 'AI UI',
  ready: 'ready', paused: 'paused', pause: 'Pause background work', resume: 'Resume background work',
  circlesWord: 'circles', cacheWord: 'cache', hintsWord: 'hints',
  actOpening: 'opening', actAsking: 'asking', actRepairing: 'repairing the screen', actThinking: 'thinking',
  actQuick: 'quick preview', actMore: 'loading more circles', actSuggest: 'suggestions for', actPrefetch: 'preparing',
  actRefine: 'refreshing live data', actTests: 'writing the Definition of Done and its tests', actMenus: 'preparing context menus',
  actTranslate: 'translating the interface', actLearn: 'learning about you', actLibs: 'loading JS libraries',
  actLab: 'testing every interaction (phone, other theme)', actRunDoD: 'running the Definition of Done tests',
  actReview: 'checking layout, readability, accessibility', jsLibs: 'JS libraries',
  nativeLibs: 'Native libraries', setNative: 'Download native libraries',
  actImprove: 'improving', actRevise: 'updating from memory', actComponent: 'improving component', actRetro: 'learning from what went wrong',
  actLibrarian: 'integrating shared components and utilities',
  qaCancel: 'Cancel', qaPause: 'Pause', qaResume: 'Resume', qaStop: 'Stop', qaSkip: 'Skip',
  qaPauseImprove: 'Pause improvements', qaResumeImprove: 'Resume improvements', qaImproveNow: 'Improve now',
  scheduled: 'Scheduled', nextImprove: 'next improvement', improvesPaused: 'improvements paused', dueNow: 'due now',
  nothingRunning: 'Nothing running', versionWord: 'version', utilityLibrary: 'Utility Library', profileTitle: 'What AI UI knows about you',
  network: 'Network', netScan: 'Looking for networks…', netHidden: 'macOS shows network names only with Location access: allow AI UI in System Settings › Privacy & Security › Location Services.',
  netPassword: 'Password for', netConnected: 'connected', netJoining: 'joining', netOn: 'Turn Wi-Fi on', netOff: 'Turn Wi-Fi off',
  netRescan: 'Scan again', netKnown: 'saved', netSecured: 'secured', netOpen: 'open', netNone: 'No networks found',
  actScreen: 'Activity', actGlobal: 'Everywhere', actHere: 'This scene', actRunning: 'Running', actNumbers: 'Numbers',
  actMemory: 'memory', actLoad: 'load', actDisk: 'free disk', actUptime: 'running for', actApplets: 'applets',
  actImproves: 'improvements', actNext: 'next improvement', actIntegration: 'integration', actRemaining: 'left',
  actModules: 'shared modules', actCache: 'memory cache', actLibsInstalled: 'JS libraries', actHints: 'hints', actJournal: 'incidents',
  actEngine: 'AI', actNet: 'network', actPaused: 'background work paused', actOpens: 'opens', actMinutes: 'minutes',
  actInteractions: 'interactions', actFindings: 'findings', actScores: 'scores', actSceneNone: 'Not an applet: nothing scene-specific yet.',
};
for (const c of ROOT.circles) { STR['root.' + c.id] = c.label; STR['root.' + c.id + '.hint'] = c.hint; }

// ---------------------------------------------------------------- AICoin wallet link by QR
// AI UI has a wallet of its own. The AICoin wallet iPhone app links it (CONTRACT.md, "Linked
// wallets"): this screen shows a code with only AI UI's public address, the owner scans it and
// confirms, and AI UI's calls are then paid from the owner's coins up to the limit set there.
// The native side watches the balance for `linked_to` and reports with `aicoinLink` events.

Object.assign(STR, {
  aicoinLink: 'Link AICoin wallet (scan QR)', aicoinLinkHint: 'not linked · scan with the AICoin wallet app',
  aicoinLinked: 'linked', aicoinUnlink: 'Unlink wallet', aicoinCoins: 'coins', aicoinSpendable: 'coins to spend',
  aicoinLinkTitle: 'Link AI UI to your AICoin wallet',
  aicoinLinkSteps: 'Open the AICoin wallet app on your iPhone, tap Scan and point the camera at this code. Check that the address it shows matches the one shown here, then confirm.',
  aicoinLinkNote: 'The code holds only AI UI’s public wallet address. Calls are then paid from your wallet, up to the limit you set there. Unlink any time, here or in the wallet app.',
  aicoinLinkQrAlt: 'Code to scan with the AICoin wallet app', aicoinLinkAddress: 'AI UI wallet',
  aicoinLinkPreparing: 'Preparing the code…', aicoinLinkWaiting: 'Waiting for the AICoin wallet app…',
  aicoinLinkDone: 'Linked to your AICoin wallet', aicoinLinkOwner: 'Owner wallet',
  aicoinLimit: 'Limit', aicoinSpent: 'spent', aicoinNoLimit: 'No limit',
  aicoinLimitReached: 'The link limit is reached. Raise it in the AICoin wallet app.',
  aicoinOwnerEmpty: 'Your AICoin wallet is out of coins. Add coins in the AICoin wallet app.',
  aicoinLinkTimeout: 'Stopped waiting for the wallet app.', aicoinLinkFailed: 'Could not show the code.',
  aicoinUnlinked: 'AICoin wallet: not linked',
  aicoinLinkNew: 'Show the code again', aicoinLinkCancel: 'Cancel', aicoinLinkClose: 'Done',
});

let aicoinLinkView = null;

// Linked, but the next call can't be paid: the link's limit, or the owner's coins.
function aicoinProblem(st) {
  if (!st.linked || (st.spendable != null && st.spendable >= 1)) return '';
  return st.limit != null && st.spent != null && st.spent >= st.limit ? t('aicoinLimitReached') : t('aicoinOwnerEmpty');
}

// Circles for the AI provider screen: link by QR, and unlink once linked.
async function aicoinLinkCircles() {
  let st = {};
  try { st = await call('aicoin', { op: 'status' }); } catch {}
  const hint = !st.linked ? t('aicoinLinkHint')
    : aicoinProblem(st) || `${t('aicoinLinked')} · ${Math.floor(st.spendable ?? 0)} ${t('aicoinSpendable')}`;
  const out = [{ id: 'aicoinLink', label: t('aicoinLink'), icon: '📱', size: 1.1, hint }];
  if (st.linked) out.push({ id: 'aicoinUnlink', label: t('aicoinUnlink'), icon: '🔌', size: 0.8 });
  return out;
}

async function aicoinLinkOpen(c) {
  if (c.id === 'aicoinLink') return showAicoinLink();
  try { await call('aicoin', { op: 'unlink' }); } catch (e) { return toast(e.message); }
  stack.pop();
  return showSetup();
}

function showAicoinLink() {
  closeAicoinLink(false);
  const v = document.createElement('div');
  v.id = 'aicoinlink';
  v.setAttribute('role', 'dialog');
  v.setAttribute('aria-modal', 'true');
  v.setAttribute('aria-labelledby', 'aicoinlink-title');
  v.innerHTML = `<h1 id="aicoinlink-title"></h1>
    <div class="qr" aria-busy="true"><img alt=""></div>
    <p class="addr"><span class="who"></span> <code></code></p>
    <p class="steps"></p><p class="count" aria-live="polite"></p><p class="limit"></p><p class="note"></p>
    <div class="buttons"><button type="button" class="again" hidden></button><button type="button" class="unlink" hidden></button><button type="button" class="close"></button></div>`;
  const $ = (s) => v.querySelector(s);
  $('h1').textContent = t('aicoinLinkTitle');
  $('.steps').textContent = t('aicoinLinkSteps');
  $('.note').textContent = t('aicoinLinkNote');
  $('.count').textContent = t('aicoinLinkPreparing');
  $('.who').textContent = t('aicoinLinkAddress');
  $('img').alt = t('aicoinLinkQrAlt');
  $('.again').textContent = t('aicoinLinkNew');
  $('.unlink').textContent = t('aicoinUnlink');
  $('.close').textContent = t('aicoinLinkCancel');
  $('.again').onclick = () => showAicoinLink();
  $('.unlink').onclick = async () => {
    try { await call('aicoin', { op: 'unlink' }); } catch (e) { return toast(e.message); }
    showAicoinLink();
  };
  $('.close').onclick = () => closeAicoinLink(true);
  const keys = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeAicoinLink(true); }
  };
  window.addEventListener('keydown', keys, true);
  document.body.appendChild(v);
  const view = aicoinLinkView = { el: v, state: 'waiting', keys };
  $('.close').focus();
  call('aicoin', { op: 'link' }).then((r) => {
    if (aicoinLinkView !== view) { call('aicoin', { op: 'cancel' }).catch(() => {}); return; }
    $('img').src = r.qr;
    $('.qr').removeAttribute('aria-busy');
    $('code').textContent = r.short;
    $('code').title = r.address;
    $('.count').textContent = t('aicoinLinkWaiting');
    if (r.linked) aicoinLinkState('connected', r);
  }).catch((e) => aicoinLinkState('failed', { error: e.message }));
}

function aicoinLinkState(state, e) {
  const view = aicoinLinkView;
  if (!view || view.state !== 'waiting') return;
  view.state = state;
  const v = view.el, $ = (s) => v.querySelector(s);
  v.className = state;
  $('.qr').hidden = true;
  $('.note').hidden = true;
  if (state === 'connected') {
    $('h1').textContent = '✓ ' + t('aicoinLinkDone');
    $('.who').textContent = t('aicoinLinkOwner');
    $('code').textContent = e.ownerShort || '';
    $('code').title = e.owner || '';
    const problem = aicoinProblem(e);
    $('.steps').textContent = problem;
    $('.steps').classList.toggle('problem', !!problem);
    $('.count').textContent = `${Math.floor(e.spendable ?? e.balance ?? 0)} ${t('aicoinSpendable')}`;
    $('.limit').textContent = e.limit != null
      ? `${t('aicoinLimit')} ${e.limit} · ${t('aicoinSpent')} ${Math.round((e.spent ?? 0) * 10) / 10}`
      : ('limit' in e || e.spent != null ? t('aicoinNoLimit') : '');
    $('.unlink').hidden = false;
    $('.close').textContent = t('aicoinLinkClose');
  } else {
    $('.addr').hidden = true;
    $('.steps').textContent = state === 'timeout' ? t('aicoinLinkTimeout') : t('aicoinLinkFailed');
    $('.count').textContent = state === 'failed' && e && e.error ? e.error : '';
    $('.again').hidden = false;
    $('.again').focus();
  }
}

function closeAicoinLink(user) {
  const view = aicoinLinkView;
  if (!view) return;
  aicoinLinkView = null;
  window.removeEventListener('keydown', view.keys, true);
  view.el.remove();
  if (view.state === 'waiting') call('aicoin', { op: 'cancel' }).catch(() => {});
  if (user && view.state === 'connected') { home(); flashStatus('🪙 AICoin'); }
}

function onAicoinLink(e) {
  if (e.state === 'connected') {
    log('done', '🪙 AICoin wallet linked');
    if (aicoinLinkView) aicoinLinkState('connected', e);
    else { home(); flashStatus('🪙 AICoin'); }
  } else if (e.state === 'unlinked') {
    // The owner removed the link in the wallet app (or it was unlinked here).
    flashStatus(t('aicoinUnlinked'));
    if (aicoinLinkView && aicoinLinkView.state === 'connected') showAicoinLink();
    else if (current.screen.local === 'setup') { stack.pop(); showSetup(); }
  } else if (aicoinLinkView) aicoinLinkState(e.state, e);
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
  if (paused || !settings.prefetch) return;
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
  if (paused || !settings.refine) return;
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
  pushPath({
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
  pushPath({
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

// ---------------------------------------------------------------- full screen
// A screen that promotes itself as full-screen (games, media, reading) gets a ⤢ button: the
// window goes full screen (native on the Mac, the browser's on the web) and the chrome steps
// aside; Esc or ⤡ comes back.

function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  el.full.textContent = on ? '⤡' : '⤢';
  el.full.title = on ? 'Esc' : t('fullscreen');
  if (NATIVE && !IOS_BRIDGE) call('window', { op: 'fullscreen', on }).catch(() => {});
  else if (!NATIVE && document.fullscreenEnabled) {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  fitStage();
  requestAnimationFrame(() => layoutPages(true));
}
el.full.addEventListener('click', (e) => { e.stopPropagation(); setImmersive(!document.body.classList.contains('immersive')); });
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('immersive')) setImmersive(false);
});

// ---------------------------------------------------------------- system scene (⇧⌘D)

const fmtBytes = (n) => { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B'; };

async function showSystem() {
  let d;
  try { d = await call('system'); } catch (e) { return toast(e.message); }
  try { d.scenes = (await callRaw('usage', { op: 'list' })).scenes; } catch {}
  if (NATIVE && !IOS_BRIDGE) try { d.native = await callRaw('native', { op: 'status' }); } catch {}
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const list = (a) => (a && a.length) ? '<ul>' + a.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<span class="m">—</span>';
  const sec = (title, rows) => `<section><h2>${esc(title)}</h2><table>${rows.join('')}</table></section>`;
  const a = d.app || {}, ai = d.ai || {}, st = d.storage || {}, c = d.cache || {}, l = d.libraries || {}, u = d.utilities || {},
    p = d.profile || {}, av = d.avoid || {};
  const cfg = settings, budgetGB = (d.storage && d.storage.sharedBudget) ? (d.storage.sharedBudget / 1e9).toFixed(1) : '';
  const tog = (k, label) => `<label class="opt"><input type="checkbox" data-k="${k}" ${cfg[k] ? 'checked' : ''}> ${esc(label)}</label>`;
  const num = (k, label, min, max, unit) => `<label class="opt">${esc(label)} <input type="number" data-k="${k}" min="${min}" max="${max}" value="${esc(cfg[k])}"> ${esc(unit)}</label>`;
  const settingsHtml = `<section class="settings"><h2>${esc(t('settingsTitle'))}</h2>
    <div class="opts">
      <label class="opt"><input type="checkbox" data-a="pause" ${paused ? 'checked' : ''}> ${esc(t('setPause'))}</label>
      ${tog('prefetch', t('setPrefetch'))}${tog('refine', t('setRefine'))}${tog('menus', t('setMenus'))}
      ${tog('qa', t('setQa'))}${tog('dod', t('setDod'))}
      ${num('quickAfter', t('setQuick'), 1, 60, 's')}${num('qaMin', t('setQaMin'), 0, 100, '/ 100')}
      <label class="opt">${esc(t('setBudget'))} <input type="number" data-a="budget" min="0.5" max="100" step="0.5" value="${budgetGB}"> GB</label>
      ${nativeSettingHtml(d.native)}
    </div>
    <div class="btns">
      <button data-a="zoom" data-arg="-1">−</button><button data-a="zoom" data-arg="0">100%</button><button data-a="zoom" data-arg="1">+</button>
      <button data-a="provider">${esc(t('setProvider'))}</button><button data-a="retro">${esc(t('setRetro'))}</button>
      <button data-a="librarian">${esc(t('setLibrarian'))}</button><button data-a="clearCache">${esc(t('setClearCache'))}</button>
      <button data-a="clearAvoid">${esc(t('setClearAvoid'))}</button>
    </div>
    <script>
      for (const i of document.querySelectorAll('[data-k]')) i.addEventListener('change', () => aiui.setting(i.dataset.k, i.type === 'checkbox' ? i.checked : Number(i.value)));
      for (const i of document.querySelectorAll('input[data-a]')) i.addEventListener('change', () => aiui.action(i.dataset.a, i.type === 'checkbox' ? i.checked : Number(i.value)));
      for (const b of document.querySelectorAll('button[data-a]')) b.addEventListener('click', () => aiui.action(b.dataset.a, b.dataset.arg));
    <\/script></section>`;
  const html = `<style>
    .settings .opts{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px 18px;margin-bottom:10px}
    .opt{display:flex;align-items:center;gap:8px;min-height:32px}
    .opt input[type=number]{width:64px;padding:4px 6px;border-radius:6px;border:1px solid var(--line);background:var(--chip);color:var(--fg)}
    .btns{display:flex;flex-wrap:wrap;gap:8px}
    .scenes{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
    .scene{display:flex;flex-direction:column;gap:3px;font-size:12px}
    .scene img,.noshot{width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top;border-radius:8px;border:1px solid var(--line);background:var(--surface)}
    .scene span{color:var(--muted)}
    .btns button{min-height:32px;padding:4px 12px;border-radius:16px;border:1px solid var(--line);background:var(--chip);color:var(--fg);cursor:pointer}
    .btns button:hover{border-color:var(--accent);color:var(--accent)}
    body{font:13px/1.5 -apple-system,system-ui,sans-serif}
    section{margin:0 0 18px;padding:14px 18px;border-radius:14px;background:var(--surface)}
    h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
    table{border-collapse:collapse;width:100%} th{text-align:left;font-weight:500;color:var(--muted);width:34%;padding:3px 10px 3px 0;vertical-align:top}
    td{padding:3px 0;word-break:break-word} ul{margin:0;padding-left:18px} .m{color:var(--faint)}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:0 18px}
  </style>${settingsHtml}<div class="grid">
  ${sec('App', [row('Version', esc(`${a.version || '—'} (${a.build || '—'})`)), row('Bundle', esc(a.bundle || 'web')),
    row('Platform', esc(a.platform || navigator.userAgent)), row('Language', esc(a.language || LANG)),
    row('Prompt generation', esc(a.generation || '—'))])}
  ${sec('AI', [row('Active', esc(ai.active ? ai.active.label : 'none')),
    row('Available', esc((ai.options || []).map((o) => o.label).join(', ') || '—'))])}
  ${sec('Storage', [row('Data', esc(st.icloud ? 'iCloud (synced)' : 'this device only')), row('Folder', esc(st.root || 'browser storage')),
    row('Free disk', esc(fmtBytes(st.freeBytes))), row('Shared budget (libraries + cache)', esc(fmtBytes(st.sharedBudget)))])}
  ${sec('Memory cache', [row('Entries', esc(c.entries)), row('Used', esc(fmtBytes(c.bytes) + ' of ' + fmtBytes(c.limitBytes)))])}
  ${sec('JS libraries', [row('Installed', esc(`${l.installed ?? '—'} of ${l.catalog ?? '—'} in the catalog`)),
    row('Disk', esc(fmtBytes(l.usedBytes) + ' of ' + fmtBytes(l.budgetBytes))),
    row('Installing now', esc((l.installing || []).join(', ') || '—'))])}
  ${nativeSection(d.native, sec, row)}
  ${sec('Utility library', [row('Modules', esc(u.total ?? 0)), row('Last review', esc(u.lastReview || '—'))])}
  ${sec('You', [row('Traits learned', esc(p.traits ?? 0)), row('Most certain', list(p.top)),
    row('Session check', esc(who.guest ? 'guest mode' : who.suspect ? 'looks like someone else: ' + who.suspect.join('; ') : 'normal'))])}
  ${sec('Avoid record', [row('Active', list(av.active)), row('All entries', esc(av.all ?? 0))])}
  ${sec('Last scene quality', lastQuality ? [row('Scene', esc(lastQuality.title || '—')),
    ...[['On screen', lastQuality.screen], ['Phone · other theme (lab)', lastQuality.lab]].filter(([, q]) => q).map(([k, q]) =>
      row(k, esc(`UX ${q.scores.ux} · readability ${q.scores.readability} · accessibility ${q.scores.accessibility}` +
        (q.scores.security != null ? ` · security ${q.scores.security}` : '')) + list(q.issues) +
        (q.corners && q.corners.length ? '<ul>' + q.corners.map((c) => `<li>${c.ok ? '✓' : '✗'} ${esc(c.case)} — ${esc(c.note)}</li>`).join('') + '</ul>' : '')))]
    : [row('Scene', '<span class="m">no AI scene yet</span>')])}
  ${lastQuality && lastQuality.dod && lastQuality.dod.length ? sec('Definition of Done (last scene)', lastQuality.dod.map((d) =>
    row((d.ok === true ? '✓ ' : d.ok === false ? '✗ ' : '· ') + d.text, esc(d.notes.join('; ') || (d.ok ? 'met' : d.ok === false ? 'not met' : 'untested'))))) : ''}
  ${lastQuality && lastQuality.tests ? sec('DoD tests', lastQuality.tests.map((x) => row((x.ok ? '✓ ' : '✗ ') + x.name, esc(x.note)))) : ''}
  ${(() => { const sc = (d.scenes || []); if (!sc.length) return ''; return `<section><h2>${esc(t('scenesTitle'))}</h2><div class="scenes">` +
    sc.map((x) => `<div class="scene">${x.shot ? `<img alt="${esc(x.title)}" src="${x.shot}">` : '<div class="noshot"></div>'}
      <b>${esc(x.title || '—')}</b><span>${esc(`opened ${x.opens}× · ${x.minutes} min · ${x.interactions} actions · improved ${x.improves}×`)}</span>
      <span>${esc(x.nextImprove ? 'next improvement ' + new Date(x.nextImprove).toLocaleString() : '')}</span></div>`).join('') + '</div></section>'; })()}
  ${(() => { const h = d.hints || {}; return sec('Retrospective', [row('Journal', esc(`${h.journal ?? 0} incidents (${h.sinceRetro ?? 0} since the last retrospective)`)),
    row('Last retrospective', esc(h.lastRetro || 'not yet') + (h.summary ? '<br>' + esc(h.summary) : '')),
    row('Hints for future screens', list((h.hints || []).map((x) => `${x.text} — ${x.scope}, ×${x.evidence}`))),
    row('Recent incidents', list((h.recent || []).map((x) => `${x.kind} · ${x.scene}: ${x.detail}`)))]); })()}
  ${sec('Context menus', [row('Generation (median)', esc(median(ctxTiming.gen) != null ? fmtSecs(median(ctxTiming.gen) / 1000) : '—')),
    row('First use after a scene appears (median)', esc(median(ctxTiming.use) != null ? fmtSecs(median(ctxTiming.use) / 1000) : '—')),
    row('Strategy', esc(median(ctxTiming.gen) != null && median(ctxTiming.use) != null && median(ctxTiming.gen) >= median(ctxTiming.use)
      ? 'generate as soon as a scene renders' : 'generate when the scene is idle'))])}
  </div><script>aiui.ready()<\/script>`;
  pushPath({ kind: 'html', local: 'system', title: t('system'), back: true, html }, t('system'));
}

// ---------------------------------------------------------------- network (⌘N)
async function showNetwork(refresh = false) {
  // A transition hold: the network path shows at once ("looking for networks…"), and a rescan
  // keeps the list dimmed and pulsing until the new one arrives; nothing unrelated in between.
  if (refresh && current.screen.local === 'network') {
    el.message.textContent = t('netScan');
    el.circles.classList.add('holding');
  } else {
    pushPath({ kind: 'circles', local: 'network', more: false, back: true, title: t('network'), message: t('netScan'), circles: [] }, t('network'));
  }
  const entry = current;
  let r;
  try { r = await call('network', { op: 'scan' }); } catch (e) { el.circles.classList.remove('holding'); return toast(e.message); }
  const bars = (rssi) => rssi >= -55 ? '▂▄▆█' : rssi >= -67 ? '▂▄▆' : rssi >= -78 ? '▂▄' : '▂';
  const circles = (r.networks || []).map((n) => ({
    id: 'net:' + n.ssid, ssid: n.ssid, secure: n.secure, known: n.known,
    icon: n.current ? '📶' : n.secure ? '🔒' : '📡', label: n.ssid, selected: !!n.current,
    hint: [bars(n.rssi), n.band, n.current ? t('netConnected') : n.known ? t('netKnown') : n.secure ? t('netSecured') : t('netOpen')].filter(Boolean).join(' · '),
  }));
  circles.push({ id: 'net:rescan', icon: '🔄', label: t('netRescan'), size: 0.8 });
  circles.push({ id: 'net:power', icon: '⏻', label: r.power === false ? t('netOn') : t('netOff'), size: 0.8 });
  const screen = { kind: 'circles', local: 'network', more: false, back: true, title: t('network'),
    message: r.error ? r.error : (r.hidden || r.locationAllowed === false) && !(r.networks || []).length ? t('netHidden') : !(r.networks || []).length ? t('netNone') : '',
    circles };
  el.circles.classList.remove('holding');
  entry.screen = screen;                // wherever the user is now; shown if still there
  if (current === entry) render();
}
async function networkOpen(c) {
  if (c.selected && c.ssid) { flashStatus(`📶 ${c.ssid} · ${t('netConnected')}`); return; }
  if (c.id === 'net:rescan') return showNetwork(true);
  if (c.id === 'net:power') {
    try { await call('network', { op: 'power', on: c.label === t('netOn') }); } catch (e) { return toast(e.message); }
    return showNetwork(true);
  }
  if (c.secure && !c.known) {
    return push({ kind: 'text', local: 'wifipass', ssid: c.ssid, go: 'OK', title: `${t('netPassword')} «${c.ssid}»`, message: '', text: '' }, c.ssid);
  }
  return joinNetwork(c.ssid, '');
}
async function joinNetwork(ssid, password) {
  flashStatus(`${t('netJoining')} «${ssid}»…`);
  let r;
  try { r = await call('network', { op: 'connect', ssid, password }); } catch (e) { return toast(e.message); }
  if (!r.ok && r.needsPassword && !password) {
    return push({ kind: 'text', local: 'wifipass', ssid, go: 'OK', title: `${t('netPassword')} «${ssid}»`, message: '', text: '' }, ssid);
  }
  if (!r.ok) return toast(String(r.error || 'failed').split('\n')[0]);
  if (current.screen.local === 'wifipass') { stopWriting(true); current = stack.pop(); }
  flashStatus(`📶 ${ssid} · ${t('netConnected')}`);
  return showNetwork(true);
}

async function showJSLibraries() {
  let r;
  try { r = await call('libraries', { op: 'list' }); } catch (e) { return toast(e.message); }
  const inst = (r.libraries || []).filter((x) => x.installed);
  pushPath({
    kind: 'circles', local: 'jslibs', more: false, back: true, title: t('jsLibs'),
    message: `${inst.length} / ${(r.libraries || []).length} · ${fmtBytes(r.used)} / ${fmtBytes(r.budget)}`,
    circles: inst.sort((a, b) => (b.uses || 0) - (a.uses || 0)).map((x) => ({
      id: 'js:' + x.id, icon: '📦', label: x.id, hint: x.description, value: x.uses || undefined, jslib: x.id })),
  }, t('jsLibs'));
}

// ---------------------------------------------------------------- context menus
// Right-click (long press on touch) on any object: a menu of actions for its class, generated by
// the AI in the background for every class on the scene — and the AI decides per class whether a
// menu is useful at all. Timing medians (generation time vs. how soon menus get used) decide
// whether generation starts at once or when the scene is idle.

const ctxTiming = (() => { try { return JSON.parse(localStorage.getItem('aiui.ctxTiming')) || { gen: [], use: [] }; } catch { return { gen: [], use: [] }; } })();
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
function noteTiming(kind, ms) {
  ctxTiming[kind] = [...(ctxTiming[kind] || []), Math.round(ms)].slice(-30);
  try { localStorage.setItem('aiui.ctxTiming', JSON.stringify(ctxTiming)); } catch {}
}

function scheduleMenus(s, classes) {
  if (paused || !settings.menus) return;
  if (s.menus || s.menusPending) return;
  // Start at once when menus tend to be wanted sooner than they take to make; else when idle.
  const g = median(ctxTiming.gen), u = median(ctxTiming.use);
  const delay = g != null && u != null && g >= u ? 0 : 1500;
  s.menusPending = true;
  setTimeout(() => { if (current.screen === s) generateMenus(s, classes); }, delay);
}

async function generateMenus(s, classes) {
  if (s.menus) return s.menus;
  if (s.menusPromise) return s.menusPromise;
  const t0 = performance.now();
  s.menusPromise = call('menus', {
    screen: summary(s), classes: [...new Set(classes)], path: [...stack.map((e) => e.label), current.label].filter(Boolean), language: LANG,
  }).then((r) => {
    noteTiming('gen', performance.now() - t0);
    s.menus = {};
    for (const c of r.classes || []) s.menus[c.class] = { enabled: !!c.enabled, actions: (c.actions || []).slice(0, 6) };
    if (ctxOpen && ctxOpen.screen === s) renderContext();
    return s.menus;
  }).catch(() => { s.menusPromise = null; s.menusPending = false; return null; });
  return s.menusPromise;
}

let ctxOpen = null; // { screen, cls, object, x, y }
function openContext(cls, object, x, y) {
  const s = current.screen;
  if (s.local || busy) return;
  if (s.shownAt && !s.ctxUsed) { s.ctxUsed = true; noteTiming('use', Date.now() - s.shownAt); }
  ctxOpen = { screen: s, cls, object, x, y };
  if (!s.menus || !s.menus[cls]) generateMenus(s, [cls, ...(s.quality && s.quality.screen && s.quality.screen.classes || [])]);
  renderContext();
}

function renderContext() {
  if (!ctxOpen) return;
  const { screen: s, cls, x, y } = ctxOpen;
  const m = s.menus && s.menus[cls];
  if (m && !m.enabled) return closeContext(); // the AI decided: no menu for this class here
  el.ctx.innerHTML = '';
  if (!m) {
    el.ctx.innerHTML = `<div class="ctx-wait">…</div>`;
  } else {
    for (const a of m.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<span class="ctx-icon">${esc(a.icon || '•')}</span>${esc(a.label)}`;
      b.addEventListener('click', (e) => { e.stopPropagation(); runContextAction(a); });
      el.ctx.appendChild(b);
    }
  }
  el.ctx.hidden = false;
  const w = el.ctx.offsetWidth, h = el.ctx.offsetHeight;
  el.ctx.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  el.ctx.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
}

function closeContext() { ctxOpen = null; el.ctx.hidden = true; }

async function runContextAction(a) {
  const { cls, object } = ctxOpen || {};
  closeContext();
  const text = object.href || object.text || object.label || '';
  try {
    if (a.kind === 'copy') { await aiui.sys({ op: 'clipboard', text: object.text || object.href || object.label || '' }); return flashStatus('⧉'); }
    if (a.kind === 'open' && (object.href || object.src)) return aiui.sys({ op: 'open', target: object.href || object.src });
    if (a.kind === 'select' && object.circle) {
      const c = (current.screen.circles || []).find((x) => x.id === object.circle);
      const n = [...el.circles.children].find((x) => x.dataset.id === object.circle);
      if (c && n) return toggleSelect(c, n);
    }
    if (a.kind === 'share' && navigator.share) return navigator.share({ text });
  } catch {}
  ask({ event: 'context', action: { id: a.id, label: a.label, prompt: a.prompt || a.label }, class: cls, object }, { label: a.label });
}

// Circles screens: right-click / long press on a circle or on empty space.
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('#ctx')) return;
  const node = e.target.closest('.circle');
  e.preventDefault();
  if (current.screen.kind !== 'circles') return;
  const c = node && (current.screen.circles || []).find((x) => x.id === node.dataset.id);
  openContext(node ? 'circle' : 'empty-space', c ? { circle: c.id, label: c.label, text: c.label + (c.hint ? ' — ' + c.hint : '') } : {}, e.clientX, e.clientY);
});
let ctxHold = 0;
document.addEventListener('touchstart', (e) => {
  const node = e.target.closest && e.target.closest('.circle');
  if (!node || current.screen.kind !== 'circles') return;
  const p = e.touches[0];
  ctxHold = setTimeout(() => {
    const c = (current.screen.circles || []).find((x) => x.id === node.dataset.id);
    suppressTap = true;
    openContext('circle', c ? { circle: c.id, label: c.label, text: c.label } : {}, p.clientX, p.clientY);
  }, 550);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) document.addEventListener(ev, () => clearTimeout(ctxHold), { passive: true });
let suppressTap = false;
document.addEventListener('click', (e) => { if (suppressTap) { suppressTap = false; e.stopPropagation(); e.preventDefault(); } }, true);
document.addEventListener('pointerdown', (e) => { if (ctxOpen && !e.target.closest('#ctx')) closeContext(); }, true);

// ---------------------------------------------------------------- journal (for retrospectives)
// What went wrong goes to the journal; the retrospective turns it into hints for future screens.
function journal(kind, s, detail) {
  log('journal', `${kind} · ${(s && s.title) || ''}: ${String(detail || '').slice(0, 300)}`);
  call('journal', { kind, scene: (s && (s.title || s.kind)) || '', detail: String(detail || '').slice(0, 400) }).catch(() => {});
}

// ---------------------------------------------------------------- browser hotkeys
// ⌘F find, ⌘= ⌘- ⌘0 zoom, ⌘R reload scene (⌘⇧R the app), ⌘[ ⌘] back/forward, ⌘P print,
// Home/End first/last page. On the Mac the menu sends these; elsewhere the keys do.

let forwardStack = [];
let zoomLevel = Number(localStorage.getItem('aiui.zoom')) || 1;
function applyZoom() { document.body.style.zoom = zoomLevel === 1 ? '' : String(zoomLevel); layoutPages(true); }
function zoom(dir) {
  const steps = [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const i = steps.indexOf(steps.reduce((a, b) => Math.abs(b - zoomLevel) < Math.abs(a - zoomLevel) ? b : a));
  zoomLevel = dir === 0 ? 1 : steps[Math.max(0, Math.min(steps.length - 1, i + dir))];
  try { localStorage.setItem('aiui.zoom', String(zoomLevel)); } catch {}
  applyZoom();
  flashStatus(Math.round(zoomLevel * 100) + '%');
}
async function reloadScene() {
  await handoffMedia();
  const s = current.screen;
  for (const k of ['reviewed', 'ready', 'labbed', 'testsRequested', 'health', 'failures', 'quality']) delete s[k];
  render();
}
function forward() {
  if (!forwardStack.length) return;
  stack.push(current);
  current = forwardStack.pop();
  stopWriting(true);
  render();
}
function find() {
  const s = current.screen;
  if (s.kind === 'html') {
    const q = prompt(t('find'));
    if (!q) return;
    const f = el.view.querySelector('iframe');
    if (f) f.contentWindow.postMessage({ aiuiFind: q }, '*');
  } else startWriting(el.write.value || '');
}
function printScene() {
  const f = el.view.querySelector('iframe');
  if (current.screen.kind === 'html' && f) f.contentWindow.postMessage({ aiuiPrint: true }, '*');
  else window.print();
}
if (zoomLevel !== 1) applyZoom();

// ---------------------------------------------------------------- status bar
// Left: ⏸/▶ pauses all background work, ⚙ opens Settings. Right: what exactly is happening —
// every activity titles itself; when all is done, a summary of the current state.

const activities = new Map(); // id → { title, detail, at }
let lastDone = null;          // { title, ms }
// Each activity remembers where it belongs: the history entry it started from, or the applet
// (scene key) a native background job works on — clicking it in the list goes there.
function activityStart(id, title, key, native = false, actions = null) {
  const prev = activities.get(id);
  activities.set(id, { title, at: prev ? prev.at : performance.now(), entry: native ? null : current,
    key: key || (native ? null : current.key) || null, actions, detail: prev && prev.detail });
  renderActivity();
  if (!prev || prev.title !== title) log('activity', '▶ ' + title);
}
// Native activities come with their kind and name, titled here in the user's language.
function nativeTitle(e) {
  const v = e.detail ? ' · ' + e.detail : '';
  switch (e.kind) {
    case 'improve': return `${t('actImprove')} «${e.name || ''}»${v}`;
    case 'component': return `${t('actComponent')} ${e.name || ''}${v}`;
    case 'retro': return t('actRetro');
    case 'librarian': return t('actLibrarian') + v;
    default: return e.title;
  }
}
function nativeActions(e) {
  const act = (action) => () => callRaw('activity', { id: e.id, action }).catch(() => {});
  const all = {
    cancel: { icon: '✕', label: t('qaCancel'), run: act('cancel') },
    pause: { icon: '⏸', label: t('qaPauseImprove'), run: act('pause') },
  };
  return (e.actions || []).map((a) => all[a]).filter(Boolean);
}
// Quick actions of the app's own activities (by kind), unless the activity brought its own.
function activityActions(id, a) {
  if (a.actions) return a.actions;
  const k = String(id).split(/[:\-]/)[0];
  if (k === 'ai') return [{ icon: '✕', label: t('qaCancel'), run: () => (busy ? cancel() : callRaw('cancel').catch(() => {})) }];
  if (CHANNEL[k]) return [{ icon: '✕', label: t('qaCancel'), run: () => callRaw('cancel', { [CHANNEL[k]]: true }).catch(() => {}) }];
  if (k === 'lab') return [{ icon: '⏭', label: t('qaSkip'), run: () => { if (labFor) { labFor.frame.remove(); labFor = null; } activityEnd('lab'); } }];
  if (k === 'review') return [{ icon: '⏭', label: t('qaSkip'), run: () => revealView() }];
  if (k === 'media') return [
    player.paused ? { icon: '▶', label: t('qaResume'), run: () => mediaResume() } : { icon: '⏸', label: t('qaPause'), run: () => mediaPause() },
    { icon: '■', label: t('qaStop'), run: () => mediaStop() }];
  return [];
}
// A scene's own activity (aiui.activity): it lasts while the scene is in the history.
function sceneActivity(id, title, actions) {
  const aid = 'scene:' + String(id);
  if (!title) return activityEnd(aid);
  activityStart(aid, String(title), null, false, actions.filter((a) => typeof a.run === 'function'));
}
function activityDetail(id, detail) { const a = activities.get(id); if (a) { a.detail = detail; renderActivity(); } }
function activityEnd(id) {
  const a = activities.get(id);
  if (!a) return;
  activities.delete(id);
  lastDone = { title: a.title, ms: performance.now() - a.at };
  log('done', `✓ ${a.title} · ${fmtSecs(lastDone.ms / 1000)}`);
  renderActivity();
}
let snapshot = null;
async function refreshSnapshot() {
  try {
    const d = await callRaw('system');
    snapshot = { cache: d.cache && d.cache.entries, libs: d.libraries && d.libraries.installed, catalog: d.libraries && d.libraries.catalog,
      hints: d.hints && d.hints.hints ? d.hints.hints.length : 0 };
    renderActivity();
  } catch {}
}
// When several things happen at once, the bar shows the one that matters most to the user:
// what they wait for first (the screen they asked for), then what shapes the screen on display,
// then background work; the newest wins a tie. The rest are counted and listed in the tooltip.
const ACT_RANK = { ai: 100, fix: 95, quick: 90, more: 85, suggest: 80, review: 70, lab: 65, tests: 60, refine: 55, translate: 50,
  menus: 40, prefetch: 35, media: 30, improve: 20, component: 18, librarian: 15, retro: 12, lib: 10, discover: 5 };
const BACKGROUND_KINDS = new Set(['menus', 'prefetch', 'refine', 'improve', 'component', 'librarian', 'retro', 'lib', 'discover', 'translate']);
function actRank(id) {
  const k = String(id).split(/[:\-]/)[0];
  return ACT_RANK[k] ?? 25;
}
// Clicking the activity text expands the running processes upwards: each row goes to its scene
// and offers its quick actions; below, what is scheduled for the applet on screen.
function toggleProcs(on = el.procs.hidden) {
  el.procs.hidden = !on;
  if (!el.procs.hidden) { renderProcs(); loadSchedule(); }
}
let schedule = null; // the applet on screen: its next improvement
async function loadSchedule() {
  const key = current.key;
  if (!key || current.screen.kind !== 'html') { schedule = null; return renderProcs(); }
  try { const r = await callRaw('usage', { op: 'schedule', key }); schedule = r && r.schedule ? { ...r.schedule, entry: current } : null; } catch { schedule = null; }
  if (!el.procs.hidden) renderProcs();
}
function scheduleText(sc) {
  const c = sc.schedule || {};
  const curve = c.curve === 'formula' ? `ƒ ${c.formula || ''}` : c.curve + (c.factor ? ` ×${c.factor}` : '');
  const left = sc.next ? Math.round((sc.next - Date.now()) / 1000) : null;
  const when = sc.paused ? t('improvesPaused') : left == null ? '' : left <= 0 ? t('dueNow') : fmtSecs(left);
  return { title: `${t('nextImprove')} «${sc.title || current.screen.title || ''}»`,
    sub: `${t('versionWord')} ${(sc.improves || 0) + 1} · ${curve}${c.max ? ' · ≤ ' + fmtSecs(c.max) : ''}`, when };
}
function procRow(id) {
  let row = el.procs.querySelector(`.proc[data-id="${CSS.escape(id)}"]`);
  if (row) return row;
  row = document.createElement('div');
  row.className = 'proc'; row.dataset.id = id; row.setAttribute('role', 'group');
  row.innerHTML = '<button type="button" class="p-main" role="menuitem"><span class="p-title"></span><span class="p-sub"></span></button>' +
    '<span class="p-time"></span><span class="p-acts"></span>';
  return row;
}
function fillRow(row, { title, sub, time, actions, go }) {
  row.querySelector('.p-title').textContent = title;
  const subEl = row.querySelector('.p-sub');
  subEl.textContent = sub || ''; subEl.hidden = !sub;
  row.querySelector('.p-time').textContent = time || '';
  const main = row.querySelector('.p-main');
  main.disabled = !go; main.onclick = go ? (e) => { e.stopPropagation(); el.procs.hidden = true; go(); } : null;
  const sig = actions.map((a) => a.icon + a.label).join('|');
  const box = row.querySelector('.p-acts');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig; box.textContent = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'p-act'; b.textContent = a.icon; b.title = a.label; b.setAttribute('aria-label', a.label);
      box.appendChild(b);
    }
  }
  // Always the current handlers (the row's state may have changed since it was built).
  [...box.children].forEach((b, i) => {
    const a = actions[i];
    b.onclick = a ? async (e) => { e.stopPropagation(); try { await a.run(); } catch {} setTimeout(() => { renderActivity(); loadSchedule(); }, 150); } : null;
  });
}
function renderProcs() {
  if (el.procs.hidden) return;
  const list = [...activities.entries()].map(([id, a]) => ({ id, ...a, rank: actRank(id) })).sort((a, b) => b.rank - a.rank || b.at - a.at);
  let head = el.procs.querySelector('h4.p-now');
  if (!head) { el.procs.textContent = ''; head = document.createElement('h4'); head.className = 'p-now'; el.procs.appendChild(head); }
  head.textContent = t('processes');
  const keep = new Set();
  let after = head;
  if (!list.length) {
    const row = procRow('-none');
    fillRow(row, { title: t('nothingRunning'), actions: [] }); row.classList.add('empty');
    keep.add(row); after.after(row); after = row;
  }
  for (const a of list) {
    const row = procRow(a.id);
    const where = a.entry ? (a.entry.label || a.entry.screen.title || '') : '';
    const detail = a.detail && a.detail !== a.title ? a.detail : '';
    const target = a.entry && a.entry !== current ? a.entry : a.key ? a.key : null;
    fillRow(row, { title: a.title, sub: [detail, where].filter(Boolean).join(' · '), time: fmtSecs((performance.now() - a.at) / 1000),
      actions: activityActions(a.id, a), go: target ? () => goToActivity(a) : null });
    keep.add(row); after.after(row); after = row;
  }
  let h2 = el.procs.querySelector('h4.p-sched');
  if (schedule && schedule.entry === current) {
    if (!h2) { h2 = document.createElement('h4'); h2.className = 'p-sched'; }
    h2.textContent = t('scheduled'); keep.add(h2); after.after(h2); after = h2;
    const row = procRow('-schedule');
    const x = scheduleText(schedule), key = schedule.key;
    fillRow(row, { title: x.title, sub: x.sub, time: x.when, actions: [
      { icon: '↻', label: t('qaImproveNow'), run: () => callRaw('usage', { op: 'improve', key }) },
      schedule.paused ? { icon: '▶', label: t('qaResumeImprove'), run: () => callRaw('usage', { op: 'pause', key, on: false }) }
        : { icon: '⏸', label: t('qaPauseImprove'), run: () => callRaw('usage', { op: 'pause', key, on: true }) }] });
    keep.add(row); after.after(row); after = row;
  }
  for (const n of [...el.procs.children]) if (!keep.has(n) && n !== head) n.remove();
}
// ---------------------------------------------------------------- activity screen (⌘I, ⓘ)
// Full screen, live: everything running and the app's numbers (everywhere), and what concerns
// the scene on display (its activities, improvement schedule, usage, quality).
let actLive = null, actTimer = 0;
function toggleActivityScreen(on = el.actscreen.hidden) {
  el.actscreen.hidden = !on;
  clearInterval(actTimer);
  if (!on) { el.infoBtn.focus(); return; }
  el.procs.hidden = true;
  el.actTitle.textContent = t('actScreen');
  renderActivityScreen();
  loadLive();
  let n = 0;
  actTimer = setInterval(() => { renderActivityScreen(); if (++n % 3 === 0) loadLive(); }, 1000);
  el.actClose.focus();
}
async function loadLive() {
  try {
    const [live, sys] = await Promise.all([callRaw('live', { key: current.screen.kind === 'html' ? current.key || '' : '' }), snapshotFull()]);
    actLive = { ...live, sys, at: Date.now() };
  } catch {}
  renderActivityScreen();
}
let sysCache = null, sysAt = 0;
async function snapshotFull() {
  if (sysCache && Date.now() - sysAt < 15000) return sysCache;
  try { sysCache = await callRaw('system'); sysAt = Date.now(); } catch {}
  return sysCache;
}
function actRows(list) {
  return list.map(([label, value]) => `<div class="a-num"><span class="a-label">${esc(label)}</span><span class="a-value">${esc(value)}</span></div>`).join('');
}
function renderActivityScreen() {
  if (el.actscreen.hidden) return;
  const L = actLive || {}, P = L.process || {}, U = L.usage || {}, S = L.sys || {}, N = L.network || {};
  const all = [...activities.entries()].map(([id, a]) => ({ id, ...a, rank: actRank(id) })).sort((a, b) => b.rank - a.rank || b.at - a.at);
  // This scene: work bound to it (its AI requests, checks, menus, its own activities, its
  // improvement); everything else (translation, media, libraries, other applets) is global.
  const SCENE_KINDS = new Set(['ai', 'fix', 'quick', 'more', 'suggest', 'prefetch', 'refine', 'revise', 'review', 'lab', 'tests', 'menus', 'scene']);
  const kindOf = (id) => String(id).split(/[:\-]/)[0];
  const here = all.filter((a) => (SCENE_KINDS.has(kindOf(a.id)) && a.entry === current) || (a.key && current.key && a.key === current.key));
  const elsewhere = all.filter((a) => !here.includes(a));
  const procList = (list) => list.length ? list.map((a) => `<div class="a-proc" data-id="${esc(a.id)}"><span class="a-ptitle">${esc(a.title)}${a.detail && a.detail !== a.title ? ' — ' + esc(a.detail) : ''}</span>` +
    `<span class="a-ptime">${fmtSecs((performance.now() - a.at) / 1000)}</span><span class="a-pacts">${activityActions(a.id, a).map((x, i) => `<button type="button" class="p-act" data-n="${i}" title="${esc(x.label)}" aria-label="${esc(x.label)}">${esc(x.icon)}</button>`).join('')}</span></div>`).join('')
    : `<div class="a-empty">${esc(t('nothingRunning'))}</div>`;
  const mb = (b) => b == null ? '—' : fmtBytes(b);
  const next = U.next ? `«${U.next.title}» · ${Math.max(0, Math.round((U.next.at - Date.now()) / 1000)) ? fmtSecs(Math.max(0, Math.round((U.next.at - Date.now()) / 1000))) : t('dueNow')}` : '—';
  const global = [
    [t('actEngine'), (S.ai && S.ai.active && S.ai.active.label) || L.engine || '—'],
    [t('actNet'), N.ssid ? `📶 ${N.ssid} · ${N.rssi} dBm` : (N.addresses || []).map((a) => a.ip).join(', ') || '—'],
    [t('actMemory'), mb(P.memory)], [t('actLoad'), (P.load || []).map((x) => x.toFixed(2)).join(' · ') || '—'],
    [t('actDisk'), mb(P.diskFree)], [t('actUptime'), P.uptime != null ? fmtSecs(P.uptime) : '—'],
    [t('actApplets'), U.applets ?? '—'], [t('actImproves'), U.improvements ?? '—'], [t('actNext'), next],
    [t('actIntegration'), L.integration != null ? Math.round(L.integration) + '%' : '—'],
    [t('actModules'), L.modules ?? '—'],
    [t('actCache'), S.cache ? `${S.cache.entries} · ${mb(S.cache.bytes)}` : '—'],
    [t('actLibsInstalled'), S.libraries ? `${S.libraries.installed} / ${S.libraries.catalog} · ${mb(S.libraries.usedBytes)}` : '—'],
    [t('actHints'), S.hints && S.hints.hints ? S.hints.hints.length : '—'], [t('actJournal'), S.hints ? S.hints.journal ?? '—' : '—'],
  ];
  const sc = L.scene, q = current.screen.quality || {};
  const sched = sc && sc.schedule ? scheduleText(sc) : null;
  const scores = q.screen && q.screen.scores ? Object.entries(q.screen.scores).map(([k, v]) => `${k} ${v}`).join(' · ') : '—';
  const hereNums = sc ? [
    [t('actNext'), sched ? `${sched.when || '—'} · ${sched.sub}` : '—'],
    [t('actImproves'), sc.improves ?? 0], [t('actOpens'), sc.opens ?? '—'], [t('actMinutes'), sc.minutes != null ? sc.minutes.toFixed(1) : '—'],
    [t('actInteractions'), sc.interactions ?? '—'], [t('actFindings'), sc.findings ?? '—'], [t('actScores'), scores],
  ] : null;
  const where = current.screen.title || current.label || '';
  el.actBody.innerHTML =
    `<section class="a-sec"><h3>${esc(t('actHere'))}${where ? ' · ' + esc(where) : ''}</h3>` +
      `<h4>${esc(t('actRunning'))}</h4>${procList(here)}` +
      (hereNums ? `<h4>${esc(t('actNumbers'))}</h4><div class="a-grid">${actRows(hereNums)}</div>` +
        (sc ? `<div class="a-acts"><button type="button" class="a-btn" data-sched="now">↻ ${esc(t('qaImproveNow'))}</button>` +
          `<button type="button" class="a-btn" data-sched="${sc.paused ? 'resume' : 'pause'}">${sc.paused ? '▶ ' + esc(t('qaResumeImprove')) : '⏸ ' + esc(t('qaPauseImprove'))}</button></div>` : '')
        : `<div class="a-empty">${esc(t('actSceneNone'))}</div>`) +
    `</section>` +
    `<section class="a-sec"><h3>${esc(t('actGlobal'))}${L.paused || paused ? ' · ' + esc(t('actPaused')) : ''}</h3>` +
      `<h4>${esc(t('actRunning'))}</h4>${procList(elsewhere)}` +
      `<h4>${esc(t('actNumbers'))}</h4><div class="a-grid">${actRows(global)}</div>` +
      (L.integrationRemaining ? `<p class="a-note">${esc(t('actIntegration'))} — ${esc(t('actRemaining'))}: ${esc(L.integrationRemaining)}</p>` : '') +
    `</section>`;
  for (const b of el.actBody.querySelectorAll('.a-proc .p-act')) {
    const id = b.closest('.a-proc').dataset.id, a = activities.get(id);
    b.onclick = async () => { const x = a && activityActions(id, a)[Number(b.dataset.n)]; if (x) { try { await x.run(); } catch {} } setTimeout(renderActivityScreen, 150); };
  }
  for (const b of el.actBody.querySelectorAll('[data-sched]')) {
    b.onclick = async () => {
      const key = sc.key, op = b.dataset.sched;
      try { await callRaw('usage', op === 'now' ? { op: 'improve', key } : { op: 'pause', key, on: op === 'pause' }); } catch {}
      loadLive();
    };
  }
}
el.infoBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleActivityScreen(); });
el.actClose.addEventListener('click', () => toggleActivityScreen(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.actscreen.hidden) { e.preventDefault(); e.stopPropagation(); toggleActivityScreen(false); } }, true);

function goToActivity(a) {
  // The entry it started from, wherever it is in the history now.
  if (a.entry && a.entry !== current) {
    const i = stack.indexOf(a.entry);
    if (i >= 0) { forwardStack = []; current = a.entry; stack = stack.slice(0, i); stopWriting(true); render(); return; }
  }
  if (a.entry === current) return;
  if (a.key) openApplet(a.key);
}
el.activity.addEventListener('click', (e) => { e.stopPropagation(); toggleProcs(); });
el.activity.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProcs(); } });
document.addEventListener('pointerdown', (e) => { if (!el.procs.hidden && !el.procs.contains(e.target) && e.target !== el.activity) el.procs.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.procs.hidden) { el.procs.hidden = true; el.activity.focus(); } }, true);
setInterval(() => { if (!el.procs.hidden) renderProcs(); }, 1000);
setInterval(() => { if (!el.procs.hidden) loadSchedule(); }, 10000);

function renderActivity() {
  if (el.procs && !el.procs.hidden) renderProcs();
  const list = [...activities.entries()].map(([id, a]) => ({ ...a, rank: actRank(id) }))
    .sort((a, b) => b.rank - a.rank || b.at - a.at);
  // The dot pulses only for work in progress: not for what simply plays (media, a scene's own
  // activity), nor for background work while it is paused. Those get a steady dot.
  const working = [...activities.keys()].some((id) => {
    const k = String(id).split(/[:\-]/)[0];
    return k !== 'media' && k !== 'scene' && !(paused && BACKGROUND_KINDS.has(k));
  });
  el.activity.classList.toggle('busy', working);
  el.activity.classList.toggle('steady', !working && list.length > 0);
  if (list.length) {
    const first = list[0];
    el.activity.textContent = first.title + (first.detail && first.detail !== first.title ? ' — ' + first.detail : '') +
      (list.length > 1 ? `  (+${list.length - 1})` : '');
    el.activity.title = list.map((a) => a.title).join('\n');
    return;
  }
  // Done: summarise the current state.
  const s = current.screen;
  const parts = [paused ? t('paused') : t('ready')];
  parts.push(s.kind === 'circles' ? `${(s.circles || []).filter((c) => !c.removed).length} ${t('circlesWord')}` : (s.title || s.kind));
  if (lastDone) parts.push(`${lastDone.title} · ${fmtSecs(lastDone.ms / 1000)}`);
  if (snapshot) parts.push(`${t('cacheWord')} ${snapshot.cache ?? 0} · JS ${snapshot.libs ?? 0}/${snapshot.catalog ?? 0} · ${t('hintsWord')} ${snapshot.hints}`);
  el.activity.textContent = parts.join(' · ');
  el.activity.title = '';
}
setInterval(() => { if (!activities.size) refreshSnapshot(); }, 60000);

// Pause: background work stops here and in the native app; the current screen keeps working.
let paused = localStorage.getItem('aiui.paused') === '1';
function setPaused(on) {
  paused = on;
  try { localStorage.setItem('aiui.paused', on ? '1' : '0'); } catch {}
  document.body.classList.toggle('paused', on);
  el.pauseBtn.textContent = on ? '▶' : '⏸';
  el.pauseBtn.title = on ? t('resume') : t('pause');
  callRaw('window', { op: 'pause', on }).catch(() => {});
  renderActivity();
}
el.pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); setPaused(!paused); });
el.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); showSystem(); });
for (const b of [el.pauseBtn, el.settingsBtn]) b.addEventListener('pointerdown', (e) => e.stopPropagation());

// Settings (Settings & System scene): stored here; some also native.
const SETTINGS_DEFAULT = { prefetch: true, refine: true, menus: true, qa: true, dod: true, quickAfter: 2, qaMin: 70 };
let settings = (() => { try { return { ...SETTINGS_DEFAULT, ...JSON.parse(localStorage.getItem('aiui.settings')) }; } catch { return { ...SETTINGS_DEFAULT }; } })();
function applySettings() {
  QUICK_AFTER_MS = Math.max(1, Number(settings.quickAfter) || 2) * 1000;
  QA_MIN = Math.max(0, Math.min(100, Number(settings.qaMin) || 70));
}
function setSetting(k, v) {
  settings[k] = v;
  try { localStorage.setItem('aiui.settings', JSON.stringify(settings)); } catch {}
  applySettings();
  flashStatus(`${k}: ${v}`);
}
// At launch: the native side learns the pause the page remembers (background work must not run).
if (paused) setTimeout(() => setPaused(true), 0);
setTimeout(refreshSnapshot, 1500);
async function settingsAction(name, arg) {
  const acts = {
    retro: () => call('hints', { op: 'retro' }), librarian: () => call('utilities', { op: 'review' }),
    clearCache: () => call('cache', { op: 'clear' }), clearAvoid: () => call('avoid', { op: 'clear' }),
    provider: () => showSetup(), zoom: () => zoom(Number(arg) || 0), budget: () => callRaw('window', { op: 'budget', gb: Number(arg) }),
    pause: () => setPaused(!!arg),
    nativeDownloads: () => callRaw('native', { op: 'setting', on: !!arg }),
  };
  if (acts[name]) { await acts[name](); flashStatus('✓ ' + name); }
}
applySettings();

// The address (path of screens): in the Mac title bar, clickable; aiui.goTo(level) jumps there.
function pathLabels(p) {
  return [...p.stack.slice(1).map((e) => e.label || (e.screen && e.screen.title) || ''), p.stack.length ? (p.current.label || p.current.screen.title || '') : null]
    .filter((x) => x != null);
}
function updateAddress() {
  const items = [t('appName'), ...pathLabels({ stack, current })].filter(Boolean);
  // The other paths, compact: their last place (the full path in the tooltip).
  const others = paths.map((p) => { const l = pathLabels(p); return { title: l[l.length - 1] || t('appName'), full: [t('appName'), ...l].join(' › ') }; });
  callRaw('window', { op: 'address', items, others }).then((r) => {
    document.documentElement.classList.toggle('native-address', !!(r && r.native));
  }).catch(() => {});
  renderWebPaths(others);
}
// The page's own path line (web version, or when the title bar has none): the other paths after it.
function renderWebPaths(others) {
  let box = document.getElementById('paths');
  if (!box) { box = document.createElement('div'); box.id = 'paths'; el.path.after(box); }
  box.textContent = '';
  others.forEach((o, i) => {
    const b = document.createElement('span'); b.className = 'path-tab';
    const go = document.createElement('button'); go.type = 'button'; go.textContent = o.title; go.title = o.full;
    go.addEventListener('click', (e) => { e.stopPropagation(); switchPath(i); });
    const x = document.createElement('button'); x.type = 'button'; x.className = 'path-x'; x.textContent = '×'; x.setAttribute('aria-label', '× ' + o.title);
    x.addEventListener('click', (e) => { e.stopPropagation(); closePath(i); });
    b.append(go, x); box.appendChild(b);
  });
}
function goTo(level) {
  if (busy) cancel();
  if (level <= 0) return home();
  while (stack.length > level) { forwardStack.push(current); current = stack.pop(); }
  stopWriting(true);
  render();
}

// ---------------------------------------------------------------- scene state, usage, live reload
// Scenes keep their state with aiui.state (per scene). The app records how each scene is used and
// takes a live screenshot; the native side improves scenes and shared components in the
// background on a doubling schedule, and an improved version reloads live with the state kept.

function stateKey() { return 'aiui.state.' + (current.key || (current.screen && current.screen.title) || 'scene'); }
function sceneState() { try { return JSON.parse(localStorage.getItem(stateKey())); } catch { return null; } }
function saveSceneState(obj) {
  try {
    const json = JSON.stringify(obj);
    if (json.length < 200000) localStorage.setItem(stateKey(), json);
  } catch {}
}

const usageAcc = new Map(); // entry → { since, interactions }
function usageNote(entry, r) {
  if (!entry || !entry.key || entry.screen.local) return;
  call('usage', { key: entry.key, title: entry.screen.title || entry.label || '', ...r }).catch(() => {});
}
function usageOpened(entry) {
  if (!entry || !entry.key || entry.screen.kind !== 'html' || entry.screen.local) return;
  usageAcc.set(entry, { since: Date.now() });
  usageNote(entry, { opened: true });
  // A live screenshot once the scene has settled.
  setTimeout(() => {
    if (current !== entry) return;
    const f = el.view.querySelector('iframe');
    if (f) f.contentWindow.postMessage({ aiuiShotRequest: true, local: 'aiui://app/vendor/html2canvas/html2canvas.min.js' }, '*');
  }, 4000);
}
function usageLeft(entry) {
  const a = usageAcc.get(entry);
  if (!a) return;
  usageAcc.delete(entry);
  usageNote(entry, { dwellMs: Date.now() - a.since });
}
let lastEntry = null;
function trackUsage() {
  if (lastEntry && lastEntry !== current) usageLeft(lastEntry);
  if (current !== lastEntry) usageOpened(current);
  lastEntry = current;
}

// QA findings go to the shared components the scene uses (for their quality increments).
function componentFeedback(s, r) {
  if (!s.uses || !s.uses.length || !r || !(r.issues || []).length) return;
  call('utilities', { op: 'feedback', ids: s.uses, findings: r.issues.slice(0, 8), scores: r.scores || {} }).catch(() => {});
}

// Seamless updates: a new version of the scene on display replaces it when the user is idle
// (2.5 s without input), loaded underneath while the old one stays visible and frozen on top;
// the new one loads the saved state and, once it reports ready, the old one fades out.
let lastInputAt = 0, seamlessQueue = null;
document.addEventListener('pointerdown', () => { lastInputAt = Date.now(); }, true);
document.addEventListener('keydown', () => { lastInputAt = Date.now(); }, true);
function seamlessUpdate(entry, next, note) {
  seamlessQueue = { entry, next, note };
  trySeamless();
}
async function trySeamless() {
  const q = seamlessQueue;
  if (!q) return;
  if (current !== q.entry) { q.entry.screen = q.next; seamlessQueue = null; return; } // not on display: next visit shows it
  if (typing() || Date.now() - lastInputAt < 2500 || busy) return void setTimeout(trySeamless, 1000);
  seamlessQueue = null;
  await handoffMedia();
  for (const f of el.view.querySelectorAll('iframe')) f.classList.add('outgoing');
  q.entry.screen = q.next;
  render();
  if (q.note) flashStatus(q.note);
  setTimeout(finishSeamless, 8000); // a version that never says ready still takes over
}
function finishSeamless() {
  for (const f of el.view.querySelectorAll('iframe.outgoing')) {
    f.classList.add('leaving');
    setTimeout(() => f.remove(), 400);
  }
}

// Improved versions arrive from the background: reload live, keeping the scene's state.
async function onImproved(e) {
  const entries = [current, ...stack].filter((x) => x.key === e.key);
  if (!entries.length) return;
  try {
    const { screen } = await callRaw('usage', { op: 'outcome', key: e.key });
    if (!screen) return;
    for (const entry of entries) if (entry !== current) entry.screen = normalize(screen);
    if (entries.includes(current)) seamlessUpdate(current, normalize(screen), '✨ ' + t('improvedLive'));
  } catch {}
}
function onComponentImproved(e) {
  const s = current.screen;
  if (s.kind === 'html' && (s.uses || []).some((u) => u === e.id)) {
    const fresh = { ...s };
    for (const k of ['reviewed', 'ready', 'labbed', 'testsRequested', 'health', 'failures', 'quality', 'barApplied']) delete fresh[k];
    seamlessUpdate(current, fresh, '🧩 ' + e.name + ' — ' + (e.changes || t('improvedLive')));
  }
}

// ---------------------------------------------------------------- console (`)
// A terminal-like console: every log line (activities, AI progress, QA, repairs, journal,
// errors) and a command line to a console AI with its own conversation, aware of the current
// context (screen, path, scene state, recent log). It can change the current scene live.

const logLines = [];
function log(kind, text) {
  const line = { at: new Date(), kind, text: String(text) };
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  if (!el.console.hidden) appendLog(line);
}
function appendLog(line) {
  const atBottom = el.consoleLog.scrollTop + el.consoleLog.clientHeight >= el.consoleLog.scrollHeight - 30;
  const div = document.createElement('span');
  div.className = 'l k-' + line.kind;
  div.innerHTML = `<span class="ts">${line.at.toTimeString().slice(0, 8)}</span> ${esc(line.text)}`;
  el.consoleLog.appendChild(div);
  while (el.consoleLog.childElementCount > 500) el.consoleLog.firstChild.remove();
  if (atBottom) el.consoleLog.scrollTop = el.consoleLog.scrollHeight;
}
function toggleConsole(on = el.console.hidden) {
  el.console.hidden = !on;
  if (on) {
    el.consoleLog.innerHTML = '';
    logLines.forEach(appendLog);
    el.consoleLog.scrollTop = el.consoleLog.scrollHeight;
    el.consoleInput.focus();
  } else el.consoleInput.blur();
}
el.consoleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleConsole(); });
el.consoleBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
el.console.addEventListener('pointerdown', (e) => e.stopPropagation());
el.consoleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); toggleConsole(false); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); el.consoleInput.value = cmdHistory[--cmdPos] ?? el.consoleInput.value; }
  else if (e.key === 'ArrowDown') { e.preventDefault(); el.consoleInput.value = cmdHistory[++cmdPos] ?? ''; }
  e.stopPropagation();
});
const cmdHistory = []; let cmdPos = 0;
el.consoleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = el.consoleInput.value.trim();
  if (!cmd) return;
  el.consoleInput.value = '';
  cmdHistory.push(cmd); cmdPos = cmdHistory.length;
  log('cmd', '› ' + cmd);
  const builtin = {
    '/help': () => log('reply', 'Commands: /help /clear /state /pause /resume /reload /retro /system — anything else goes to the AI with the current context.'),
    '/clear': () => { logLines.length = 0; el.consoleLog.innerHTML = ''; },
    '/state': () => log('reply', JSON.stringify(sceneState(), null, 2) || 'no state'),
    '/pause': () => { setPaused(true); log('reply', 'background work paused'); },
    '/resume': () => { setPaused(false); log('reply', 'background work resumed'); },
    '/reload': () => { reloadScene(); log('reply', 'scene reloaded (state kept)'); },
    '/retro': async () => { await call('hints', { op: 'retro' }); log('reply', 'retrospective started'); },
    '/system': () => { toggleConsole(false); showSystem(); },
  };
  if (builtin[cmd]) return builtin[cmd]();
  const s = current.screen;
  try {
    const r = await call('console', {
      command: cmd,
      screen: { ...summary(s), ...(s.kind === 'html' ? { html: String(s.html || '').slice(0, 16000), uses: s.uses, libs: s.libs } : {}) },
      path: [...stack.map((x) => x.label), current.label].filter(Boolean),
      state: sceneState(),
      quality: lastQuality && lastQuality.title === s.title ? { screen: lastQuality.screen && lastQuality.screen.scores, issues: (s.health || []).slice(-10) } : undefined,
      log: logLines.slice(-40).map((l) => `${l.kind}: ${l.text}`),
    });
    log('reply', r.reply || '(no reply)');
    if (r.screen && r.screen.kind) {
      const entry = current;
      const { note, cacheable, reuse, publish, ...next } = r.screen;
      if (current === entry) await handoffMedia();
      entry.screen = normalize(next);
      if (current === entry) { render(); log('done', 'scene changed live (state kept)'); }
    }
  } catch (err) { log('error', err.message); }
});

// Icons in the bottom bar (left). Any scene or screen adds and removes them: AI views with
// aiui.bar.add/remove, circle screens with `bar` / `barRemove`. An icon runs the scene's own
// function, or sends its prompt to the AI; global ones stay across screens and launches.
let globalBar = (() => { try { return JSON.parse(localStorage.getItem('aiui.bar')) || []; } catch { return []; } })();
function saveGlobalBar() { try { localStorage.setItem('aiui.bar', JSON.stringify(globalBar.filter((b) => !b.media))); } catch {} }
let pendingBarClick = null; // { key, id }: a global icon's action waiting for its applet to be ready
function barAdd(item, fromScene) {
  const it = { id: String(item.id), icon: String(item.icon || '•').slice(0, 4), title: String(item.title || ''), prompt: item.prompt, scene: fromScene && !item.prompt,
    // The applet that added it: a click elsewhere opens it.
    origin: current.key ? { key: current.key, label: current.label || current.screen.title || '' } : null };
  if (item.global && (it.prompt || it.origin)) { globalBar = [...globalBar.filter((b) => b.id !== it.id), it]; saveGlobalBar(); }
  else { const s = current.screen; s.bar = [...(s.bar || []).filter((b) => b.id !== it.id), it]; }
  renderSceneBar();
}
function barRemove(id) {
  const s = current.screen;
  s.bar = (s.bar || []).filter((b) => b.id !== id);
  const before = globalBar.length;
  globalBar = globalBar.filter((b) => b.id !== id);
  if (globalBar.length !== before) saveGlobalBar();
  renderSceneBar();
}
function renderSceneBar() {
  el.sceneBar.innerHTML = '';
  const s = current.screen;
  const items = [...globalBar, ...(s.bar || []).filter((b) => !globalBar.some((g) => g.id === b.id))].slice(0, 12);
  for (const b of items) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = b.icon; btn.title = b.title + ' (right-click to remove)'; btn.setAttribute('aria-label', b.title || b.id);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      log('activity', `${b.icon} ${b.title || b.id}`);
      if (b.media) return player.paused ? mediaResume() : mediaPause();
      // Elsewhere: the icon opens its applet (and runs its action there).
      if (b.origin && b.origin.key && current.key !== b.origin.key) {
        if (b.scene) pendingBarClick = { key: b.origin.key, id: b.id };
        return openApplet(b.origin.key, b.origin.label).then((ok) => {
          if (!ok) { pendingBarClick = null; if (b.prompt) ask({ event: 'bar', action: { id: b.id, title: b.title, prompt: b.prompt } }, { label: b.title || b.icon }); }
        });
      }
      if (b.prompt) return ask({ event: 'bar', action: { id: b.id, title: b.title, prompt: b.prompt } }, { label: b.title || b.icon });
      const f = el.view.querySelector('iframe');
      if (f) f.contentWindow.postMessage({ aiuiBarClick: b.id }, '*');
    });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); if (b.media) return mediaStop(); barRemove(b.id); flashStatus(`${b.icon} ✕`); });
    el.sceneBar.appendChild(btn);
  }
}

// ---------------------------------------------------------------- app level (synced) + background player
// State that belongs to the whole app (not one scene) lives in aiui.app — shared by every scene,
// synced across devices; scenes subscribe to keys. The background player is an app-level service
// built on it: it outlives scenes, shows ⏯ in the bottom bar and stops with the app.

const appSubs = new Map();     // key → Set of callbacks (this page)
const appFrameSubs = new Map(); // key → Set of frame windows
async function appGet(k) { try { return (await callRaw('app', { op: 'get', key: k })).value; } catch { return null; } }
async function appSet(k, v) { await callRaw('app', { op: 'set', key: k, value: v }).catch(() => {}); appNotify(k, v); }
function appSubscribe(k, fn) { (appSubs.get(k) || appSubs.set(k, new Set()).get(k)).add(fn); }
function appSubscribeFrame(k, win) { (appFrameSubs.get(k) || appFrameSubs.set(k, new Set()).get(k)).add(win); }
function appNotify(k, v) {
  for (const fn of appSubs.get(k) || []) { try { fn(v); } catch {} }
  for (const w of appFrameSubs.get(k) || []) { try { w.postMessage({ aiuiAppChanged: true, key: k, value: v }, '*'); } catch { appFrameSubs.get(k).delete(w); } }
}

const player = new Audio();
player.preload = 'none';
let nowPlaying = null; // { url, title }
function mediaInfo() { return nowPlaying ? { ...nowPlaying, playing: !player.paused, position: player.currentTime } : null; }
function mediaSync() {
  const info = mediaInfo();
  appSet('media', info ? { url: info.url, title: info.title, playing: info.playing } : null);
  const bar = globalBar.filter((b) => b.id !== '__media');
  if (nowPlaying) bar.unshift({ id: '__media', icon: player.paused ? '▶' : '⏸', title: (player.paused ? '' : '♫ ') + nowPlaying.title, media: true });
  globalBar = bar;
  renderSceneBar();
  if (nowPlaying && !player.paused) activityStart('media', '♫ ' + nowPlaying.title); else activityEnd('media');
}
async function mediaPlay(url, title) {
  if (!/^https?:|^aiui:|^blob:|^data:/.test(String(url))) throw new Error('media: a URL is required');
  nowPlaying = { url: String(url), title: String(title || 'Audio') };
  player.src = nowPlaying.url;
  try { await player.play(); } catch (e) { toast('♫ ' + e.message); }
  mediaSync();
  return mediaInfo();
}
function mediaPause() { player.pause(); mediaSync(); return mediaInfo(); }
async function mediaResume() { if (nowPlaying) { try { await player.play(); } catch {} } mediaSync(); return mediaInfo(); }
function mediaStop() { player.pause(); player.removeAttribute('src'); player.load(); nowPlaying = null; try { localStorage.removeItem('aiui.media'); } catch {} mediaSync(); return null; }
player.addEventListener('ended', () => { mediaSync(); });
player.addEventListener('error', () => { if (nowPlaying) { toast('♫ ' + t('mediaFailed') + ' ' + nowPlaying.title); mediaStop(); } });

// ---------------------------------------------------------------- reloads preserve everything
// Before a scene reloads, its playing audio moves to the app player (same position). The whole
// app's place (history of screens) and the player survive page reloads and relaunches.

let handoffWait = null;
// A scene left while it plays: the app player continues the same audio from the same moment.
let scenePlaying = null;
function continueSceneAudio() {
  const m = scenePlaying; scenePlaying = null;
  if (!m || !el.view.querySelector('iframe')) return;
  const time = m.time + (Date.now() - m.at) / 1000 * (m.rate || 1);
  log('media', `🎵 continues in the app player: ${m.title || m.url}`);
  mediaPlay(m.url, m.title || 'Audio').then(() => { try { if (time > 0) player.currentTime = time; } catch {} });
}
function handoffMedia() {
  scenePlaying = null;
  const f = el.view.querySelector('iframe');
  if (!f || current.screen.kind !== 'html') return Promise.resolve();
  return new Promise((resolve) => {
    handoffWait = async (m) => {
      if (m && m.url) {
        await mediaPlay(m.url, m.title || current.screen.title || 'Audio');
        try { if (isFinite(m.time) && m.time > 0 && isFinite(player.duration)) player.currentTime = m.time; } catch {}
      }
      resolve();
    };
    f.contentWindow.postMessage({ aiuiHandoff: true }, '*');
    setTimeout(() => { if (handoffWait) { handoffWait = null; resolve(); } }, 400);
  });
}
function tellSceneNowPlaying() {
  const f = el.view.querySelector('iframe');
  if (f) f.contentWindow.postMessage({ aiuiNowPlaying: nowPlaying && !player.paused ? nowPlaying.url : null }, '*');
}

// Where the user is (screens, keys) — saved on every render, restored at start.
function saveNav() {
  try {
    const pack = (e) => ({ screen: e.screen, label: e.label, key: e.key, evt: e.evt });
    const strip = (sc) => { const { quality, health, menus, menusPromise, prefetch, attention, labHead, ...rest } = sc || {}; return rest; };
    const nav = { stack: stack.map((e) => ({ ...pack(e), screen: strip(e.screen) })), current: { ...pack(current), screen: strip(current.screen) } };
    let json = JSON.stringify(nav);
    if (json.length > 3_000_000) { nav.stack = nav.stack.slice(-3); json = JSON.stringify(nav); }
    localStorage.setItem('aiui.nav', json);
  } catch {}
}
function restoreNav() {
  try {
    const nav = JSON.parse(localStorage.getItem('aiui.nav'));
    if (!nav || !nav.current || !nav.current.screen) return false;
    for (const e of [...nav.stack, nav.current]) for (const k of ['reviewed', 'ready', 'labbed', 'testsRequested', 'fixing', 'barApplied']) delete e.screen[k];
    stack = nav.stack; current = nav.current;
    return true;
  } catch { return false; }
}
// The player resumes where it was (position saved while playing).
setInterval(() => { if (nowPlaying && !player.paused) { try { localStorage.setItem('aiui.media', JSON.stringify({ ...nowPlaying, time: player.currentTime })); } catch {} } }, 2000);
async function restoreMedia() {
  let m = null; try { m = JSON.parse(localStorage.getItem('aiui.media')); } catch {}
  if (!m || !m.url) return;
  await mediaPlay(m.url, m.title);
  try { if (m.time > 0 && isFinite(player.duration)) player.currentTime = m.time; } catch {}
}

restoreNav();
render();
restoreMedia();
// No AI available yet: ask for one.
call('engine', { op: 'status' }).then((st) => { if (!st.active) showSetup(); else initLanguage(); }).catch(() => {});
