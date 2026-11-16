// The browser backend of the web version (web/backend.js): provider keys, the agent loop with the
// `screen` tool (Anthropic and OpenAI-compatible), the memory cache, the utility library, the
// avoid record, retrospectives, the profile, and every endpoint.
import { test, expect } from '../harness.mjs';

const ANT = 'sk-ant-test';
const anthropicKey = { 'aiui.key': { provider: 'anthropic', name: 'Anthropic', base: 'https://api.anthropic.com', key: ANT, model: 'claude-opus-5-5' } };
const openaiKey = { 'aiui.key': { provider: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', key: 'sk-x', model: 'gpt-5' } };
const toolUse = (input, extra = {}) => ({ content: [{ type: 'tool_use', name: 'screen', id: 'tu' + Math.random(), input }], stop_reason: 'tool_use', ...extra });
const chat = (args, extra = []) => ({ choices: [{ message: { content: null, tool_calls: [...extra, { id: 'call1', function: { name: 'screen', arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }] });

// The app on top stays quiet (paused: no preloading pager calls to the provider).
const open = (app, o = {}) => app.open({ ...o, storage: { 'aiui.paused': '1', ...(o.storage || {}) } });

// Calls the backend in the page; returns { ok, value } or { ok: false, error }.
const call = (app, name, body) => app.ev(([n, b]) => WebBackend.call(n, b, (t) => (window.__progress = [...(window.__progress || []), t]))
  .then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: e.message })), [name, body]);

test('keys: every provider is recognised from the key; unknown keys are refused; forget', async ({ app }) => {
  await open(app);
  const cases = {
    'sk-ant-abc': ['anthropic', 'Anthropic', 'claude-opus-5-5'], 'sk-ant-abc my-model': ['anthropic', 'Anthropic', 'my-model'],
    'sk-or-abc': ['openai', 'OpenRouter', 'openrouter/auto'], 'AIzaXYZ': ['openai', 'Google Gemini', 'gemini-2.5-pro'],
    'gsk_1': ['openai', 'Groq', 'llama-3.3-70b-versatile'], 'xai-1': ['openai', 'xAI', 'grok-4'], 'sk-1 gpt-x': ['openai', 'OpenAI', 'gpt-x'],
    'https://llm.example.com/v1/ key1 m1': ['openai', 'llm.example.com', 'm1'], 'http://h.example key2': ['openai', 'h.example', ''],
  };
  for (const [text, [provider, name, model]] of Object.entries(cases)) {
    const r = await call(app, 'engine', { op: 'key', text });
    expect(r.value.active.label).toBe(`${name} · ${model}`);
    const k = await app.ev(() => JSON.parse(localStorage.getItem('aiui.key')));
    expect([k.provider, k.name, k.model]).toEqual([provider, name, model]);
  }
  expect(await app.ev(() => JSON.parse(localStorage.getItem('aiui.key')).base)).toBe('http://h.example');
  for (const bad of ['', '   ', 'hello', 'https://only-url']) expect((await call(app, 'engine', { op: 'key', text: bad })).error).toMatch(/Unrecognised key/);
  expect((await call(app, 'engine', { op: 'forget' })).value).toEqual({ options: [], active: null, web: true });
  expect((await call(app, 'info', {})).value).toEqual({ engine: 'web', ai: 'none' });
  // A corrupt stored key counts as none.
  await app.ev(() => localStorage.setItem('aiui.key', '{bad'));
  expect((await call(app, 'engine', { op: 'status' })).value.active).toBe(null);
});

test('no key: every AI endpoint says no-ai', async ({ app }) => {
  await open(app);
  for (const [n, b] of [['ai', {}], ['more', {}], ['console', {}], ['translate', {}], ['profile', { op: 'learn' }]]) {
    expect((await call(app, n, b)).error).toBe('no-ai');
  }
  expect((await call(app, 'nope', {})).error).toBe('unknown endpoint');
});

test('ai (Anthropic): the event, the screen tool, the cache, replays and reuse', async ({ app }) => {
  const screens = [];
  await open(app, { storage: anthropicKey, ai: (url, body) => {
    const s = screens.shift() || { kind: 'circles', title: 'Default', circles: [] };
    return toolUse(s);
  } });
  screens.push({ kind: 'circles', title: 'Menu', circles: [{ id: 'a', label: 'A' }], cacheable: true, note: 'the menu' });
  const input = { event: 'open', target: { label: 'Create' }, path: ['Home'], text: 'Make It', data: { x: 1 },
    screen: { title: 'Root', circles: [{ label: 'b', selected: true }, { label: 'a', selected: true }, { label: 'v', value: 2 }], removed: ['z'] } };
  const r1 = await call(app, 'ai', input);
  expect(r1.value.screen).toEqual({ kind: 'circles', title: 'Menu', circles: [{ id: 'a', label: 'A' }] });
  expect(r1.value.key).toMatch(/^[0-9a-f]{24}$/);
  const req = app.provider[0];
  expect(req.url).toBe('https://api.anthropic.com/v1/messages');
  expect(req.headers['x-api-key']).toBe(ANT);
  expect(req.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
  expect(req.body.fallbacks).toBe('default');
  expect(req.body.system).toMatch(/^SYSTEM\n\nEnd every turn by calling the `screen` tool/);
  expect(req.body.tools[0].name).toBe('screen');
  const ev1 = JSON.parse(req.body.messages[0].content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  expect(ev1.libraries.installable.length).toBe(25);
  expect(ev1.language).toBeTruthy();
  // Stored in the cache with its action.
  const cache = await app.ev(() => JSON.parse(localStorage.getItem('aiui.cache')));
  const e = Object.values(cache)[0];
  expect(e.action).toMatchObject({ event: 'open', path: ['Home'], target: 'Create', text: 'Make It', data: { x: 1 }, on: 'Root', selected: ['a', 'b'], values: ['v=2'], removed: ['z'] });
  expect(e.description).toBe('the menu');
  expect(e.cacheable).toBe(true);
  // The same action again: replayed from the cache, no provider call.
  const r2 = await call(app, 'ai', { ...input, text: ' make it ' });
  expect(r2.value.cached).toBe(true);
  expect(app.provider.length).toBe(1);
  // The next real turn hears about the replay, the memory, the flows, and continues the conversation.
  screens.push({ kind: 'text', title: 'Note', text: 'x' });
  const r3 = await call(app, 'ai', { event: 'text', text: 'menu please', path: ['Home', 'Create'] });
  expect(r3.value.screen.kind).toBe('text');
  const msgs = app.provider[1].body.messages;
  expect(msgs[1].role).toBe('assistant');
  expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', content: 'Screen shown.' });
  const ev3 = JSON.parse(msgs[2].content[1].text.match(/```json\n([\s\S]*)\n```/)[1]);
  expect(ev3.replayed.length).toBe(1);
  expect(ev3.memory[0].outcome).toBe('the menu');
  expect(ev3.flows.length).toBe(1);
  expect(ev3.flow).toEqual(['open Home → Create selected: a, b “ make it ”']);
  // Fresh: skips the cache.
  screens.push({ kind: 'circles', title: 'Fresh', circles: [] });
  expect((await call(app, 'ai', { ...input, fresh: true })).value.screen.title).toBe('Fresh');
  // Reuse: a cached outcome comes back with overrides.
  const key = r1.value.key;
  screens.push({ reuse: key, title: 'Menu again', more: true });
  const r5 = await call(app, 'ai', { event: 'go' });
  expect(r5.value.screen).toMatchObject({ kind: 'circles', title: 'Menu again', more: true, circles: [] });
  // Reuse of a key that is gone: the screen as given (without `reuse`).
  screens.push({ reuse: 'nope', kind: 'text', title: 'T' });
  expect((await call(app, 'ai', { event: 'go2' })).value.screen).toEqual({ kind: 'text', title: 'T' });
  // Reuse of an html outcome from an older prompt generation: not reused.
  await app.ev((k) => { const c = JSON.parse(localStorage.getItem('aiui.cache')); c[k].gen = 'old'; c[k].outcome.kind = 'html'; localStorage.setItem('aiui.cache', JSON.stringify(c)); }, key);
  screens.push({ reuse: key, kind: 'text', title: 'Own' });
  expect((await call(app, 'ai', { event: 'go3' })).value.screen.title).toBe('Own');
  // A cacheable hit from an older generation is not replayed.
  screens.push({ kind: 'circles', title: 'Regenerated', circles: [] });
  expect((await call(app, 'ai', input)).value.cached).toBeUndefined();
});

test('ai: guest mode, the user check, the profile, hints, the avoid record and the library reach the event', async ({ app }) => {
  await open(app, { storage: { ...anthropicKey,
    'aiui.profile': { traits: { 'a › b': { path: ['A', 'B'], value: 'likes tea', confidence: 0.9, evidence: 2 } }, baseline: {} },
    'aiui.hints': { journal: [], hints: { h1: { id: 'h1', text: 'use big fonts', scope: 'all', confidence: 0.8, evidence: 1 } }, lastRetro: 0, summary: '' },
    'aiui.avoid': { 'x.com': { key: 'x.com', kind: 'host', first: 0, failures: 3, reason: 'failed' } },
    'aiui.library': { modules: { m1: { id: 'm1', path: ['ui'], name: 'tea timer', kind: 'js', description: 'tea', usage: 'lib.t()', code: 'x', version: 1, uses: 0, lastUsed: 0 } }, aliases: {}, since: 0 },
  }, ai: () => toolUse({ kind: 'text', title: 'T' }) });
  await call(app, 'ai', { event: 'text', text: 'tea', userCheck: { suspect: true } });
  const ev = JSON.parse(app.provider[0].body.messages[0].content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  expect(ev.user).toEqual({ profile: ['A › B: likes tea (0.9)'], check: { suspect: true } });
  expect(ev.hints).toEqual(['use big fonts (all, ×1)']);
  expect(ev.avoid[0]).toMatch(/^x.com — failed ×3 since 1970-01-01/);
  expect(ev.library[0]).toBe('ui › tea timer (util, js, v1) — tea · usage: lib.t() [m1]');
  expect(ev.libraryCategories).toEqual(['ui']);
  expect(ev.userCheck).toBeUndefined();
  await call(app, 'ai', { event: 'text', text: 'more tea', guest: true });
  const ev2 = JSON.parse(app.provider[1].body.messages[2].content[1].text.match(/```json\n([\s\S]*)\n```/)[1]);
  expect(ev2.user).toEqual({ guest: true });
  expect(ev2.guest).toBeUndefined();
});

test('ai: published modules go to the library and the screen uses them; the library gets reviewed', async ({ app }) => {
  const mod = (name, extra = {}) => ({ name, path: ['tools', '', 'x', 'y', 'z'], code: 'lib.' + name + ' = 1;', description: 'd ' + name, ...extra });
  let review = null;
  await open(app, { storage: { ...anthropicKey, 'aiui.library': { modules: {}, aliases: {}, since: 0, lastReview: Date.now() } }, ai: (url, body) => {
    if (body.system.includes('LIBRARIAN')) return (typeof review === 'function' ? review() : Promise.resolve(review)).then(toolUse);
    const ev = body.messages[body.messages.length - 1].content.find((c) => c.type === 'text').text;
    if (ev.includes('"publish-one"')) return toolUse({ kind: 'html', html: '<p>', uses: ['old'], publish: [mod('a', { kind: 'css', role: 'component' }), mod('b'), null, { name: 'nocode' }] });
    return toolUse({ kind: 'html', html: '<p>', publish: [mod('c', { path: [] }), mod('d'), mod('e'), mod('f'), mod('a', { usage: 'u' })] });
  } });
  const r = await call(app, 'ai', { event: 'publish-one' });
  expect(r.value.published).toBe(2);
  expect(r.value.screen.uses.length).toBe(3);
  expect(r.value.screen.uses[0]).toBe('old');
  expect(r.value.screen.publish).toBeUndefined();
  let lib = await app.ev(() => JSON.parse(localStorage.getItem('aiui.library')));
  const a = Object.values(lib.modules).find((m) => m.name === 'a');
  expect(a).toMatchObject({ path: ['tools', 'x', 'y'], kind: 'css', role: 'component', version: 1 });
  // Six published since the last review: the librarian runs (renames, merges, removes, updates).
  const ids = () => app.ev(() => Object.fromEntries(Object.values(JSON.parse(localStorage.getItem('aiui.library')).modules).map((m) => [m.name, m.id])));
  review = null;
  let before = await ids();
  review = async () => { before = await ids(); return {
    updates: [{ id: before.a, code: 'new code', description: 'better', usage: null }, { id: before.b, path: ['renamed'], name: 'b2' }, { id: 'ghost' }, { id: before.c, name: 'c' }],
    merge: [{ from: [before.d, before.e], into: { path: ['m', ''], name: 'de', kind: 'css', code: 'merged' } }, { from: [before.f] }, { from: ['x'], into: { name: 'n' } }],
    remove: [] }; };
  const r2 = await call(app, 'ai', { event: 'publish-many' });
  expect(r2.value.published).toBe(5);
  await expect.poll(async () => (await app.ev(() => JSON.parse(localStorage.getItem('aiui.library')).since))).toBe(0);
  lib = await app.ev(() => JSON.parse(localStorage.getItem('aiui.library')));
  const byName = Object.fromEntries(Object.values(lib.modules).map((m) => [m.name, m]));
  expect(byName.a).toMatchObject({ code: 'new code', description: 'better', version: 3, usage: 'u' });
  expect(byName.b2.path).toEqual(['renamed']);
  expect(lib.aliases[before.b]).toBe(byName.b2.id);
  expect(byName.de).toMatchObject({ kind: 'css', path: ['m'], version: 2, code: 'merged' });
  expect(byName.d).toBeUndefined();
  expect(lib.since).toBe(0);
  // Bundles resolve ids, aliases and paths; the tree lists categories and utilities.
  const b = (await call(app, 'utilities', { op: 'bundle', ids: [before.b, 'renamed/b2', byName.a.id, byName.de.id, 'missing', 'm/DE'] })).value;
  expect(b.ids).toEqual([byName.b2.id, byName.a.id, byName.de.id]);
  expect(b.js).toBe(`/* renamed/b2 v1 */\nlib.b = 1;\n;\n/* tools/x/y/a v3 */\nnew code`);
  expect(b.css).toBe(`/* m/de v2 */\nmerged`);
  const tree = (await call(app, 'utilities', { op: 'tree' })).value;
  expect(tree.categories.map((c) => c.name)).toEqual(['m', 'renamed', 'tools', 'misc'].filter((n) => tree.categories.some((c) => c.name === n)));
  expect(tree.total).toBe(Object.keys(lib.modules).length);
  const sub = (await call(app, 'utilities', { op: 'tree', path: ['m'] })).value;
  expect(sub.utilities).toEqual([{ id: byName.de.id, name: 'de', icon: '🧩', description: '', uses: 1 }]);
  // Delete, and a forced review (with too few modules nothing happens).
  await call(app, 'utilities', { op: 'delete', id: byName.de.id, path: [] });
  expect((await call(app, 'utilities', { op: 'review' })).value).toEqual({ ok: true });
  // A review removing modules.
  review = { remove: [byName.a.id] };
  await call(app, 'utilities', { op: 'review' });
  await expect.poll(() => app.ev((id) => !JSON.parse(localStorage.getItem('aiui.library')).modules[id], byName.a.id)).toBe(true);
});

test('library review: skipped while one runs, with fewer than two modules, without a key; a failing one is harmless', async ({ app }) => {
  let hold = null;
  await open(app, { storage: { ...anthropicKey, 'aiui.library': { modules: { m1: { id: 'm1', path: ['a'], name: 'x', kind: 'js', code: 'c', uses: 0, version: 1, description: '' }, m2: { id: 'm2', path: ['a'], name: 'y', kind: 'css', code: 'c', uses: 0, version: 1, description: '' } }, aliases: {}, since: 0 } },
    ai: () => (hold ? hold : { status: 500, json: { error: { message: 'down' } } }) });
  expect((await call(app, 'utilities', { op: 'tree', path: ['a'] })).value.utilities.map((u) => u.icon)).toEqual(['🔧', '🧩']);
  await call(app, 'utilities', { op: 'review' });
  await expect.poll(() => app.provider.length).toBe(1);
  // While one runs, another review does nothing.
  let release; hold = new Promise((r) => { release = r; });
  await call(app, 'utilities', { op: 'review' });
  await expect.poll(() => app.provider.length).toBe(2);
  await call(app, 'utilities', { op: 'review' });
  release(toolUse({}));
  await app.settle(200);
  expect(app.provider.length).toBe(2);
  hold = null;
  // No key: nothing.
  await app.ev(() => localStorage.removeItem('aiui.key'));
  await call(app, 'utilities', { op: 'review' });
  await app.settle(100);
  expect(app.provider.length).toBe(2);
});

test('Anthropic loop: web search progress, pause_turn, nudges, refusals, token limits, other models', async ({ app }) => {
  const queue = [];
  await open(app, { storage: { 'aiui.key': { ...anthropicKey['aiui.key'], model: 'claude-x' } }, ai: () => queue.shift() || { content: [{ type: 'text', text: 'hm' }], stop_reason: 'end_turn' } });
  queue.push({ content: [{ type: 'server_tool_use', name: 'web_search' }], stop_reason: 'pause_turn' }, { content: [{ type: 'text', text: 'thinking' }], stop_reason: 'end_turn' }, toolUse({ kind: 'text', title: 'S' }));
  const r = await call(app, 'more', { path: ['a'], input: 'q', screen: { title: 'T' } });
  expect(r.value).toEqual({ kind: 'text', title: 'S' });
  expect(await app.ev(() => window.__progress)).toBeUndefined(); // side calls report no progress
  expect(app.provider[0].headers['anthropic-beta']).toBeUndefined();
  expect(app.provider[2].body.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Call the screen tool now with the next screen.' }] });
  // Progress for the main turn.
  queue.push({ content: [{ type: 'server_tool_use' }], stop_reason: 'pause_turn' }, toolUse({ kind: 'text' }));
  await call(app, 'ai', { event: 'go' });
  expect(await app.ev(() => window.__progress)).toEqual(['searching the web']);
  queue.push({ content: [], stop_reason: 'refusal' });
  expect((await call(app, 'suggest', {})).error).toBe('The model declined this request.');
  queue.push({ stop_reason: 'max_tokens' });
  expect((await call(app, 'tests', {})).error).toBe('The model ran out of output tokens.');
  // Twelve rounds without a screen.
  const n = app.provider.length;
  expect((await call(app, 'menus', {})).error).toBe('The model did not produce a screen.');
  expect(app.provider.length - n).toBe(12);
  // A screen tool call without input.
  queue.push({ content: [{ type: 'tool_use', name: 'screen', id: 't' }], stop_reason: 'tool_use' });
  expect((await call(app, 'quick', {})).value).toEqual({});
});

test('OpenAI-compatible loop: tool calls, other calls skipped, bad arguments, JSON in text, nudges', async ({ app }) => {
  const queue = [];
  await open(app, { storage: openaiKey, ai: () => queue.shift() || { choices: [{ message: { content: 'no json here' } }] } });
  queue.push(chat({ kind: 'circles', title: 'O', circles: [] }, [{ id: 'other', function: { name: 'x', arguments: '{}' } }]));
  const r = await call(app, 'ai', { event: 'go' });
  expect(r.value.screen.title).toBe('O');
  const req = app.provider[0];
  expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
  expect(req.headers.authorization).toBe('Bearer sk-x');
  expect(req.body.messages[0].role).toBe('system');
  // The next turn: the tool result, the skipped call answered.
  queue.push(chat('not json'));
  expect((await call(app, 'ai', { event: 'go2' })).value.screen).toEqual({});
  const msgs = app.provider[1].body.messages;
  expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  expect(msgs[4]).toEqual({ role: 'tool', tool_call_id: 'call1', content: 'Screen shown.' });
  queue.push({ choices: [{ message: { content: 'Here: {"kind":"text","title":"J"} done' } }] });
  expect((await call(app, 'prefetch', {})).value).toEqual({ kind: 'text', title: 'J' });
  queue.push({ choices: [{ message: { content: '{not json}' } }] }, { choices: [{ message: { content: '} {' } }] }, { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'screen' } }] } }] });
  expect((await call(app, 'refine', {})).value).toEqual({});
  queue.push({ choices: [] });
  expect((await call(app, 'refine', {})).error).toBe('Unexpected response from OpenAI');
  const n = app.provider.length;
  expect((await call(app, 'translate', { language: 'de', strings: {} })).error).toBe('The model did not produce a screen.');
  expect(app.provider.length - n).toBe(6);
  queue.push(chat({ reply: 'hi' }));
  expect((await call(app, 'console', { command: 'x' })).value).toEqual({ reply: 'hi' });
  queue.push(chat({ strings: { go: 'Los' } }));
  expect((await call(app, 'translate', { language: 'de' })).value).toEqual({ strings: { go: 'Los' } });
});

test('provider errors: HTTP errors, network failures, cancelled requests', async ({ app }) => {
  let mode = 'http';
  let release;
  await open(app, { storage: openaiKey, ai: () => {
    if (mode === 'http') return { status: 429, json: { error: { message: 'slow down' } } };
    if (mode === 'text') return { status: 502, raw: 'gateway' };
    if (mode === 'net') return { abort: 'failed' };
    return new Promise((r) => { release = r; });
  } });
  expect((await call(app, 'ai', { event: 'go' })).error).toBe('OpenAI error 429: slow down');
  mode = 'text';
  expect((await call(app, 'ai', { event: 'go' })).error).toMatch(/^OpenAI error 502: /);
  mode = 'net';
  expect((await call(app, 'ai', { event: 'go' })).error).toMatch(/^Network error: /);
  // A request superseded on its channel, and one cancelled by name, reject with "cancelled".
  mode = 'hang';
  const p1 = app.ev(() => WebBackend.call('more', {}).catch((e) => e.message));
  await expect.poll(() => app.provider.length).toBe(4);
  const p2 = app.ev(() => WebBackend.call('more', {}).catch((e) => e.message));
  expect(await p1).toBe('cancelled');
  await expect.poll(() => app.provider.length).toBe(5);
  expect((await call(app, 'cancel', { pager: true })).value).toEqual({ ok: true });
  expect(await p2).toBe('cancelled');
  // The main turn cancels the background channels.
  const p3 = app.ev(() => WebBackend.call('suggest', {}).catch((e) => e.message));
  await expect.poll(() => app.provider.length).toBe(6);
  const p4 = app.ev(() => WebBackend.call('ai', { event: 'x' }).catch((e) => e.message));
  expect(await p3).toBe('cancelled');
  await expect.poll(() => app.provider.length).toBe(7);
  expect((await call(app, 'cancel', {})).value).toEqual({ ok: true });
  expect(await p4).toBe('cancelled');
  expect((await call(app, 'cancel', { tester: true })).value).toEqual({ ok: true });
  expect((await call(app, 'reset', {})).value).toEqual({ ok: true });
});

test('usage, app values, adopt, cache endpoints', async ({ app }) => {
  await open(app, { storage: anthropicKey, ai: () => toolUse({ kind: 'circles', title: 'Shown', circles: [], cacheable: true }) });
  expect((await call(app, 'usage', { key: 'k', title: 'T', opened: true, interactions: 3, dwellMs: 120000 })).value).toEqual({ ok: true });
  await call(app, 'usage', { key: 'k', opened: true });
  await call(app, 'usage', { op: 'improve' });
  const scenes = (await call(app, 'usage', { op: 'list' })).value.scenes;
  expect(scenes).toEqual([expect.objectContaining({ key: 'k', title: 'T', opens: 2, minutes: 2, interactions: 3 })]);
  expect((await call(app, 'usage', { op: 'outcome', key: 'none' })).value).toEqual({ screen: null });
  await app.ev(() => localStorage.setItem('aiui.usage', '{bad'));
  expect((await call(app, 'usage', { op: 'list' })).value.scenes).toEqual([]);
  // App values.
  expect((await call(app, 'app', { op: 'set', key: 'theme', value: { a: 1 } })).value).toEqual({ ok: true });
  expect((await call(app, 'app', { op: 'get', key: 'theme' })).value).toEqual({ value: { a: 1 } });
  expect((await call(app, 'app', { op: 'get', key: 'none' })).value).toEqual({ value: null });
  expect((await call(app, 'app', { op: 'all' })).value).toEqual({ values: { theme: { a: 1 } } });
  await app.ev(() => localStorage.setItem('aiui.app', '{bad'));
  expect((await call(app, 'app', { op: 'all' })).value).toEqual({ values: {} });
  // Adopt: a prefetched screen shown is stored as that action's outcome and reported next turn.
  expect((await call(app, 'adopt', { event: 'open', target: { label: 'Mail' }, path: ['Home'], outcome: { kind: 'circles', title: 'Mail', circles: [], note: 'mail list' } })).value).toEqual({ ok: true });
  expect((await call(app, 'adopt', { event: 'open', target: { label: 'X' } })).value).toEqual({ ok: true });
  await call(app, 'ai', { event: 'open', target: { label: 'Next' }, path: ['Home', 'Mail'] });
  const ev = JSON.parse(app.provider[0].body.messages[0].content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  expect(ev.prefetched).toEqual([expect.objectContaining({ target: 'Mail', shown: 'mail list' })]);
  await call(app, 'adopt', { event: 'open', target: { label: 'Y' }, outcome: { kind: 'text', title: 'Yt' } });
  await call(app, 'adopt', { event: 'open', target: { label: 'Z' }, outcome: { kind: 'text' } });
  // The outcome of a key, the likely circle, search, stats, invalidate, clear.
  const key = Object.keys(await app.ev(() => JSON.parse(localStorage.getItem('aiui.cache'))))[0];
  expect((await call(app, 'usage', { op: 'outcome', key })).value.screen.title).toBe('Mail');
  expect((await call(app, 'cache', { op: 'likely', path: ['Home'] })).value).toEqual({ label: 'Mail' });
  expect(['Y', 'Z']).toContain((await call(app, 'cache', { op: 'likely' })).value.label); // the most recent of equals
  expect((await call(app, 'cache', { op: 'search', q: 'mail list' })).value.results).toEqual([expect.objectContaining({ description: 'mail list', hits: 1 })]);
  expect((await call(app, 'cache', { op: 'search' })).value.results.length).toBe(4);
  expect((await call(app, 'cache', {})).value).toMatchObject({ entries: 4, limitBytes: 3 * 1024 * 1024 });
  expect((await call(app, 'cache', { op: 'invalidate', action: { event: 'open', target: { label: 'Mail' }, path: ['Home'] } })).value).toEqual({ ok: true });
  expect((await call(app, 'cache', {})).value.entries).toBe(3);
  await call(app, 'cache', { op: 'invalidate' });
  expect((await call(app, 'cache', { op: 'clear' })).value).toEqual({});
  expect((await call(app, 'cache', {})).value.entries).toBe(0);
  // A corrupt cache counts as empty.
  await app.ev(() => localStorage.setItem('aiui.cache', '{bad'));
  expect((await call(app, 'cache', {})).value.entries).toBe(0);
});

test('the cache drops least recently used entries past its limit; a full storage is survived', async ({ app }) => {
  await open(app, { storage: anthropicKey, ai: () => toolUse({ kind: 'text', title: 'x'.repeat(700000) }) });
  for (let i = 0; i < 4; i++) await call(app, 'ai', { event: 'e' + i });
  const keys = await app.ev(() => Object.values(JSON.parse(localStorage.getItem('aiui.cache'))).map((e) => e.action.event));
  expect(keys).toEqual(['e2', 'e3']);
  // Storage full: setItem throws, the call still answers.
  await app.ev(() => { Storage.prototype.setItem = () => { throw new Error('quota'); }; });
  expect((await call(app, 'ai', { event: 'e9' })).ok).toBe(true);
  for (const [n, b] of [['usage', { key: 'k' }], ['app', { op: 'set', key: 'a', value: 1 }], ['journal', { kind: 'k' }], ['profile', { op: 'baseline' }],
    ['avoid', { op: 'record', items: [{ url: 'https://a.example/' }] }], ['utilities', { op: 'delete', id: 'x' }]]) {
    expect((await call(app, n, b)).ok).toBe(true);
  }
});

test('journal, hints and retrospectives', async ({ app }) => {
  let answer = { hints: [{ text: 'Use larger fonts', scope: 'html', why: 'small', confidence: 0.9 }, { text: '' }, { id: 'old', text: 'Keep it' }], retire: ['gone'], summary: 'did it' };
  await open(app, { storage: { ...anthropicKey, 'aiui.hints': { journal: [], hints: { old: { id: 'old', text: 'Keep', confidence: 0.7, evidence: 2 }, gone: { id: 'gone', text: 'g', confidence: 1, evidence: 1 } }, lastRetro: Date.now() - 1000, summary: '' } },
    ai: (url, body) => toolUse(answer) });
  for (let i = 0; i < 14; i++) await call(app, 'journal', { kind: 'error', scene: 'S', detail: 'd' + i });
  expect(app.provider.length).toBe(0);
  await call(app, 'journal', { kind: 'error', scene: 'S', detail: 'd14' });
  await expect.poll(() => app.provider.length).toBe(1);
  expect(app.provider[0].body.system).toMatch(/RETRO/);
  await expect.poll(async () => (await call(app, 'hints', {})).value.summary).toBe('did it');
  const h = (await call(app, 'hints', {})).value;
  expect(h.journal).toBe(15);
  expect(h.sinceRetro).toBe(0);
  expect(h.lastRetro).toMatch(/^\d{4}-/);
  expect(h.recent.length).toBe(10);
  expect(h.hints.map((x) => [x.id, x.text, x.evidence])).toEqual([['old', 'Keep it', 3], ['huselargerfonts', 'Use larger fonts', 1]]);
  // Forced; a failing retrospective; one at a time.
  answer = {};
  await call(app, 'hints', { op: 'retro' });
  await expect.poll(() => app.provider.length).toBe(2);
  await expect.poll(async () => (await call(app, 'hints', {})).value.summary).toBe('');
  app.ai = () => ({ status: 500, json: {} });
  await call(app, 'hints', { op: 'retro' });
  await expect.poll(() => app.provider.length).toBe(3);
  let release;
  app.ai = () => new Promise((r) => { release = r; });
  await call(app, 'hints', { op: 'retro' });
  await expect.poll(() => app.provider.length).toBe(4);
  await call(app, 'hints', { op: 'retro' });
  release(toolUse({}));
  await app.settle(100);
  expect(app.provider.length).toBe(4);
  // Three incidents more than six hours after the last retrospective.
  await app.ev(() => { const h = JSON.parse(localStorage.getItem('aiui.hints')); h.lastRetro = Date.now() - 7 * 3600000; h.journal = []; localStorage.setItem('aiui.hints', JSON.stringify(h)); });
  app.ai = () => toolUse({});
  for (let i = 0; i < 3; i++) await call(app, 'journal', { kind: 'x' });
  await expect.poll(() => app.provider.length).toBe(5);
  // No key: no retrospective; corrupt hints count as none.
  await app.ev(() => localStorage.removeItem('aiui.key'));
  await call(app, 'hints', { op: 'retro' });
  await app.ev(() => localStorage.setItem('aiui.hints', '{bad'));
  expect((await call(app, 'hints', {})).value).toMatchObject({ journal: 0, lastRetro: '' });
  expect(app.provider.length).toBe(5);
});

test('profile: baseline, tree, remove, learn (the profiler), overview', async ({ app }) => {
  let answer = { updates: [{ path: ['Food', 'Drinks', 'Tea'], value: 'green', confidence: 0.8 }, { path: ['Work'], value: 'dev' }, { path: [], value: 'x' }, { path: ['a'] }, { path: ['Food', 'Drinks', 'Tea'], value: 'oolong', confidence: 2 }],
    remove: [['Gone']] };
  await open(app, { storage: { ...anthropicKey, 'aiui.profile': { traits: { gone: { path: ['Gone'], value: 'x', confidence: 0.5, evidence: 1 } }, baseline: {} } }, ai: () => toolUse(answer) });
  expect((await call(app, 'profile', { op: 'baseline', baseline: { typeGap: { n: 1 } } })).value).toEqual({ ok: true });
  expect((await call(app, 'profile', { op: 'get' })).value).toEqual({ traits: ['Gone: x (0.5)'], baseline: { typeGap: { n: 1 } } });
  const learned = await call(app, 'profile', { op: 'learn', behavior: { typeGap: { mean: 1 } } });
  expect(learned.ok).toBe(true);
  expect(learned.value.traits).toEqual(['Food › Drinks › Tea: oolong (0.9)', 'Work: dev (0.5)']);
  const ev = app.provider[0].body.messages[0].content[0].text;
  expect(ev).toMatch(/PROFILER/.test(app.provider[0].body.system) ? /behavior/ : /never/);
  expect((await call(app, 'profile', { op: 'tree' })).value).toEqual({ branches: [{ name: 'Food', count: 1 }], traits: [{ name: 'Work', value: 'dev', confidence: 0.5, path: ['Work'] }], total: 2 });
  expect((await call(app, 'profile', { op: 'tree', path: ['food', 'drinks'] })).value.traits[0].name).toBe('Tea');
  expect((await call(app, 'profile', { op: 'remove', path: ['Work'] })).value.total).toBe(1);
  expect((await call(app, 'profile', { op: 'remove' })).value.total).toBe(1);
  expect((await call(app, 'profile', { op: 'baseline' })).value).toEqual({ ok: true });
  // More than 300 traits: the weakest go.
  answer = { updates: Array.from({ length: 305 }, (_, i) => ({ path: ['T' + i], value: 'v', confidence: i / 400 })) };
  await call(app, 'profile', { op: 'learn' });
  expect((await call(app, 'profile', { op: 'tree' })).value.total).toBe(300);
  await app.ev(() => localStorage.setItem('aiui.profile', '{bad'));
  expect((await call(app, 'profile', { op: 'get' })).value).toEqual({ traits: [], baseline: {} });
});

test('sys: open web links, the clipboard, notifications; nothing else on the web', async ({ app, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write', 'notifications'], { origin: 'http://localhost:47231' });
  await open(app, { init: () => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; } });
  expect((await call(app, 'sys', { op: 'open', target: 'https://example.com/' })).value).toEqual({ ok: true });
  expect(await app.ev(() => window.__opened)).toEqual([['https://example.com/', '_blank', 'noopener']]);
  expect((await call(app, 'sys', { op: 'open', target: 'file:///etc' })).error).toBe('Only web links can be opened here.');
  expect((await call(app, 'sys', { op: 'open' })).error).toBe('Only web links can be opened here.');
  expect((await call(app, 'sys', { op: 'clipboard', text: 'hello' })).value).toEqual({ ok: true });
  expect((await call(app, 'sys', { op: 'clipboard' })).value).toEqual({ text: 'hello' });
  await app.ev(() => { window.__notes = []; window.Notification = class { constructor(t, o) { window.__notes.push([t, o.body]); } static requestPermission() { Notification.permission = 'granted'; return Promise.resolve('granted'); } }; Notification.permission = 'default'; });
  expect((await call(app, 'sys', { op: 'notify', title: 'Hi', text: 'there' })).value).toEqual({ ok: true });
  expect((await call(app, 'sys', { op: 'notify' })).value).toEqual({ ok: true });
  expect(await app.ev(() => window.__notes)).toEqual([['Hi', 'there'], ['AI UI', '']]);
  await app.ev(() => { Notification.permission = 'denied'; Notification.requestPermission = () => Promise.resolve('denied'); });
  expect((await call(app, 'sys', { op: 'notify' })).value).toEqual({ ok: true });
  expect(await app.ev(() => window.__notes.length)).toBe(2);
  expect((await call(app, 'sys', { op: 'run', cmd: 'ls' })).error).toMatch(/Not available in the web version/);
});

test('libraries: tags from the catalog or jsDelivr; the list; a missing catalog', async ({ app }) => {
  await open(app);
  const r = (await call(app, 'libraries', { op: 'ensure', ids: ['d3', '@scope/pkg', 'bad id!', 'leaflet'] })).value;
  expect(r.tags.some((t) => t.src.includes('d3'))).toBe(true);
  expect(r.tags).toContainEqual({ type: 'js', src: 'https://cdn.jsdelivr.net/npm/@scope/pkg' });
  expect(r.tags.some((t) => t.src.includes('bad id'))).toBe(false);
  expect((await call(app, 'libraries', { op: 'ensure' })).value).toEqual({ tags: [] });
  const list = (await call(app, 'libraries', { op: 'list' })).value;
  expect(list.libraries.length).toBeGreaterThan(1000);
  expect(list.libraries[0].installed).toBe(false);
  expect((await call(app, 'window', { op: 'x' })).value).toEqual({ ok: true });
});

test('a missing library catalog and missing prompts', async ({ app }) => {
  app.files['/libraries.json'] = { status: 404 };
  await open(app, { storage: anthropicKey, ai: () => toolUse({ kind: 'text' }) });
  expect((await call(app, 'libraries', { op: 'list' })).value.libraries).toEqual([]);
  expect((await call(app, 'ai', { event: 'go' })).ok).toBe(true);
  const ev = JSON.parse(app.provider[0].body.messages[0].content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  expect(ev.libraries.installable).toEqual([]);
});

test('a missing catalog in an AI turn first', async ({ app }) => {
  app.files['/libraries.json'] = { status: 404 };
  await open(app, { storage: anthropicKey, ai: () => toolUse({ kind: 'text' }) });
  expect((await call(app, 'ai', { event: 'go' })).ok).toBe(true);
  expect((await call(app, 'libraries', { op: 'ensure', ids: ['x'] })).value.tags).toEqual([{ type: 'js', src: 'https://cdn.jsdelivr.net/npm/x' }]);
});

test('system: a summary of everything stored in the browser', async ({ app }) => {
  await open(app, { storage: anthropicKey });
  const s = (await call(app, 'system', {})).value;
  expect(s.app.generation).toMatch(/^[0-9a-f]{12}$/);
  expect(s.ai.active.label).toBe('Anthropic · claude-opus-5-5');
  expect(s.key).toBe('Anthropic');
  expect(s.cache).toMatchObject({ entries: 0, bytes: 0 });
  expect(s.hints).toMatchObject({ journal: 0 });
  await app.ev(() => localStorage.removeItem('aiui.key'));
  expect((await call(app, 'system', {})).value.key).toBe(null);
});

test('avoid record: failures by host and URL, rechecked with backoff, cleared', async ({ app }) => {
  await open(app, { init: () => {
    window.__probe = {};
    const RealImage = window.Image;
    window.Image = function () { const i = {}; setTimeout(() => (window.__probe[i.src] ? i.onload() : i.onerror()), 1); return Object.defineProperty(i, 'src', { set(v) { this._s = v; }, get() { return this._s; } }); };
  } });
  await call(app, 'avoid', { op: 'record', items: [{ url: 'https://a.example/x.png', reason: '404' }, { url: 'https://a.example/x.png' }, { url: 'not a url' }, { url: 'https://b.example/api', reason: 'dns' }] });
  await call(app, 'avoid', { op: 'record' });
  let all = (await call(app, 'avoid', {})).value;
  expect(all.entries.map((e) => [e.key, e.failures, e.reason])).toEqual([
    ['a.example', 2, 'failed'], ['https://a.example/x.png', 2, 'failed'], ['b.example', 1, 'dns'], ['https://b.example/api', 1, 'dns']]);
  expect(all.active.length).toBe(4);
  // Nothing due yet.
  await call(app, 'avoid', { op: 'recheck' });
  await app.settle();
  expect((await call(app, 'avoid', {})).value.entries.every((e) => e.checks === 0)).toBe(true);
  // Due: images probe as images, the rest with a no-cors fetch (refused here: still failing).
  await app.ev(() => { const a = JSON.parse(localStorage.getItem('aiui.avoid')); for (const e of Object.values(a)) e.nextCheck = 0; localStorage.setItem('aiui.avoid', JSON.stringify(a)); window.__probe['https://a.example/x.png'] = false; });
  await call(app, 'avoid', { op: 'recheck' });
  await app.tick(100);
  await expect.poll(async () => (await call(app, 'avoid', {})).value.entries.every((e) => e.checks === 1)).toBe(true);
  all = (await call(app, 'avoid', {})).value.entries;
  expect(all[0].backoff).toBe(1200000);
  // A host that answers again leaves the record with its URLs.
  await app.ev(() => { const a = JSON.parse(localStorage.getItem('aiui.avoid')); for (const e of Object.values(a)) e.nextCheck = 0; a['bad url'] = { key: 'bad url', kind: 'url', first: 0, failures: 1, nextCheck: 1e15 }; localStorage.setItem('aiui.avoid', JSON.stringify(a)); window.__probe['https://a.example/x.png'] = true; });
  await call(app, 'avoid', { op: 'recheck' });
  await app.tick(100);
  await expect.poll(async () => (await call(app, 'avoid', {})).value.entries.map((e) => e.key).sort()).toEqual(['b.example', 'bad url', 'https://b.example/api']);
  // An entry removed while its probe runs; a probe that never answers (15 s).
  await app.ev(() => { const a = JSON.parse(localStorage.getItem('aiui.avoid')); a['b.example'].nextCheck = 0; localStorage.setItem('aiui.avoid', JSON.stringify(a)); window.fetch = () => new Promise(() => {}); });
  await call(app, 'avoid', { op: 'recheck' });
  await app.ev(() => { const a = JSON.parse(localStorage.getItem('aiui.avoid')); delete a['b.example']; localStorage.setItem('aiui.avoid', JSON.stringify(a)); });
  await app.tick(15100);
  await app.settle();
  // A fetch that answers.
  await app.ev(() => { const a = JSON.parse(localStorage.getItem('aiui.avoid')); a['https://b.example/api'].nextCheck = 0; localStorage.setItem('aiui.avoid', JSON.stringify(a)); window.fetch = () => Promise.resolve({}); });
  await app.tick(60000);
  await expect.poll(async () => (await call(app, 'avoid', {})).value.entries.map((e) => e.key)).toEqual(['bad url']);
  expect((await call(app, 'avoid', { op: 'clear' })).value).toEqual({ ok: true });
  expect((await call(app, 'avoid', {})).value.entries).toEqual([]);
  await app.ev(() => localStorage.setItem('aiui.avoid', '{bad'));
  expect((await call(app, 'avoid', {})).value.entries).toEqual([]);
});

test('a corrupt library counts as empty', async ({ app }) => {
  await open(app, { storage: { 'aiui.library': '{bad' } });
  expect((await call(app, 'utilities', { op: 'tree' })).value).toEqual({ categories: [], utilities: [], total: 0 });
});
