// Browser backend for the web version (aiui.oeaio.com). The Mac app serves /api/* natively; on
// the web the same calls are answered here: the visitor's own API key (kept in localStorage),
// an agent loop with a `screen` tool, and the memory cache in localStorage. No system access.
'use strict';

const WebBackend = (() => {
  const KEY = 'aiui.key', CACHE = 'aiui.cache', LIMIT = 3 * 1024 * 1024; // cache size limit (bytes)
  let prompts = null;
  const aborts = {};      // channel -> AbortController
  let convo = [];         // main conversation (append-only), provider wire format
  let openScreen = null;  // id of the last `screen` call awaiting its tool result
  let replayed = [];
  let flow = [];          // [{depth, line}]
  let prefetchedShown = []; // prefetched screens opened since the main AI last heard from us

  const err = (m) => new Error(m);
  const loadPrompts = async () => prompts || (prompts = await (await fetch('prompts.json')).json());

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
    c[key] = { key, action, flow: steps, outcome, description: note || `${outcome.kind} ${outcome.title || ''}`.trim(),
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

  // ------------------------------------------------------------- utilities library

  const UTILS = 'aiui.utils', UTILS_LIMIT = 2 * 1024 * 1024;
  const loadUtils = () => { try { return JSON.parse(localStorage.getItem(UTILS)) || {}; } catch { return {}; } };
  function saveUtils(u) {
    let json = JSON.stringify(u);
    const ids = Object.keys(u).sort((a, b) => u[a].lastUsed - u[b].lastUsed);
    while (json.length > UTILS_LIMIT && ids.length) { delete u[ids.shift()]; json = JSON.stringify(u); }
    try { localStorage.setItem(UTILS, json); } catch {}
  }
  async function saveUtility(screen) {
    const m = screen.utility;
    if (!m || !m.name) return null;
    const path = (m.path || []).filter(Boolean).slice(0, 3);
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((path.join('/') + '/' + m.name).toLowerCase()));
    const id = 'u' + [...new Uint8Array(h)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
    const { utility, note, cacheable, reuse, ...stored } = screen;
    const u = loadUtils(), prev = u[id];
    u[id] = { id, name: m.name, icon: m.icon || '🧰', description: m.description || '', path: path.length ? path : ['General'],
      screen: stored, created: prev ? prev.created : Date.now(), lastUsed: Date.now(), uses: prev ? prev.uses : 0 };
    saveUtils(u);
    return u[id];
  }
  function utilTree(path) {
    const all = Object.values(loadUtils());
    const under = all.filter((i) => JSON.stringify(i.path.slice(0, path.length)) === JSON.stringify(path));
    const cats = {}, here = [];
    for (const i of under) {
      if (i.path.length > path.length) {
        const c = i.path[path.length];
        cats[c] = cats[c] || { name: c, count: 0, uses: 0 };
        cats[c].count++; cats[c].uses += i.uses;
      } else here.push(i);
    }
    return {
      categories: Object.values(cats).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
      utilities: here.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
        .map((i) => ({ id: i.id, name: i.name, icon: i.icon, description: i.description })),
      total: all.length,
    };
  }
  function utilOverview(words, limit = 30) {
    const ws = words.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return Object.values(loadUtils()).map((i) => {
      const hay = (i.path.join(' ') + ' ' + i.name + ' ' + i.description).toLowerCase();
      return [i, ws.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)];
    }).sort((a, b) => b[1] - a[1] || b[0].uses - a[0].uses).slice(0, limit)
      .map(([i]) => `${[...i.path, i.name].join(' › ')} — ${i.description} [${i.id}]`);
  }
  const utilCategories = () => [...new Set(Object.values(loadUtils())
    .flatMap((i) => i.path.map((_, n) => i.path.slice(0, n + 1).join(' › '))))].sort();

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

    const hit = !input.fresh && loadCache()[key];
    if (hit && hit.cacheable) {
      touch(key);
      replayed = [...replayed, action].slice(-20);
      return { screen: hit.outcome, cached: true };
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
    const uo = utilOverview(words);
    if (uo.length) { event.utilities = uo; event.utilityCategories = utilCategories(); }
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
    if (out.reuse && /^u/.test(out.reuse) && loadUtils()[out.reuse]) {
      const u = loadUtils(), item = u[out.reuse];
      item.uses++; item.lastUsed = Date.now(); saveUtils(u);
      out = { ...item.screen, ...(out.title ? { title: out.title } : {}), note: out.note, cacheable: out.cacheable };
    }
    if (out.reuse) {
      const e = touch(out.reuse);
      if (e) {
        const over = {};
        for (const f of ['title', 'message', 'go', 'more', 'back', 'note', 'cacheable']) if (out[f] != null) over[f] = out[f];
        out = { ...e.outcome, ...over };
      }
      delete out.reuse;
    }
    const saved = await saveUtility(out);
    const { utility, ...shown } = store(key, action, steps, out);
    return { screen: shown, ...(saved ? { savedUtility: { id: saved.id, path: saved.path, name: saved.name } } : {}) };
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
        const ch = body.pager ? 'pager' : body.suggest ? 'suggest' : body.scout ? 'scout' : body.refine ? 'refine' : 'ai';
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
        if (body.op === 'open') {
          const u = loadUtils(), item = u[body.id];
          if (!item) throw err('Utility not found.');
          item.uses++; item.lastUsed = Date.now(); saveUtils(u);
          return { screen: item.screen };
        }
        if (body.op === 'delete') { const u = loadUtils(); delete u[body.id]; saveUtils(u); }
        return utilTree(body.path || []);
      }
      case 'cache': {
        if (body.op === 'likely') return { label: likely(body.path) };
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
