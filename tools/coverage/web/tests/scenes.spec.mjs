// AI-written html scenes: the frame and its shims, the aiui API across the frame boundary, scene
// listeners, health and repairs, the on-screen check and the hidden lab, libraries, seamless updates.
import { test, expect } from '../harness.mjs';
import { routes, circleScreen, until, deferred, err } from './util.mjs';

const frame = async (app) => (await app.page.waitForSelector('#view iframe:not(.outgoing)', { state: 'attached' })).contentFrame();
// Shows an html scene (an AI one unless local is given) as a history entry with a key. Marked
// `fixed` (no self-repair, no lab) unless the test is about those: `repairable: true`.
const scene = (app, s, key = 'k1') => app.ev(([s, key]) => { const { repairable, ...x } = s; stack.push(current); current = { screen: normalize(repairable ? x : { fixed: true, ...x }), label: s.title, key }; render(); }, [s, key]);
const inFrame = async (app, fn, arg) => (await frame(app)).evaluate(fn, arg);
const ready = async (app) => { const f = await frame(app); await f.waitForFunction(() => window.aiui && document.readyState === 'complete'); return f; };

test('web: the scene is sandboxed and reaches the app through postMessage (state, app values, settings, memory…)', async ({ app }) => {
  await app.open({ storage: { 'aiui.key': { provider: 'anthropic', name: 'A', base: 'https://x', key: 'k', model: 'm' } } });
  await scene(app, { kind: 'html', title: 'Web scene', html: '<p id="p">hi</p>' }, 'ws');
  const f = await ready(app);
  expect(await app.page.getAttribute('#view iframe', 'sandbox')).toBe('allow-scripts allow-forms allow-popups allow-modals');
  const r = await f.evaluate(async () => {
    const out = {};
    await aiui.state.save({ n: 1 });
    out.state = await aiui.state.load();
    await aiui.app.set('k', 5);
    out.app = await aiui.app.get('k');
    let got = null; aiui.app.subscribe('k', (v) => { got = v; });
    await new Promise((r) => setTimeout(r, 10));
    await aiui.app.set('k', 6);
    await new Promise((r) => setTimeout(r, 30));
    out.sub = got;
    out.settings = await aiui.settings();
    await aiui.setting('prefetch', false);
    await aiui.action('zoom', '1');
    out.stats = await aiui.memory.stats();
    out.search = await aiui.memory.search('x');
    out.info = await aiui.media.state();
    try { await aiui.sys({ op: 'run' }); } catch (e) { out.sysErr = e.message; }
    out.ready = await aiui.ready();
    return out;
  });
  expect(r.state).toEqual({ n: 1 });
  expect(r.app).toBe(5);
  expect(r.sub).toBe(6);
  expect(r.settings).toMatchObject({ prefetch: true, paused: false });
  expect(await app.ev(() => [settings.prefetch, zoomLevel])).toEqual([false, 1.1]);
  expect(r.stats).toMatchObject({ entries: 0 });
  expect(r.search).toEqual([]);
  expect(r.info).toBe(null);
  expect(r.sysErr).toMatch(/Not available in the web version/);
  expect(await app.ev(() => JSON.parse(localStorage.getItem('aiui.state.ws')))).toEqual({ n: 1 });
  // An unknown call is refused.
  expect(await f.evaluate(() => new Promise((res) => { addEventListener('message', (e) => { if (e.data.aiuiReply === 999) res(e.data.error); }); parent.postMessage({ aiuiCall: 999, m: 'nope' }, '*'); }))).toBe('unknown call');
  // Activity with quick actions: the action runs in the scene.
  await f.evaluate(() => aiui.activity('dl', 'Downloading', [{ icon: '✕', label: 'Stop', run: () => { window.__stopped = true; } }]));
  await expect(app.page.locator('#activity')).toHaveText(/Downloading/);
  await app.ev(() => activities.get('scene:dl').actions[0].run());
  await f.waitForFunction(() => window.__stopped === true);
  await f.evaluate(() => aiui.activity('dl', ''));
  expect(await app.ev(() => activities.has('scene:dl'))).toBe(false);
  // next / back / home go to the app.
  app.ai = () => ({ content: [{ type: 'tool_use', name: 'screen', id: 't', input: { kind: 'text', title: 'Next one' } }], stop_reason: 'tool_use' });
  await f.evaluate(() => { aiui.next({ label: 'Go on', x: 1 }); });
  await expect(app.page.locator('#title')).toHaveText('Next one');
  await app.ev(() => back());
  const f2 = await ready(app);
  await f2.evaluate(() => { aiui.back(); });
  await expect(app.page.locator('#title')).toHaveText('');
  // Media from the scene.
  await scene(app, { kind: 'html', title: 'Media', html: '' }, 'mm');
  const f3 = await ready(app);
  expect(await f3.evaluate(() => aiui.media.play('ftp://x', 'X').catch((e) => e.message))).toBe('media: a URL is required');
  expect(await f3.evaluate(() => aiui.media.pause())).toBe(null);
  expect(await f3.evaluate(() => aiui.media.resume())).toBe(null);
  expect(await f3.evaluate(() => aiui.media.stop())).toBe(null);
  await f3.evaluate(() => { aiui.home(); });
  await expect(app.page.locator('#title')).toHaveText('');
});

test('web: keys and links inside the sandboxed scene', async ({ app }) => {
  await app.open({ init: () => { window.open = (...a) => { (window.__opened = window.__opened || []).push(a[0]); }; } });
  await scene(app, { kind: 'html', title: 'Keys', html: '<a id="a" href="https://example.com/x">x</a> <a id="b" href="javascript:void 0">in</a> <input id="i">' });
  const f = await ready(app);
  await f.evaluate(() => document.getElementById('a').click());
  await expect.poll(() => app.ev(() => window.__opened)).toEqual(['https://example.com/x']);
  await f.evaluate(() => document.getElementById('b').click());
  await f.evaluate(() => document.body.click());
  // ` toggles the console; Escape and Backspace go to the app; ⌘ keys too.
  await f.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '`', bubbles: true })));
  await expect(app.page.locator('#console')).toBeVisible();
  await app.ev(() => toggleConsole(false));
  await f.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })));
  await expect(app.page.locator('#title')).toHaveText('Actions');
  await app.ev(() => back());
  const f2 = await ready(app);
  await f2.evaluate(() => document.getElementById('i').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })));
  await expect(app.page.locator('#title')).toHaveText('Keys');
  await f2.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })));
  await expect(app.page.locator('#title')).toHaveText('Connect an AI');
});

test('native: the scene shares the app\'s aiui; keys and links are handled from its document', async ({ app }) => {
  let sysFail = false;
  await app.open({ native: true, api: routes({ sys: (b) => (sysFail ? Promise.reject(err('cannot open')) : { ok: true }) }) });
  await scene(app, { kind: 'html', title: 'Native scene', html: '<a id="a" href="https://example.com/">x</a><a id="f" href="file:///tmp/x">f</a><a id="r" href="rel">r</a><p>t</p>' });
  const f = await ready(app);
  expect(await app.page.getAttribute('#view iframe', 'sandbox')).toBe(null);
  expect(await f.evaluate(() => typeof aiui.memory.search)).toBe('function');
  await f.evaluate(() => document.getElementById('a').click());
  await expect.poll(() => app.sent('sys').map((c) => c.body)).toEqual([{ op: 'open', target: 'https://example.com/' }]);
  sysFail = true;
  await f.evaluate(() => document.getElementById('f').click());
  await expect(app.page.locator('#toast')).toHaveText('cannot open');
  await f.evaluate(() => { document.getElementById('r').addEventListener('click', (e) => e.preventDefault()); document.getElementById('r').click(); document.querySelector('p').click(); });
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '`', bubbles: true })));
  await expect(app.page.locator('#console')).toBeVisible();
  await app.ev(() => toggleConsole(false));
  await f.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  // A frame whose document is gone by load time.
  await app.ev(() => { const fr = el.view.querySelector('iframe'); Object.defineProperty(fr, 'contentDocument', { get: () => null }); fr.dispatchEvent(new Event('load')); });
});

test('scene listeners: Back and More go to the scene first; a handler returning false passes them on', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: (b) => ({ screen: { kind: 'text', title: 'AI ' + b.event, text: '' } }) }) });
  await scene(app, { kind: 'html', title: 'L', more: true, html: '<script>window.__n = { back: 0, more: 0 }; aiui.onBack(() => { __n.back++; return __n.back > 1 ? false : undefined; }); aiui.onMore(async () => { __n.more++; if (__n.more > 1) throw new Error("x"); });</script>' });
  const f = await ready(app);
  await until(app, () => current.screen.listens && current.screen.listens.back && current.screen.listens.more);
  await expect(app.page.locator('#more')).toHaveClass(/on/);
  await expect(app.page.locator('#prev')).toHaveClass(/on/);
  await app.page.click('#prev');
  await f.waitForFunction(() => window.__n.back === 1);
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('L');
  await app.page.click('#more');
  await f.waitForFunction(() => window.__n.more === 1);
  await app.settle();
  expect(app.sent('ai').length).toBe(0);
  // The second More throws: not handled, the AI extends the screen.
  await app.page.click('#more');
  await expect(app.page.locator('#title')).toHaveText('AI more');
  await app.ev(() => back());
  await ready(app);
  await until(app, () => current.screen.listens && current.screen.listens.back);
  // Second Back returns false: the app goes back.
  await app.page.click('#prev');
  await app.page.click('#prev');
  await expect(app.page.locator('#title')).toHaveText('');
  // A scene that never answers: 1.2 s, then the app acts.
  await scene(app, { kind: 'html', title: 'Mute', html: '' });
  await ready(app);
  await app.ev(() => { current.screen.listens = { back: true }; });
  await app.ev(() => { el.view.querySelector('iframe').contentWindow.postMessage = () => {}; back(); });
  await app.tick(1300);
  await expect(app.page.locator('#title')).toHaveText('');
  // Without a frame or listener: false at once.
  expect(await app.ev(() => invokeScene('back'))).toBe(false);
});

test('bar icons from scenes: run the scene\'s function, send a prompt, stay global, open their applet elsewhere', async ({ app }) => {
  await app.open({ native: true, api: routes({
    ai: (b) => ({ screen: { kind: 'text', title: 'Bar ' + b.action.prompt, text: '' } }),
    usage: (b, d) => (b.op === 'outcome' ? { screen: b.key === 'gone' ? null : { kind: 'html', title: 'Origin applet', html: '<script>aiui.bar.add("g", "★", "Star", () => { window.__star = (window.__star || 0) + 1; }, { global: true }); aiui.ready();</script>' } } : d('usage', b)),
  }) });
  await scene(app, { kind: 'html', title: 'Bars', html: '<script>aiui.bar.add("a", "🅰️", "Alpha", () => { window.__a = (window.__a || 0) + 1; }); aiui.bar.add("p", "💬", "Prompt", "say hi"); aiui.bar.add("g", "★", "Star", () => { window.__star = (window.__star || 0) + 1; }, { global: true }); aiui.bar.add("x", "x", "X", () => {}); aiui.bar.remove("x");</script>' }, 'origin');
  const f = await ready(app);
  await expect(app.page.locator('#sceneBar button')).toHaveCount(3);
  await app.page.click('#sceneBar button[aria-label="Alpha"]');
  await f.waitForFunction(() => window.__a === 1);
  await app.page.click('#sceneBar button[aria-label="Star"]');
  await f.waitForFunction(() => window.__star === 1);
  // A prompt icon asks the AI.
  await app.page.click('#sceneBar button[aria-label="Prompt"]');
  await expect(app.page.locator('#title')).toHaveText('Bar say hi');
  expect(app.sent('ai')[0].body).toMatchObject({ event: 'bar', action: { id: 'p', prompt: 'say hi' } });
  expect(await app.ev(() => JSON.parse(localStorage.getItem('aiui.bar')).map((b) => b.id))).toEqual(['g']);
  // Elsewhere: the global icon opens its applet and runs there once it is ready.
  await app.ev(() => home());
  await expect(app.page.locator('#sceneBar button')).toHaveCount(1);
  await app.page.click('#sceneBar button[aria-label="Star"]');
  await expect(app.page.locator('#title')).toHaveText('Origin applet');
  const f2 = await ready(app);
  await app.tick(100);
  await f2.waitForFunction(() => window.__star === 1);
  // Right-click removes an icon.
  await app.ev(() => home());
  await app.page.click('#sceneBar button[aria-label="Star"]', { button: 'right' });
  await expect(app.page.locator('#sceneBar button')).toHaveCount(0);
  // A global prompt icon whose applet is gone: the prompt goes to the AI instead.
  await app.ev(() => { current.key = 'other'; barAdd({ id: 'gp', icon: '?', prompt: 'from global', global: true }, true); current.key = undefined; });
  await app.ev(() => { globalBar[0].origin = { key: 'gone', label: 'Gone' }; renderSceneBar(); });
  await app.page.click('#sceneBar button[aria-label="gp"]');
  await expect(app.page.locator('#title')).toHaveText('Bar from global');
  // An applet opened from a bar icon that is gone, without a prompt: nothing.
  await app.ev(() => { globalBar = [{ id: 'z', icon: 'z', title: 'Z', origin: { key: 'gone' }, scene: true }]; renderSceneBar(); });
  await app.page.click('#sceneBar button[aria-label="Z"]');
  await app.settle();
  expect(await app.ev(() => pendingBarClick)).toBe(null);
  // A circle screen declares its bar and removes icons; a scene icon on a screen without a frame does nothing.
  await app.ev(() => { current.screen = normalize({ kind: 'circles', title: 'Decl', bar: [{ id: 'd', icon: 'D', title: 'Decl' }], barRemove: ['z'], circles: [] }); render(); });
  await expect(app.page.locator('#sceneBar button')).toHaveCount(1);
  await app.page.click('#sceneBar button[aria-label="Decl"]');
  // Corrupt saved bar.
  await app.ev(() => { localStorage.setItem('aiui.bar', '{bad'); Storage.prototype.setItem = () => { throw new Error('quota'); }; saveGlobalBar(); });
});

test('typing on a scene: keys nobody handles open the input; handled ones stay in the scene', async ({ app }) => {
  await app.open({ native: true });
  await scene(app, { kind: 'html', title: 'Typing', html: '<input id="i"><div id="d"></div><script>' +
    'document.addEventListener("keydown", (e) => { if (e.key === "h") document.getElementById("d").textContent = "handled"; });' +
    'document.addEventListener("keydown", { handleEvent(e) { if (e.key === "j") e.preventDefault(); } });' +
    '</script>' });
  const f = await ready(app);
  const key = (k, opts = {}) => f.evaluate(([k, o]) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })), [k, opts]);
  await key('h');
  await app.tick(10);
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  await key('j');
  await app.tick(10);
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  await key('q');
  await app.tick(10);
  await expect(app.page.locator('#write')).toHaveValue('q');
  await app.ev(() => stopWriting(true));
  // Not for editable targets, modifiers, non-characters; Space only on the page itself.
  await f.evaluate(() => document.getElementById('i').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true })));
  await key('z', { ctrlKey: true });
  await key('ArrowUp');
  await f.evaluate(() => document.getElementById('d').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
  await key('`', {});
  await app.ev(() => toggleConsole(false));
  await app.tick(10);
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  // A lone ⌘ inside the scene.
  await f.evaluate(() => { dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })); dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })); });
  await expect(app.page.locator('body')).toHaveClass(/typing/);
  await app.ev(() => stopWriting(true));
  await f.evaluate(() => { dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })); dispatchEvent(new MouseEvent('mousedown')); dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })); dispatchEvent(new Event('blur')); dispatchEvent(new KeyboardEvent('keyup', { key: 'a' })); });
  await f.evaluate(() => { dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })); postMessage({ aiuiMetaUsed: true }, '*'); });
  await app.tick(5);
  await f.evaluate(() => dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })));
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
  // A scene without key listeners at all: every character goes to the input at once.
  await scene(app, { kind: 'html', title: 'Plain', html: '<p>p</p>' }, 'k2');
  const g = await ready(app);
  await g.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true })));
  await expect(app.page.locator('#write')).toHaveValue('w');
  await app.ev(() => stopWriting(true));
  // A scene that tracks held keys (keyup) keeps every key; one with onkeydown too.
  await scene(app, { kind: 'html', title: 'Game', html: '<script>addEventListener("keyup", () => {}); document.body.addEventListener("keyup", () => {}); const i = document.createElement("input"); i.addEventListener("keyup", () => {}); removeEventListener("keyup", () => {});</script>' }, 'k3');
  const h = await ready(app);
  await h.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true })));
  await scene(app, { kind: 'html', title: 'Prop', html: '<script>document.onkeydown = () => {};</script>' }, 'k4');
  const p = await ready(app);
  await p.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true })));
  await app.tick(10);
  await expect(app.page.locator('body')).not.toHaveClass(/typing/);
});

test('scene input, usage, screenshots and the media hand-off', async ({ app }) => {
  await app.open({ native: true });
  await scene(app, { kind: 'html', title: 'Use', html: '<audio id="au"></audio>' }, 'use1');
  const f = await ready(app);
  await f.evaluate(() => { window.html2canvas = async () => ({ toDataURL: () => 'data:image/jpeg;base64,xx' }); });
  await expect.poll(() => app.sent('usage').some((c) => c.body.opened && c.body.key === 'use1')).toBe(true);
  // Input tells the app the user is active; interactions are counted every 5 s.
  await f.evaluate(() => { dispatchEvent(new PointerEvent('pointerdown')); dispatchEvent(new PointerEvent('pointerdown')); });
  await expect.poll(() => app.ev(() => lastInputAt > 0)).toBe(true);
  await app.tick(5100);
  await expect.poll(() => app.sent('usage').some((c) => c.body.interactions === 2)).toBe(true);
  // A screenshot after 4 s (html2canvas from the library store; here a stand-in).
  await app.tick(4100);
  await expect.poll(() => app.sent('usage').some((c) => c.body.screenshot === 'data:image/jpeg;base64,xx')).toBe(true);
  await f.evaluate(() => { window.html2canvas = async () => { throw new Error('x'); }; postMessage({ aiuiShotRequest: true }, '*'); postMessage({}, '*'); });
  // Without html2canvas: loaded from the store, else the CDN (both fail here: no shot).
  await f.evaluate(() => { delete window.html2canvas; postMessage({ aiuiShotRequest: true, local: '/nope.js' }, '*'); });
  await app.settle(300);
  await app.ev(() => { current.screen.health = []; current.screen.failures = 0; clearTimeout(current.screen.failTimer); });
  // A scene that plays: reported; left while playing: the app player continues it.
  await f.evaluate(() => parent.postMessage({ aiuiPlaying: { url: 'https://media.example/a.mp3', time: 3, rate: 1, title: 'Song' } }, '*'));
  await until(app, () => scenePlaying && scenePlaying.title === 'Song');
  await app.ev(() => { window.__played = []; HTMLMediaElement.prototype.play = function () { window.__played.push(this.src); return Promise.resolve(); }; });
  await app.ev(() => back());
  await expect.poll(() => app.ev(() => window.__played)).toEqual(['https://media.example/a.mp3']);
  await expect(app.page.locator('#sceneBar button')).toHaveCount(1);
  await expect.poll(() => app.sent('usage').some((c) => c.body.dwellMs != null)).toBe(true);
  // Stopped: nothing playing reported.
  await scene(app, { kind: 'html', title: 'Use2', html: '' }, 'use2');
  const g = await ready(app);
  await g.evaluate(() => parent.postMessage({ aiuiPlaying: null }, '*'));
  await until(app, () => scenePlaying === null);
  // Hand-off on reload: the scene reports what plays; the app player takes it over.
  app.page.on('console', () => {});
  await g.evaluate(() => {
    const a = new Audio(); Object.defineProperty(a, 'paused', { get: () => false }); Object.defineProperty(a, 'currentSrc', { get: () => 'https://media.example/b.mp3' });
    Object.defineProperty(a, 'currentTime', { get: () => 7, set() {} });
    HTMLMediaElement.prototype.play.call(a).catch(() => {});
    a.pause = () => { window.__paused = true; };
  });
  await app.ev(() => { reloadScene(); });
  await expect.poll(() => app.ev(() => window.__played.length)).toBe(2);
  expect(await app.ev(() => nowPlaying.url)).toBe('https://media.example/b.mp3');
  // A scene that does not answer the hand-off: after 400 ms the reload goes on.
  await ready(app);
  await app.ev(() => { el.view.querySelector('iframe').contentWindow.postMessage = () => {}; reloadScene(); });
  await app.tick(500);
  await app.settle(100);
  // Reply without a hand-off pending is ignored.
  const h = await ready(app);
  await h.evaluate(() => parent.postMessage({ aiuiHandoffReply: null }, '*'));
  // The scene hears what the app plays (it doesn't start a second copy).
  await h.evaluate(() => postMessage({ aiuiNowPlaying: 'https://media.example/b.mp3' }, '*'));
  await h.evaluate(() => postMessage({ aiuiNowPlaying: 'https://media.example/b.mp3' }, '*'));
});

test('health reports: failures go to the avoid record; enough of them repair the scene', async ({ app }) => {
  let fixed = deferred();
  await app.open({ native: true, api: routes({ ai: (b) => (b.event === 'fix' ? fixed.promise : { screen: circleScreen('x', []) }) }) });
  await scene(app, { kind: 'html', title: 'Broken', repairable: true, html: '<img src="https://img.example/missing.png"><script>fetch("https://api.example/data"); fetch(new Request("https://api.example/r")); throw new Error("oops");</script>' }, 'br');
  const f = await ready(app);
  await f.evaluate(() => { const i = new Image(); i.src = 'https://img.example/b.png'; Promise.reject(new Error('rej')); Promise.reject('plain'); });
  await app.tick(900);
  await expect.poll(() => app.sent('avoid', 'record').length).toBeGreaterThan(0);
  const items = app.sent('avoid', 'record').flatMap((c) => c.body.items);
  expect(items.map((i) => i.url)).toEqual(expect.arrayContaining(['https://img.example/missing.png', 'https://api.example/data', 'https://api.example/r', 'https://img.example/b.png']));
  expect(items.every((i) => !i.url.endsWith(':'))).toBe(true);
  await app.tick(2100);
  await expect.poll(() => app.sent('ai').filter((c) => c.body.event === 'fix').length).toBe(1);
  const fix = app.sent('ai').find((c) => c.body.event === 'fix').body;
  expect(fix.problem.reason).toMatch(/failures reported/);
  expect(fix.problem.errors.join(' ')).toMatch(/oops/);
  expect(fix.broken.title).toBe('Broken');
  await expect(app.page.locator('#status')).toHaveText('this screen got stuck — fixing…');
  fixed.resolve({ screen: { kind: 'html', title: 'Fixed', html: '<p>ok</p>' } });
  await expect(app.page.locator('#title')).toHaveText('Fixed');
  expect(await app.ev(() => current.screen.fixed)).toBe(true);
  // A fixed scene isn't repaired again; health on a circle screen is ignored.
  await app.ev(() => { viewHealth({ kind: 'error', detail: 'x' }); selfFix(current.screen, 'again'); });
  await app.ev(() => { current.screen = { kind: 'circles', circles: [] }; viewHealth({ kind: 'error', detail: 'x' }); });
  // Timeouts and HTTP statuses are recorded by kind.
  await app.ev(() => { current.screen = { kind: 'html', title: 'T', html: '' }; viewHealth({ kind: 'timeout', detail: 'fetch over 20s: https://slow.example/' }); viewHealth({ kind: 'fetch', detail: '503 https://down.example/' }); for (let i = 0; i < 31; i++) viewHealth({ kind: 'resource', detail: 'n' }); });
  await app.tick(900);
  await expect.poll(() => app.sent('avoid', 'record').flatMap((c) => c.body.items).map((i) => i.reason)).toEqual(expect.arrayContaining(['timeout', '503']));
  expect(await app.ev(() => current.screen.health.length)).toBe(30);
  // A failing repair toasts (unless cancelled or the user left).
  fixed = deferred();
  await scene(app, { kind: 'html', title: 'B2', repairable: true, html: '' }, 'b2');
  await app.ev(() => { selfFix(current.screen, 'test'); });
  fixed.reject(err('AI down'));
  await expect(app.page.locator('#toast')).toHaveText('Could not fix this screen: AI down');
  fixed = deferred();
  await scene(app, { kind: 'html', title: 'B3', repairable: true, html: '' }, 'b3');
  await app.ev(() => { current.evt = { event: 'open' }; selfFix(current.screen, 'test'); });
  await expect.poll(() => app.sent('cache', 'invalidate').length).toBe(1);
  await app.ev(() => home());
  fixed.resolve({ screen: { kind: 'html', title: 'B3 fixed', html: '' } });
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('');
  fixed = deferred();
  await scene(app, { kind: 'html', title: 'B4', repairable: true, html: '' }, 'b4');
  await app.ev(() => { selfFix(current.screen, 'test'); home(); });
  fixed.reject(err('cancelled'));
  await app.settle();
});

test('a scene that never says ready is repaired after its render budget', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: () => ({ screen: { kind: 'html', title: 'Repaired', html: '' } }) }) });
  await until(app, () => !!QA_SRC);
  await app.ev(() => { QA_SRC = ''; }); // no on-screen check here: only the render budget
  await scene(app, { kind: 'html', title: 'Slow', repairable: true, timeouts: { render: { seconds: 5 } }, html: '<p>never ready</p>' });
  await app.tick(5100);
  await expect(app.page.locator('#title')).toHaveText('Repaired');
  expect(app.sent('ai')[0].body.problem.reason).toMatch(/^not ready after 5s/);
  // Ready in time: no repair; left: no repair.
  await scene(app, { kind: 'html', title: 'Fine', repairable: true, html: '<script>aiui.ready()</script>' }, 'f2');
  await app.tick(16000);
  await scene(app, { kind: 'html', title: 'Left', repairable: true, html: '' }, 'f3');
  await app.ev(() => home());
  await app.tick(16000);
  expect(app.sent('ai').length).toBe(1);
  // With health reported before the budget.
  await scene(app, { kind: 'html', title: 'Slow2', repairable: true, html: '' }, 'f4');
  await app.ev(() => { current.screen.health = ['x']; });
  await app.tick(15100);
  await expect.poll(() => app.sent('ai').length).toBe(2);
  expect(app.sent('ai')[1].body.problem.reason).toBe('not ready after 15s');
});

test('the on-screen check (qa.js) reports; low scores repair; the hidden lab and the DoD tests run', async ({ app }) => {
  let tests = { dod: ['Shows a greeting', 'Has a button'], tests: [{ name: 'greets', criterion: 0, code: 't.expect(t.exists("#g"), "no greeting")' }, { name: 'button', criterion: 1, code: 't.expect(false, "no button")' }, { name: 'nocode' }] };
  let fixes = 0;
  await app.open({ native: true, api: routes({
    tests: () => tests,
    ai: (b) => { fixes++; return { screen: { kind: 'html', title: 'After fix', html: '<p>fixed</p>' } }; },
    menus: () => ({ classes: [] }),
  }) });
  await until(app, () => !!QA_SRC);
  await scene(app, { kind: 'html', title: 'Checked', repairable: true, uses: ['m1'], html: '<h1 id="g">Hello</h1><script>aiui.ready()</script>' }, 'qa1');
  await expect(app.page.locator('#view')).toHaveClass(/checking/);
  await expect(app.page.locator('#view iframe')).toHaveClass(/testing/);
  // The real view reports after ready (+300 ms).
  await app.tick(400);
  await until(app, () => current.screen.reviewed);
  await expect(app.page.locator('#view')).not.toHaveClass(/checking/);
  expect(await app.ev(() => current.screen.quality.screen.scores.ux)).toBeGreaterThan(0);
  expect(await app.ev(() => checkedBefore(current.screen))).toBe(true);
  // The lab clone (phone, other theme) runs every interaction; then the DoD tests.
  await app.tick(5000);
  await until(app, () => current.screen.quality.lab);
  await expect.poll(() => app.sent('tests').length).toBe(1);
  expect(app.sent('tests')[0].body.screen.title).toBe('Checked');
  await app.tick(5000);
  await until(app, () => lastQuality && lastQuality.tests);
  expect(await app.ev(() => lastQuality.dod.map((d) => d.ok))).toEqual([true, false]);
  // An unmet DoD repairs the scene.
  await expect.poll(() => fixes).toBe(1);
  expect(app.sent('ai')[0].body.problem.reason).toMatch(/^Definition of Done not met \(1 of 2\): Has a button/);
  expect(app.sent('journal').some((c) => c.body.kind === 'dod')).toBe(true);
  // The system screen shows the last scene's quality.
  await app.ev(() => showSystem());
  const sys = await (await app.page.waitForSelector('#view iframe')).contentFrame();
  await sys.waitForSelector('text=Definition of Done (last scene)');
  expect(await sys.textContent('body')).toMatch(/✗ button/);
});

test('review and lab results: failing scores repair; component feedback; skipped labs; one lab at a time', async ({ app }) => {
  await app.open({ native: true, api: routes({ ai: () => ({ screen: { kind: 'html', title: 'Fixed', html: '' } }), menus: () => ({ classes: [] }) }) });
  await scene(app, { kind: 'html', title: 'Q', repairable: true, uses: ['c1'], html: '' }, 'q');
  await app.ev(() => viewReview({ issues: ['layout: cut off'], scores: { ux: 50, readability: 90, accessibility: 90, security: 100 }, width: 800, height: 600, classes: ['button'],
    corners: [{ case: 'offline', ok: false, note: 'x' }] }));
  await expect.poll(() => app.sent('utilities', 'feedback').length).toBe(1);
  expect(app.sent('utilities', 'feedback')[0].body).toMatchObject({ ids: ['c1'], findings: ['layout: cut off'] });
  await expect.poll(() => app.sent('ai').length).toBe(1);
  expect(app.sent('ai')[0].body.problem.reason).toMatch(/UI test on screen at 800×600 — UX 50, readability 90, accessibility 90, security 100 \(repair below 70\): 1 issue\(s\); corner cases failing: offline/);
  // A second review of the same scene is ignored; reviews of non-html screens too.
  await app.ev(() => { viewReview({ scores: { ux: 1 } }); current.screen = { kind: 'circles', circles: [] }; viewReview({}); viewReady(); });
  // Lab results with nothing pending.
  await app.ev(() => { labResult({ scores: { ux: 1, readability: 1, accessibility: 1 } }); testsResult({}); labResult(null); });
  // A lab result that fails: health and a repair (once).
  await scene(app, { kind: 'html', title: 'L', repairable: true, html: '' }, 'l');
  await app.ev(() => { labFor = { frame: document.createElement('iframe'), screen: current.screen }; labResult({ issues: ['ux: dead'], scores: { ux: 40 }, tested: 3, width: 390, height: 844 }); });
  await expect.poll(() => app.sent('ai').length).toBe(2);
  expect(app.sent('ai')[1].body.problem.reason).toMatch(/^interaction lab \(3 controls, phone, other theme\)/);
  // Passing lab / tests: nothing to repair.
  await scene(app, { kind: 'html', title: 'L2', html: '' }, 'l2');
  await app.ev(() => { labFor = { frame: document.createElement('iframe'), screen: current.screen }; labResult({ issues: [], scores: { ux: 99 } }); });
  await app.ev(() => { current.screen.aiTests = [{ criterion: 0 }]; current.screen.dod = ['x']; labFor = { frame: document.createElement('iframe'), screen: current.screen }; testsResult({ results: [{ name: 'a', ok: true }] }); });
  await app.ev(() => { current.screen.aiTests = []; labFor = { frame: document.createElement('iframe'), screen: current.screen }; testsResult({}); });
  expect(app.sent('ai').length).toBe(2);
  // Labs: not for local or paused or with QA off; one at a time (the next waits); dropped when the screen is left.
  await app.ev(() => { if (labFor) { labFor.frame.remove(); labFor = null; } });
  await app.ev(() => { runLab({ local: 'x' }, {}, ''); paused = true; runLab({}, {}, ''); paused = false; settings.qa = false; runLab({}, {}, ''); settings.qa = true; });
  await app.ev(() => { labFor = { frame: document.createElement('iframe'), screen: {} }; runLab({ kind: 'html' }, { base: '', libs: '' }, '<head></head><p>x</p>'); });
  await app.ev(() => { labFor = null; });
  await app.tick(1600);
  await until(app, () => !!document.querySelector('#lab iframe'));
  expect(await app.ev(() => document.querySelector('#lab iframe').srcdoc.includes('<head><style>:root'))).toBe(true);
  await app.ev(() => render());
  expect(await app.ev(() => labFor)).toBe(null);
  // A lab that never reports is removed after 25 s.
  await app.ev(() => { if (labFor) { labFor.frame.remove(); labFor = null; } });
  await app.ev(() => runLab({ kind: 'html' }, { base: '', libs: '' }, 'x'));
  await app.tick(25100);
  expect(await app.ev(() => labFor)).toBe(null);
  // DoD tests: not when paused, off, already asked, local, not html, or without a lab head; failures are harmless.
  app.api = routes({ tests: () => Promise.reject(err('x')) });
  await app.ev(() => { paused = true; requestSceneTests({}); paused = false; settings.dod = false; requestSceneTests({}); settings.dod = true;
    requestSceneTests({ testsRequested: true }); requestSceneTests({ local: 'x' }); requestSceneTests({ kind: 'circles' }); requestSceneTests({ kind: 'html' }); });
  const mine = () => app.sent('tests').filter((c) => ['T', 'T2'].includes(c.body.screen.title)).length;
  await app.ev(() => requestSceneTests({ kind: 'html', labHead: {}, title: 'T' }));
  await expect.poll(mine).toBe(1);
  app.api = routes({ tests: () => ({}) });
  await app.ev(() => requestSceneTests({ kind: 'html', labHead: {}, title: 'T2', html: 'x' }));
  await expect.poll(mine).toBe(2);
});

test('libraries for scenes: JS libraries and shared modules are injected; failures degrade', async ({ app }) => {
  let fail = false;
  await app.open({ native: true, api: routes({
    libraries: () => (fail ? Promise.reject(err('x')) : { tags: [{ type: 'css', src: 'aiui://lib/a.css' }, { type: 'js', src: 'aiui://lib/"b".js' }] }),
    utilities: (b) => (fail ? Promise.reject(err('x')) : b.op === 'bundle' ? { js: 'window.lib.ok = 1; // </script>', css: 'p{color:red}' } : { categories: [], utilities: [], total: 0 }),
  }) });
  await scene(app, { kind: 'html', title: 'Libs', libs: ['a', 'b'], uses: ['m'], html: '<html><head><title>x</title></head><body><p>x</p></body></html>' });
  const f = await ready(app);
  expect(await f.evaluate(() => window.lib.ok)).toBe(1);
  const doc = await app.ev(() => el.view.querySelector('iframe').srcdoc);
  expect(doc).toContain('<link rel="stylesheet" href="aiui://lib/a.css">');
  expect(doc).toContain('<script src="aiui://lib/&quot;b&quot;.js"></script>');
  expect(doc).toContain('<style>p{color:red}</style>');
  expect(app.sent('libraries', 'ensure')[0].body.ids).toEqual(['a', 'b']);
  fail = true;
  await scene(app, { kind: 'html', title: 'Libs2', libs: ['a'], uses: ['m'], html: '<p>y</p>' }, 'k2');
  const g = await ready(app);
  expect(await g.evaluate(() => typeof window.lib)).toBe('object');
  fail = false;
  app.api = routes({ libraries: () => ({}), utilities: () => ({}) });
  await scene(app, { kind: 'html', title: 'Libs3', libs: ['a'], uses: ['m'], html: '<p>z</p>' }, 'k3');
  await ready(app);
  // A screen left before its libraries arrive is not rendered.
  const d = deferred();
  app.api = routes({ libraries: () => d.promise });
  await scene(app, { kind: 'html', title: 'Libs4', libs: ['a'], html: '<p>w</p>' }, 'k4');
  await app.ev(() => home());
  d.resolve({ tags: [] });
  await app.settle();
});

test('seamless updates: improved versions reload live when the user is idle, keeping state', async ({ app }) => {
  let outcome = { kind: 'html', title: 'Improved', fixed: true, html: '<script>aiui.ready()</script>' };
  await app.open({ native: true, api: routes({ usage: (b, d) => (b.op === 'outcome' ? (outcome === 'fail' ? Promise.reject(err('x')) : { screen: outcome }) : d('usage', b)) }) });
  await scene(app, { kind: 'html', title: 'Original', uses: ['comp'], html: '<p>v1</p>' }, 'imp');
  await ready(app);
  await app.ev(() => { lastInputAt = Date.now(); });
  await app.ev(() => aiui._event({ type: 'improved', key: 'imp', title: 'Original' }));
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('Original');
  // Idle: it swaps in; the old frame leaves once the new one is ready.
  await app.tick(3000);
  await expect(app.page.locator('#title')).toHaveText('Improved');
  await expect(app.page.locator('#status')).toHaveText('✨ improved — reloaded live, state kept');
  await app.tick(9000);
  await expect(app.page.locator('#view iframe')).toHaveCount(1);
  // An improved applet in the history: replaced there.
  outcome = { kind: 'html', title: 'Improved 2', html: '' };
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'circles', circles: [] }, label: 'x' }; render(); });
  await app.ev(() => aiui._event({ type: 'improved', key: 'imp' }));
  await until(app, () => stack[stack.length - 1].screen.title === 'Improved 2');
  // Unknown keys, empty outcomes and failures: nothing.
  await app.ev(() => aiui._event({ type: 'improved', key: 'none' }));
  outcome = null;
  await app.ev(() => aiui._event({ type: 'improved', key: 'imp' }));
  outcome = 'fail';
  await app.ev(() => aiui._event({ type: 'improved', key: 'imp' }));
  // Merged applets: keys follow.
  await app.ev(() => aiui._event({ type: 'merged', from: 'imp', into: 'imp2' }));
  expect(await app.ev(() => stack[stack.length - 1].key)).toBe('imp2');
  // A component improved: scenes using it reload.
  await app.ev(() => back());
  await ready(app);
  await app.ev(() => { current.screen.uses = ['comp']; });
  await app.ev(() => aiui._event({ type: 'componentImproved', id: 'comp', name: 'Chart' }));
  await app.tick(3000);
  await expect(app.page.locator('#status')).toHaveText('🧩 Chart — improved — reloaded live, state kept');
  await app.ev(() => aiui._event({ type: 'componentImproved', id: 'other', name: 'X', changes: 'y' }));
  // Queued while typing: applied later; queued for a screen left: stored there.
  await app.ev(() => { startWriting('x'); seamlessUpdate(current, { kind: 'html', title: 'Queued', html: '' }, ''); });
  await app.tick(1100);
  await app.ev(() => stopWriting(true));
  await app.tick(3100);
  await until(app, () => current.screen.title === 'Queued' || !seamlessQueue);
  await app.ev(() => { const e = current; seamlessUpdate(e, { kind: 'html', title: 'Stored', html: '' }); });
  await app.ev(() => { const e = { screen: {} }; seamlessUpdate(e, { kind: 'html', title: 'Elsewhere' }); trySeamless(); return e.screen.title; });
});

test('frames: messages from unknown sources are ignored; the lab\'s own messages reach labResult', async ({ app }) => {
  await app.open({ native: true });
  await app.ev(() => window.postMessage({ aiuiHealth: { kind: 'error', detail: 'x' } }, '*'));
  await scene(app, { kind: 'html', title: 'S', html: '' });
  await ready(app);
  await app.ev(() => window.postMessage({ aiuiHealth: { kind: 'error', detail: 'x' } }, '*'));
  await app.settle();
  expect(await app.ev(() => current.screen.health)).toBe(undefined);
  // A message from the scene that the app doesn't know.
  const f = await frame(app);
  await f.evaluate(() => parent.postMessage({ something: 1 }, '*'));
  await f.evaluate(() => parent.postMessage(null, '*'));
  // Context menu from the scene.
  await f.evaluate(() => parent.postMessage({ aiuiContext: { cls: 'text', x: 5, y: 5, text: 'hi' } }, '*'));
  await expect(app.page.locator('#ctx')).toBeVisible();
});
