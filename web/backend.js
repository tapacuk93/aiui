// Browser backend for the web version (aiui.oeaio.com). The Mac app serves /api/* natively; on
// the web the same calls are answered here: the visitor's own API key (kept in localStorage),
// an agent loop with a `screen` tool, and the memory cache in localStorage. No system access.
'use strict';

const WebBackend = (() => {
  const KEY = 'aiui.key', CACHE = 'aiui.cache', LIMIT = 3 * 1024 * 1024; // cache size limit (bytes)
  let prompts = null;
  let libCatalog = null;
  const aborts = {};      // channel -> AbortController
  let convo = [];         // main conversation (append-only), provider wire format
  let openScreen = null;  // id of the last `screen` call awaiting its tool result
  let replayed = [];
  let flow = [];          // [{depth, line}]
  let prefetchedShown = []; // prefetched screens opened since the main AI last heard from us

  const err = (m) => new Error(m);
  const loadPrompts = async () => prompts || (prompts = await (await fetch('prompts.json')).json());
  // Prompt generation: cached screens from an older generation are not replayed (migration).
  let generation = '';
  async function gen() {
    if (generation) return generation;
    const p = await loadPrompts();
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.system + p.screenSchema + p.pageSchema));
    return (generation = [...new Uint8Array(h)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join(''));
  }

  // ------------------------------------------------------------- provider key

  function parseKey(text) {
    const parts = String(text).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    if (/^https?:/.test(parts[0]) && parts[1]) {
      return { provider: 'openai', name: new URL(parts[0]).host, base: parts[0].replace(/\/$/, ''), key: parts[1], model: parts[2] || '' };
    }
    const k = parts[0], m = parts[1] || '';
    const oa = (name, base, model) => ({ provider: 'openai', name, base, key: k, model: m || model });
    if (k.startsWith('sk-ant-')) return { provider: 'anthropic', name: 'Anthropic', base: 'https://api.anthropic.com', key: k, model: m || 'claude-opus-5-5' };
    if (k.startsWith('sk-or-')) return oa('OpenRouter', 'https://openrouter.ai/api/v1', 'openrouter/auto');
    if (k.startsWith('AIza')) return oa('Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-pro');
    if (k.startsWith('gsk_')) return oa('Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile');
    if (k.startsWith('xai-')) return oa('xAI', 'https://api.x.ai/v1', 'grok-4');
    if (k.startsWith('sk-')) return oa('OpenAI', 'https://api.openai.com/v1', 'gpt-5');
    return null;
  }
  const getKey = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };

  function status() {
    const k = getKey();
    const options = k ? [{ id: 'key', label: `${k.name} · ${k.model}`, kind: 'key' }] : [];
    return { options, active: k ? { id: 'key', label: `${k.name} · ${k.model}` } : null, web: true };
  }

  // ------------------------------------------------------------- memory cache

  const loadCache = () => { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch { return {}; } };
  function saveCache(c) {
    let json = JSON.stringify(c);
    // Least recently used entries go first until the cache fits its limit.
    const keys = Object.keys(c).sort((a, b) => c[a].lastUsed - c[b].lastUsed);
    while (json.length > LIMIT && keys.length) { delete c[keys.shift()]; json = JSON.stringify(c); }
    try { localStorage.setItem(CACHE, json); } catch { /* quota: drop silently */ }
  }

  function actionOf(input) {
    const a = { event: input.event || '?', language: input.language || navigator.language };
    if (input.path) a.path = input.path;
    if (input.target && input.target.label) a.target = input.target.label;
    if (input.text) a.text = input.text;
    if (input.data) a.data = input.data;
    const sc = input.screen || {};
    if (sc.title) a.on = sc.title;
    const circles = sc.circles || [];
    const sel = circles.filter((c) => c.selected).map((c) => c.label).sort();
    if (sel.length) a.selected = sel;
    const vals = circles.filter((c) => c.value != null).map((c) => `${c.label}=${c.value}`).sort();
    if (vals.length) a.values = vals;
    if (sc.removed && sc.removed.length) a.removed = [...sc.removed].sort();
    return a;
  }
  const stable = (o) => JSON.stringify(o, Object.keys(o).sort());
  async function keyOf(action) {
    const norm = { ...action };
    if (norm.text) norm.text = norm.text.toLowerCase().trim();
    const bytes = new TextEncoder().encode(stable(norm));
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function lineOf(a) {
    const parts = [a.event];
    if (a.path && a.path.length) parts.push(a.path.join(' › '));
    if (a.target) parts.push('→ ' + a.target);
    if (a.selected) parts.push('selected: ' + a.selected.join(', '));
    if (a.text) parts.push('“' + String(a.text).slice(0, 80) + '”');
    return parts.join(' ');
  }
  const flowLine = (e) => [...(e.flow || []), lineOf(e.action)].join(' ⟶ ');

  function related(words, limit = 8) {
    const ws = [...new Set(words.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))];
    if (!ws.length) return [];
    return Object.values(loadCache()).map((e) => {
      const hay = (e.description + ' ' + flowLine(e)).toLowerCase();
      return [e, ws.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)];
    }).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || b[0].lastUsed - a[0].lastUsed)
      .slice(0, limit).map(([e]) => ({ key: e.key, flow: flowLine(e), outcome: e.description, hits: e.hits }));
  }
  function overview(limit = 16) {
    const all = Object.values(loadCache());
    const recent = [...all].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, Math.floor(limit * 2 / 3));
    const freq = [...all].sort((a, b) => b.hits - a.hits).slice(0, limit);
    const seen = new Set(), rows = [];
    for (const e of [...recent, ...freq]) if (rows.length < limit && !seen.has(e.key)) { seen.add(e.key); rows.push(e); }
    return rows.map((e) => `${flowLine(e)} | ${e.description} | ×${e.hits} [${e.key}]`);
  }
  function likely(path) {
    const rows = Object.values(loadCache()).filter((e) => e.action.event === 'open' &&
      JSON.stringify(e.action.path || []) === JSON.stringify(path || []));
    rows.sort((a, b) => b.hits - a.hits || b.lastUsed - a.lastUsed);
    return rows[0] ? rows[0].action.target : null;
  }
  function store(key, action, steps, screen) {
    const c = loadCache();
    const { note, cacheable, ...outcome } = screen;
    const prev = c[key];
    c[key] = { key, action, flow: steps, outcome, gen: generation, description: note || `${outcome.kind} ${outcome.title || ''}`.trim(),
      cacheable: !!cacheable, hits: (prev ? prev.hits : 0) + 1, created: prev ? prev.created : Date.now(), lastUsed: Date.now() };
    saveCache(c);
    return outcome;
  }
  function touch(key) {
    const c = loadCache();
    if (!c[key]) return null;
    c[key].hits += 1; c[key].lastUsed = Date.now();
    saveCache(c);
    return c[key];
  }

  // ------------------------------------------------------------- utility library
  // Reusable code modules screens publish and reuse (`publish` / `uses`), reviewed now and then.

  const LIB = 'aiui.library', LIB_LIMIT = 1.5 * 1024 * 1024;
  const loadLib = () => { try { return JSON.parse(localStorage.getItem(LIB)) || { modules: {}, aliases: {}, since: 0 }; } catch { return { modules: {}, aliases: {}, since: 0 }; } };
  function saveLib(l) {
    let json = JSON.stringify(l);
    const ids = Object.keys(l.modules).sort((a, b) => l.modules[a].lastUsed - l.modules[b].lastUsed);
    while (json.length > LIB_LIMIT && ids.length) { delete l.modules[ids.shift()]; json = JSON.stringify(l); }
    try { localStorage.setItem(LIB, json); } catch {}
  }
  async function modId(path, name) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([...path, name].join('/').toLowerCase()));
    return 'm' + [...new Uint8Array(h)].slice(0, 5).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function publish(screen) {
    const l = loadLib(), ids = [];
    for (const m of screen.publish || []) {
      if (!m || !m.name || !m.code) continue;
      const path = (m.path || []).filter(Boolean).slice(0, 3);
      const id = await modId(path, m.name), prev = l.modules[id];
      l.modules[id] = { id, path: path.length ? path : ['misc'], name: m.name, kind: m.kind === 'css' ? 'css' : 'js',
        description: m.description || (prev && prev.description) || '', usage: m.usage || (prev && prev.usage) || '',
        code: m.code, version: (prev ? prev.version : 0) + 1, uses: prev ? prev.uses : 0, lastUsed: Date.now() };
      ids.push(id);
    }
    if (ids.length) { l.since = (l.since || 0) + ids.length; saveLib(l); }
    return ids;
  }
  function resolveMod(l, ref) {
    let id = ref, hops = 0;
    while (!l.modules[id] && l.aliases[id] && hops++ < 8) id = l.aliases[id];
    if (!l.modules[id] && ref.includes('/')) {
      const m = Object.values(l.modules).find((x) => [...x.path, x.name].join('/').toLowerCase() === ref.toLowerCase());
      if (m) id = m.id;
    }
    return l.modules[id] ? id : null;
  }
  function libBundle(refs) {
    const l = loadLib(), js = [], css = [], seen = new Set();
    for (const ref of refs || []) {
      const id = resolveMod(l, ref);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const m = l.modules[id]; m.uses++; m.lastUsed = Date.now();
      const head = `/* ${[...m.path, m.name].join('/')} v${m.version} */\n`;
      (m.kind === 'css' ? css : js).push(head + m.code);
    }
    saveLib(l);
    return { js: js.join('\n;\n'), css: css.join('\n'), ids: [...seen] };
  }
  function libOverview(words, limit = 40) {
    const ws = words.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return Object.values(loadLib().modules).map((m) => {
      const hay = (m.path.join(' ') + ' ' + m.name + ' ' + m.description).toLowerCase();
      return [m, ws.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)];
    }).sort((a, b) => b[1] - a[1] || b[0].uses - a[0].uses).slice(0, limit)
      .map(([m]) => `${[...m.path, m.name].join(' › ')} (${m.kind}) — ${m.description}${m.usage ? ' · usage: ' + m.usage : ''} [${m.id}]`);
  }
  const libCategories = () => [...new Set(Object.values(loadLib().modules)
    .flatMap((m) => m.path.map((_, n) => m.path.slice(0, n + 1).join(' › '))))].sort();
  function libTree(path) {
    const all = Object.values(loadLib().modules);
    const under = all.filter((m) => JSON.stringify(m.path.slice(0, path.length)) === JSON.stringify(path));
    const cats = {}, here = [];
    for (const m of under) {
      if (m.path.length > path.length) {
        const c = m.path[path.length];
        cats[c] = cats[c] || { name: c, count: 0, uses: 0 };
        cats[c].count++; cats[c].uses += m.uses;
      } else here.push(m);
    }
    return {
      categories: Object.values(cats).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
      utilities: here.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
        .map((m) => ({ id: m.id, name: m.name, icon: m.kind === 'css' ? '🎨' : '🧩', description: m.description, uses: m.uses })),
      total: all.length,
    };
  }
  let reviewing = false;
  async function reviewLibrary(force) {
    const l = loadLib(), n = Object.keys(l.modules).length;
    if (reviewing || n < 2 || (!force && (l.since || 0) < 6 && Date.now() - (l.lastReview || 0) < 86400000)) return;
    const k = getKey();
    if (!k) return;
    reviewing = true;
    try {
      const p = await loadPrompts();
      const modules = Object.values(l.modules).sort((a, b) => b.uses - a.uses).slice(0, 60)
        .map((m) => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, description: m.description, usage: m.usage, uses: m.uses, code: m.code.slice(0, 12000) }));
      const { screen: r } = await turn(k, instructions(p.system + p.librarian), JSON.parse(p.librarySchema), [],
        'Review the utility library:\n' + json({ modules, categories: libCategories() }), null, 'librarian', () => {});
      const lib = loadLib();
      for (const u of r.updates || []) {
        const m = lib.modules[u.id]; if (!m) continue;
        if (u.code) { m.code = u.code; m.version++; }
        for (const f of ['description', 'usage']) if (u[f] != null) m[f] = u[f];
        if ((u.path && u.path.length) || u.name) {
          m.path = u.path && u.path.length ? u.path : m.path; m.name = u.name || m.name;
          const nid = await modId(m.path, m.name);
          if (nid !== m.id) { delete lib.modules[m.id]; lib.aliases[m.id] = nid; m.id = nid; lib.modules[nid] = m; }
        }
      }
      for (const g of r.merge || []) {
        if (!g.from || !g.into || !g.into.code) continue;
        const path = (g.into.path || []).filter(Boolean), nid = await modId(path, g.into.name);
        const olds = g.from.map((id) => lib.modules[id]).filter(Boolean);
        lib.modules[nid] = { id: nid, path, name: g.into.name, kind: g.into.kind === 'css' ? 'css' : 'js', description: g.into.description || '',
          usage: g.into.usage || '', code: g.into.code, version: Math.max(0, ...olds.map((o) => o.version)) + 1,
          uses: olds.reduce((n, o) => n + o.uses, 0), lastUsed: Date.now() };
        for (const id of g.from) if (id !== nid) { delete lib.modules[id]; lib.aliases[id] = nid; }
      }
      for (const id of r.remove || []) delete lib.modules[id];
      lib.lastReview = Date.now(); lib.since = 0;
      saveLib(lib);
    } catch {} finally { reviewing = false; }
  }

  // ------------------------------------------------------------- avoid record
  // Hosts/URLs that failed, rechecked in the background with exponential backoff.

  const AVOID = 'aiui.avoid', FIRST = 600000, MAXB = 7 * 86400000;
  const loadAvoid = () => { try { return JSON.parse(localStorage.getItem(AVOID)) || {}; } catch { return {}; } };
  const saveAvoid = (a) => { try { localStorage.setItem(AVOID, JSON.stringify(a)); } catch {} };
  function avoidRecord(items) {
    const a = loadAvoid(), now = Date.now();
    for (const it of items || []) {
      let host; try { host = new URL(it.url).host; } catch { continue; }
      for (const [key, kind] of [[host, 'host'], [it.url, 'url']]) {
        const e = a[key] || { key, kind, first: now, failures: 0, backoff: FIRST, nextCheck: now + FIRST, checks: 0 };
        Object.assign(e, { sample: it.url, reason: it.reason || 'failed', last: now, failures: e.failures + 1 });
        a[key] = e;
      }
    }
    saveAvoid(a);
  }
  const avoidActive = (e) => e.kind === 'url' || e.failures >= 2 || ['401', '403', '451', 'dns'].includes(e.reason);
  function avoidOverview(limit = 30) {
    return Object.values(loadAvoid()).filter(avoidActive)
      .sort((x, y) => (x.kind === y.kind ? y.failures - x.failures : x.kind === 'host' ? -1 : 1)).slice(0, limit)
      .map((e) => `${e.key} — ${e.reason} ×${e.failures} since ${new Date(e.first).toISOString().slice(0, 10)}`);
  }
  // A browser can't read another site's status: an image probe for images, a no-cors fetch for
  // the rest (it at least proves the host answers).
  function probe(url) {
    return new Promise((res) => {
      const t = setTimeout(() => res(false), 15000);
      if (/\.(jpe?g|png|gif|webp|svg)(\?|$)|\/iiif\//i.test(url)) {
        const i = new Image(); i.onload = () => { clearTimeout(t); res(true); }; i.onerror = () => { clearTimeout(t); res(false); }; i.src = url;
      } else {
        fetch(url, { mode: 'no-cors' }).then(() => { clearTimeout(t); res(true); }, () => { clearTimeout(t); res(false); });
      }
    });
  }
  async function avoidRecheck() {
    const now = Date.now();
    for (const e of Object.values(loadAvoid()).filter((x) => x.nextCheck <= now)) {
      const ok = await probe(e.sample);
      const a = loadAvoid(), cur = a[e.key];
      if (!cur) continue;
      cur.checks++;
      if (ok) {
        delete a[e.key];
        if (cur.kind === 'host') for (const [k, v] of Object.entries(a)) { try { if (v.kind === 'url' && new URL(k).host === cur.key) delete a[k]; } catch {} }
      } else {
        cur.backoff = Math.min(cur.backoff * 2, MAXB);
        cur.nextCheck = Date.now() + cur.backoff;
      }
      saveAvoid(a);
    }
  }
  setInterval(avoidRecheck, 60000);

  // ------------------------------------------------------------- journal + hints (retrospectives)

  const HINTS = 'aiui.hints';
  const loadHints = () => { try { return JSON.parse(localStorage.getItem(HINTS)) || { journal: [], hints: {}, lastRetro: 0, summary: '' }; } catch { return { journal: [], hints: {}, lastRetro: 0, summary: '' }; } };
  const saveHints = (h) => { try { localStorage.setItem(HINTS, JSON.stringify(h)); } catch {} };
  function hintsRelevant(limit = 12) {
    return Object.values(loadHints().hints).sort((a, b) => b.confidence * (b.evidence + 1) - a.confidence * (a.evidence + 1))
      .slice(0, limit).map((h) => `${h.text} (${h.scope}, ×${h.evidence})`);
  }
  let retroRunning = false;
  async function retrospect(force) {
    const h = loadHints(), since = h.journal.filter((j) => j.at > h.lastRetro);
    if (retroRunning || (!force && !(since.length >= 15 || (since.length >= 3 && Date.now() - h.lastRetro > 6 * 3600000)))) return;
    const k = getKey(); if (!k) return;
    retroRunning = true;
    try {
      const p = await loadPrompts();
      const input = { incidents: since.slice(-120), hints: Object.values(h.hints) };
      const { screen: r } = await turn(k, instructions(p.system + p.retro), JSON.parse(p.retroSchema), [],
        'Retrospective on what went wrong:\n' + json(input), null, 'retro', () => {});
      const cur = loadHints();
      for (const x of r.hints || []) {
        if (!x.text) continue;
        const id = (x.id && cur.hints[x.id]) ? x.id : 'h' + x.text.toLowerCase().replace(/\W+/g, '').slice(0, 24);
        const prev = cur.hints[id];
        cur.hints[id] = { id, text: x.text, scope: x.scope || 'all', why: x.why || '', confidence: Math.max(x.confidence || 0.6, prev ? prev.confidence : 0),
          evidence: (prev ? prev.evidence : 0) + 1, updated: Date.now() };
      }
      for (const id of r.retire || []) delete cur.hints[id];
      cur.lastRetro = Date.now(); cur.summary = r.summary || '';
      saveHints(cur);
    } catch {} finally { retroRunning = false; }
  }

  // ------------------------------------------------------------- user profile
  // Characteristic tree (from the profiler AI) + behavioral baseline, in localStorage.

  const PROFILE = 'aiui.profile';
  const loadProfile = () => { try { return JSON.parse(localStorage.getItem(PROFILE)) || { traits: {}, baseline: {} }; } catch { return { traits: {}, baseline: {} }; } };
  const saveProfile = (p) => { try { localStorage.setItem(PROFILE, JSON.stringify(p)); } catch {} };
  const pkey = (path) => path.map((x) => x.toLowerCase()).join(' › ');
  function profileOverview(limit = 24) {
    return Object.values(loadProfile().traits)
      .sort((a, b) => b.confidence * Math.log(b.evidence + 1.7) - a.confidence * Math.log(a.evidence + 1.7))
      .slice(0, limit).map((t) => `${t.path.join(' › ')}: ${t.value} (${t.confidence.toFixed(1)})`);
  }
  function profileMerge(r) {
    const p = loadProfile();
    for (const u of r.updates || []) {
      if (!u.path || !u.path.length || !u.value) continue;
      const k = pkey(u.path), conf = Math.min(1, Math.max(0, u.confidence ?? 0.5)), prev = p.traits[k];
      p.traits[k] = { path: u.path, value: u.value, confidence: prev ? prev.confidence * 0.6 + conf * 0.4 : conf,
        evidence: (prev ? prev.evidence : 0) + 1, updated: Date.now() };
    }
    for (const r2 of r.remove || []) delete p.traits[pkey(r2)];
    const all = Object.entries(p.traits);
    if (all.length > 300) all.sort((a, b) => a[1].confidence * a[1].evidence - b[1].confidence * b[1].evidence)
      .slice(0, all.length - 300).forEach(([k]) => delete p.traits[k]);
    saveProfile(p);
  }
  function profileTree(path) {
    const under = Object.values(loadProfile().traits)
      .filter((t) => t.path.length > path.length && pkey(t.path.slice(0, path.length)) === pkey(path));
    const branches = {}, here = [];
    for (const t of under) {
      if (t.path.length > path.length + 1) branches[t.path[path.length]] = (branches[t.path[path.length]] || 0) + 1;
      else here.push(t);
    }
    return {
      branches: Object.entries(branches).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
      traits: here.sort((a, b) => b.confidence - a.confidence).map((t) => ({ name: t.path[t.path.length - 1], value: t.value, confidence: t.confidence, path: t.path })),
      total: Object.keys(loadProfile().traits).length,
    };
  }

  // ------------------------------------------------------------- model calls

  const screenToolDesc = 'Show the next screen to the user. Ends your turn.';

  async function post(url, body, headers, channel) {
    const ctl = new AbortController();
    if (aborts[channel]) aborts[channel].abort();
    aborts[channel] = ctl;
    let res;
    try {
      res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...headers } });
    } catch (e) {
      if (e.name === 'AbortError') throw err('cancelled');
      throw err('Network error: ' + e.message);
    }
    const obj = await res.json().catch(() => ({}));
    if (!res.ok) throw err(`${getKey().name} error ${res.status}: ${(obj.error && obj.error.message) || res.statusText}`);
    return obj;
  }

  const tryJSON = (t) => {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
  };

  // One agent turn. `messages` is the provider-format history (mutated, append-only).
  // Returns {screen, callId}. The only client tool is `screen`; Anthropic also gets web search.
  async function turn(k, system, schema, messages, prompt, pending, channel, progress) {
    if (k.provider === 'anthropic') {
      const first = [];
      if (pending) first.push({ type: 'tool_result', tool_use_id: pending, content: 'Screen shown.' });
      first.push({ type: 'text', text: prompt });
      messages.push({ role: 'user', content: first });
      const tools = [
        { name: 'screen', description: screenToolDesc, input_schema: schema },
        { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
      ];
      const fallbacks = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1'].includes(k.model);
      for (let i = 0; i < 12; i++) {
        const body = { model: k.model, max_tokens: 16000, system, tools, tool_choice: { type: 'auto' }, messages,
          output_config: { effort: 'medium' } };
        const headers = { 'x-api-key': k.key, 'anthropic-version': '2026-10-21',
          'anthropic-dangerous-direct-browser-access': 'true' };
        if (fallbacks) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
        const res = await post(k.base + '/v1/messages', body, headers, channel);
        const content = res.content || [];
        messages.push({ role: 'assistant', content }); // unchanged, thinking blocks included
        if (res.stop_reason === 'refusal') throw err('The model declined this request.');
        if (res.stop_reason === 'max_tokens') throw err('The model ran out of output tokens.');
        if (content.some((b) => b.type === 'server_tool_use')) progress('searching the web');
        const s = content.find((b) => b.type === 'tool_use' && b.name === 'screen');
        if (s) return { screen: s.input || {}, callId: s.id };
        if (res.stop_reason === 'pause_turn') continue; // server tool still working: resend as is
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Call the screen tool now with the next screen.' }] });
      }
      throw err('The model did not produce a screen.');
    }
    // OpenAI-compatible chat completions
    if (pending) messages.push({ role: 'tool', tool_call_id: pending, content: 'Screen shown.' });
    messages.push({ role: 'user', content: prompt });
    const tools = [{ type: 'function', function: { name: 'screen', description: screenToolDesc, parameters: schema } }];
    for (let i = 0; i < 6; i++) {
      const res = await post(k.base + '/chat/completions',
        { model: k.model, tools, tool_choice: 'auto', messages: [{ role: 'system', content: system }, ...messages] },
        { Authorization: 'Bearer ' + k.key }, channel);
      const msg = res.choices && res.choices[0] && res.choices[0].message;
      if (!msg) throw err('Unexpected response from ' + k.name);
      const calls = msg.tool_calls || [];
      messages.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      const s = calls.find((c) => c.function && c.function.name === 'screen');
      if (s) {
        for (const c of calls) if (c !== s) messages.push({ role: 'tool', tool_call_id: c.id, content: 'skipped' });
        let args = {};
        try { args = JSON.parse(s.function.arguments || '{}'); } catch {}
        return { screen: args, callId: s.id };
      }
      const parsed = typeof msg.content === 'string' && tryJSON(msg.content);
      if (parsed) return { screen: parsed, callId: null };
      messages.push({ role: 'user', content: 'Call the screen tool now with the next screen.' });
    }
    throw err('The model did not produce a screen.');
  }

  const instructions = (base) => base + '\n\nEnd every turn by calling the `screen` tool exactly once; never answer in plain text.';
  const json = (o) => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

  // ------------------------------------------------------------- endpoints

  async function ai(input, progress) {
    const k = getKey();
    if (!k) throw err('no-ai');
    const p = await loadPrompts();
    for (const ch of ['pager', 'suggest', 'scout', 'refine']) if (aborts[ch]) aborts[ch].abort();
    const action = actionOf(input);
    const key = await keyOf(action);
    const depth = (action.path || []).length;
    const before = flow.filter((f) => f.depth < depth);
    flow = [...before, { depth, line: lineOf(action) }];
    const steps = before.slice(-10).map((f) => f.line);

    const g = await gen();
    const hit = !input.fresh && loadCache()[key];
    if (hit && hit.cacheable && hit.gen === g) {
      touch(key);
      replayed = [...replayed, action].slice(-20);
      return { screen: hit.outcome, cached: true, key };
    }
    const event = { ...input, language: input.language || navigator.language };
    if (replayed.length) event.replayed = replayed;
    if (prefetchedShown.length) event.prefetched = prefetchedShown;
    if (steps.length) event.flow = steps;
    const words = [...(input.path || []), input.target && input.target.label, input.text].filter(Boolean);
    const mem = related(words);
    if (mem.length) event.memory = mem;
    const ov = overview();
    if (ov.length) event.flows = ov;
    const av = avoidOverview();
    if (av.length) event.avoid = av;
    const hs = hintsRelevant();
    if (hs.length) event.hints = hs;
    if (!libCatalog) { try { libCatalog = (await (await fetch('libraries.json')).json()).libraries; } catch { libCatalog = []; } }
    const ws = words.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    const rel = libCatalog.map((e) => [e, ws.reduce((n, w) => n + ((e.id + ' ' + e.description).toLowerCase().includes(w) ? 100 : 0), 0) + e.priority])
      .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([e]) => `${e.id} ${e.version} (${e.global || 'CSS'}) — ${e.description}`);
    event.libraries = { installable: rel, totals: { catalog: libCatalog.length }, note: 'web: libraries load from jsDelivr; any npm package name works in libs' };
    const lo = libOverview(words);
    if (lo.length) { event.library = lo; event.libraryCategories = libCategories(); }
    const user = {};
    if (input.guest) user.guest = true;
    else { const pr = profileOverview(); if (pr.length) user.profile = pr; }
    if (input.userCheck) user.check = input.userCheck;
    delete event.guest; delete event.userCheck;
    if (Object.keys(user).length) event.user = user;

    const prompt = 'UI event from aiui:\n' + json(event) + '\nDo what it needs, then return the next screen.';
    const messages = [...convo];
    const { screen, callId } = await turn(k, instructions(p.system), JSON.parse(p.screenSchema), messages, prompt,
      openScreen, 'ai', progress);
    convo = messages; openScreen = callId; replayed = []; prefetchedShown = [];
    let out = screen;
    if (out.reuse) {
      const old = loadCache()[out.reuse];
      const e = old && (old.gen === generation || old.outcome.kind !== 'html') ? touch(out.reuse) : null;
      if (e) {
        const over = {};
        for (const f of ['title', 'message', 'go', 'more', 'back', 'note', 'cacheable']) if (out[f] != null) over[f] = out[f];
        out = { ...e.outcome, ...over };
      }
      delete out.reuse;
    }
    const published = await publish(out);
    const { publish: _p, ...kept } = out;
    if (published.length) kept.uses = [...new Set([...(kept.uses || []), ...published])];
    const shown = store(key, action, steps, kept);
    reviewLibrary(false);
    return { screen: shown, key, ...(published.length ? { published: published.length } : {}) };
  }

  async function side(channel, systemExtra, schemaName, input, intro) {
    const k = getKey();
    if (!k) throw err('no-ai');
    const p = await loadPrompts();
    input = { ...input, language: input.language || navigator.language };
    const words = [...(input.path || []), input.input, input.screen && input.screen.title].filter(Boolean);
    const mem = related(words);
    const ev = { ...input };
    if (mem.length) ev.memory = mem;
    const ov = overview(10);
    if (ov.length) ev.flows = ov;
    const { screen } = await turn(k, instructions(p.system + p[systemExtra]), JSON.parse(p[schemaName]), [],
      intro + '\n' + json(ev), null, channel, () => {});
    return screen;
  }

  async function sys(op) {
    switch (op.op) {
      case 'open':
        if (!/^(https?:|mailto:|tel:)/i.test(op.target || '')) throw err('Only web links can be opened here.');
        window.open(op.target, '_blank', 'noopener');
        return { ok: true };
      case 'clipboard':
        if (op.text != null) { await navigator.clipboard.writeText(op.text); return { ok: true }; }
        return { text: await navigator.clipboard.readText() };
      case 'notify':
        if (Notification.permission !== 'granted') await Notification.requestPermission();
        if (Notification.permission === 'granted') new Notification(op.title || 'AI UI', { body: op.text || '' });
        return { ok: true };
      default:
        throw err('Not available in the web version: system access needs the AI UI Mac app.');
    }
  }

  async function call(name, body, progress) {
    switch (name) {
      case 'info': return { engine: 'web', ai: (getKey() || {}).name || 'none' };
      case 'engine': {
        if (body.op === 'key') {
          const k = parseKey(body.text);
          if (!k) throw err('Unrecognised key. Paste a key from Anthropic, OpenAI, Google, OpenRouter, Groq or xAI, or: <base-url> <key> [model]');
          localStorage.setItem(KEY, JSON.stringify(k));
          convo = []; openScreen = null;
        } else if (body.op === 'forget') {
          localStorage.removeItem(KEY);
          convo = []; openScreen = null;
        }
        return status();
      }
      case 'ai': return ai(body, progress);
      case 'more': return side('pager', 'pager', 'pageSchema', body, 'The user scrolled past the end of this screen. Continue its circles:');
      case 'suggest': return side('suggest', 'suggest', 'suggestSchema', body, 'The user is typing on this screen. Suggest circles for their input:');
      case 'tests': return side('tester', 'tester', 'testsSchema', body, 'What should be tested for this scene? Write its tests:');
      case 'menus': return side('menus', 'menus', 'menusSchema', body, 'Design the context menus for the classes of objects on this scene:');
      case 'usage': {
        // The web version records usage (no background self-improvement or screenshots kept).
        const U = 'aiui.usage';
        let u = {}; try { u = JSON.parse(localStorage.getItem(U)) || {}; } catch {}
        if (body.op === 'outcome') { const e = loadCache()[body.key]; return { screen: e ? e.outcome : null }; }
        if (body.op === 'list') return { scenes: Object.values(u).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 40) };
        if (body.key) {
          const x = u[body.key] || { key: body.key, title: '', opens: 0, minutes: 0, interactions: 0, improves: 0, lastUsed: 0 };
          if (body.title) x.title = body.title;
          if (body.opened) x.opens++;
          if (body.dwellMs) x.minutes += Math.round(body.dwellMs / 60000);
          if (body.interactions) x.interactions += body.interactions;
          x.lastUsed = Date.now(); u[body.key] = x;
          try { localStorage.setItem(U, JSON.stringify(u)); } catch {}
        }
        return { ok: true };
      }
      case 'journal': {
        const h = loadHints();
        h.journal = [...h.journal, { at: Date.now(), kind: body.kind, scene: body.scene, detail: body.detail }].slice(-300);
        saveHints(h); retrospect(false);
        return { ok: true };
      }
      case 'hints': {
        if (body.op === 'retro') retrospect(true);
        const h = loadHints();
        return { journal: h.journal.length, sinceRetro: h.journal.filter((j) => j.at > h.lastRetro).length,
          lastRetro: h.lastRetro ? new Date(h.lastRetro).toISOString() : '', summary: h.summary,
          hints: Object.values(h.hints), recent: h.journal.slice(-10).reverse() };
      }
      case 'quick': return side('quick', 'quick', 'screenSchema', body, 'The full answer to this event is taking long. Give a quick interim screen now:');
      case 'prefetch': return side('scout', 'scout', 'screenSchema', body, 'The cursor is heading for this circle. Prepare the screen opening it would show:');
      case 'refine': return side('refine', 'refine', 'patchSchema', body, 'Refine the circles of this screen with real data:');
      case 'translate': {
        const k = getKey();
        if (!k) throw err('no-ai');
        const p = await loadPrompts();
        const { screen } = await turn(k, instructions(p.translate), JSON.parse(p.translateSchema), [],
          JSON.stringify(body), null, 'translate', () => {});
        return screen;
      }
      case 'adopt': {
        const action = actionOf(body);
        const key = await keyOf(action);
        const depth = (action.path || []).length;
        const before = flow.filter((f) => f.depth < depth);
        flow = [...before, { depth, line: lineOf(action) }];
        if (body.outcome) {
          store(key, action, before.slice(-10).map((f) => f.line), body.outcome);
          prefetchedShown = [...prefetchedShown, { ...action, shown: body.outcome.note || body.outcome.title || '' }].slice(-10);
        }
        return { ok: true };
      }
      case 'cancel': {
        const ch = body.pager ? 'pager' : body.suggest ? 'suggest' : body.scout ? 'scout' : body.refine ? 'refine' : body.quick ? 'quick' : 'ai';
        if (aborts[ch]) aborts[ch].abort();
        return { ok: true };
      }
      case 'reset': convo = []; openScreen = null; return { ok: true };
      case 'sys': return sys(body);
      case 'profile': {
        const p = loadProfile();
        if (body.op === 'baseline') { p.baseline = body.baseline || {}; saveProfile(p); return { ok: true }; }
        if (body.op === 'tree') return profileTree(body.path || []);
        if (body.op === 'remove') { delete p.traits[pkey(body.path || [])]; saveProfile(p); return profileTree((body.path || []).slice(0, -1)); }
        if (body.op === 'learn') {
          const k = getKey();
          if (!k) throw err('no-ai');
          const pr = await loadPrompts();
          const evidence = { tree: profileOverview(80), flows: overview(40), utilities: utilOverview([], 20),
            language: navigator.language, behavior: body.behavior || {} };
          const { screen } = await turn(k, instructions(pr.system + pr.profiler), JSON.parse(pr.profileSchema), [],
            'Update the user\'s characteristic tree from this evidence:\n' + json(evidence), null, 'profile', () => {});
          profileMerge(screen);
          return { traits: profileOverview() };
        }
        return { traits: profileOverview(), baseline: p.baseline };
      }
      case 'utilities': {
        if (body.op === 'bundle') return libBundle(body.ids);
        if (body.op === 'review') { reviewLibrary(true); return { ok: true }; }
        if (body.op === 'delete') { const l = loadLib(); delete l.modules[body.id]; saveLib(l); }
        return libTree(body.path || []);
      }
      case 'window': return { ok: true };
      case 'libraries': {
        // The web version can't install: libraries load from jsDelivr (browser-cached).
        if (!libCatalog) { try { libCatalog = (await (await fetch('libraries.json')).json()).libraries; } catch { libCatalog = []; } }
        if (body.op === 'ensure') {
          const tags = [];
          for (const id of body.ids || []) {
            const e = libCatalog.find((x) => x.id === id);
            if (e) for (const f of e.files) tags.push({ type: f.type, src: f.url });
            else if (/^(@[\w.-]+\/)?[\w.-]+$/.test(id)) tags.push({ type: 'js', src: 'https://cdn.jsdelivr.net/npm/' + id });
          }
          return { tags };
        }
        return { libraries: libCatalog.map((x) => ({ id: x.id, description: x.description, category: x.category, bytes: x.bytes, installed: false })), used: 0, budget: 0 };
      }
      case 'system': {
        const k = getKey();
        return {
          app: { platform: 'web · ' + navigator.userAgent, generation: await gen(), language: navigator.language },
          ai: status(),
          storage: { icloud: false, root: 'this browser (localStorage)' },
          cache: { entries: Object.keys(loadCache()).length, bytes: (localStorage.getItem(CACHE) || '').length, limitBytes: LIMIT },
          libraries: { installed: 0, catalog: (libCatalog || []).length, usedBytes: 0, budgetBytes: 0, installing: [] },
          utilities: libTree([]),
          profile: { traits: profileOverview(300).length, top: profileOverview(6) },
          avoid: { active: avoidOverview(), all: Object.keys(loadAvoid()).length },
          hints: await call('hints', {}),
          key: k ? k.name : null,
        };
      }
      case 'avoid':
        if (body.op === 'record') { avoidRecord(body.items); return { ok: true }; }
        if (body.op === 'clear') { localStorage.removeItem(AVOID); return { ok: true }; }
        if (body.op === 'recheck') { avoidRecheck(); return { ok: true }; }
        return { entries: Object.values(loadAvoid()), active: avoidOverview() };
      case 'cache': {
        if (body.op === 'likely') return { label: likely(body.path) };
        if (body.op === 'invalidate') {
          const k = await keyOf(actionOf({ ...(body.action || {}) }));
          const c = loadCache(); delete c[k]; saveCache(c);
          return { ok: true };
        }
        if (body.op === 'clear') { localStorage.removeItem(CACHE); return {}; }
        if (body.op === 'search') {
          const q = String(body.q || '').toLowerCase().split(/\s+/).filter(Boolean);
          return { results: Object.values(loadCache()).filter((e) => {
            const hay = (e.description + ' ' + flowLine(e)).toLowerCase();
            return q.every((w) => hay.includes(w));
          }).slice(0, 50).map((e) => ({ key: e.key, description: e.description, hits: e.hits })) };
        }
        const raw = localStorage.getItem(CACHE) || '';
        return { entries: Object.keys(loadCache()).length, bytes: raw.length, limitBytes: LIMIT };
      }
      default: throw err('unknown endpoint');
    }
  }

  return { call };
})();
