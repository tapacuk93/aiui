// Smoke test: drives the page through every AI-turn path with a stubbed backend; reports errors.
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = list.find(t => t.id === process.argv[2]);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const send = (method, params = {}) => new Promise(res => { const my = ++id; ws.addEventListener('message', function h(m) { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener('message', h); res(d.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
// The test tab is never visible; without this Chromium throttles its timers heavily after
// 5 minutes in the background (wake-ups batched to ~1/min), which breaks timing-based steps.
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.setWebLifecycleState', { state: 'active' });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? 'EXCEPTION: ' + r.exceptionDetails.exception.description : r.result.value; };
const result = await ev(`(async () => {
  const errors = [];
  addEventListener('error', (e) => errors.push(e.message));
  const toasts = [];
  const realToast = toast; toast = (m) => { toasts.push(m); };
  const screens = {
    circles: { kind: 'circles', title: 'T', go: 'Go', more: true, focus: 'b', live: true,
      circles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', hint: 'h' }] },
    html: { kind: 'html', title: 'H', fullscreen: true, uses: ['x'], html: '<p>hi</p>' },
    text: { kind: 'text', title: 'W', text: 'draft' },
  };
  let n = 0;
  WebBackend.call = async (name, body) => {
    if (name === 'ai') { const k = ['circles', 'html', 'text'][n++ % 3]; return { screen: JSON.parse(JSON.stringify(screens[k])), published: k === 'html' ? 1 : 0, cached: k === 'text' }; }
    if (name === 'more') return { circles: [{ id: 'c', label: 'C' }], more: false };
    if (name === 'refine') return { circles: [{ id: 'a', value: 3 }] };
    if (name === 'suggest') return { circles: [{ id: 's', label: 'S' }] };
    if (name === 'utilities') return body.op === 'bundle' ? { js: 'lib.x = 1;', css: '', ids: ['x'] } : { categories: [], utilities: [], total: 0 };
    if (name === 'engine') return { options: [{ id: 'key', label: 'K', kind: 'key' }], active: { id: 'key', label: 'K' } };
    if (name === 'profile') return body.op === 'tree' ? { branches: [], traits: [], total: 0 } : { traits: [], baseline: {} };
    if (name === 'cache') return { label: null, results: [] };
    return { ok: true };
  };
  const steps = [];
  // Each step has 40 s: a hanging step fails visibly instead of blocking the run.
  const step = async (name, f) => {
    try { await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out (40 s)')), 40000))]); steps.push(name + ': ok'); }
    catch (e) { steps.push(name + ': ' + e.message); }
    await new Promise(r => setTimeout(r, 300));
  };
  await step('open circle -> circles', () => ask({ event: 'open', target: { label: 'X' } }, { label: 'X' }));
  await step('more page', () => nextPage());
  await step('go -> html (uses, fullscreen, published)', () => ask({ event: 'go' }, { label: 'Go' }));
  await step('fullscreen on/off', () => { setImmersive(true); setImmersive(false); });
  await step('text -> text screen (cached)', () => ask({ event: 'text', text: 'hi' }, { label: 'hi' }));
  await step('typing + suggest', async () => { back(); back(); startWriting('ab'); onInput(); await suggestFor('ab'); stopWriting(true); });
  await step('typed circle shows loading like any circle', async () => {
    const realCall = WebBackend.call;
    WebBackend.call = async (name, body) => name === 'ai' ? (await new Promise(r => setTimeout(r, 600)), { screen: { kind: 'circles', title: 'R', circles: [] } }) : realCall(name, body);
    home(); startWriting('hello'); onInput();
    const n = [...el.circles.children].find((x) => x.dataset.id === '__typed');
    const done = openCircle({ id: '__typed', typed: true, label: 'hello' }, n);
    await new Promise(r => setTimeout(r, 150));
    const pending = n.classList.contains('pending') && !!n.querySelector('.progress');
    await done;
    WebBackend.call = realCall;
    if (!pending) throw new Error('typed circle not pending');
  });
  await step('library screen', () => showLibrary([]));
  await step('profile screen', () => showProfile([]));
  await step('setup screen', () => showSetup());
  await step('who screen', () => showWhoScreen());
  await step('home', () => home());
  await step('slow answer: interim screen, then replaced in place', async () => {
    QUICK_AFTER_MS = 200;
    const realCall = WebBackend.call;
    WebBackend.call = async (name, body) => {
      if (name === 'ai') { await new Promise(r => setTimeout(r, 900)); return { screen: { kind: 'circles', title: 'Full', circles: [{ id: 'f', label: 'F' }] } }; }
      if (name === 'quick') return { kind: 'circles', title: 'Quick', circles: [{ id: 'q', label: 'Q' }] };
      return realCall(name, body);
    };
    const done = ask({ event: 'open', target: { label: 'Slow' } }, { label: 'Slow' });
    await new Promise(r => setTimeout(r, 500));
    const mid = aiui.screen.title + (document.body.classList.contains('updating') ? '+updating' : '');
    await done;
    const end = aiui.screen.title + (document.body.classList.contains('updating') ? '+updating' : '');
    WebBackend.call = realCall; QUICK_AFTER_MS = 6000;
    if (mid !== 'Quick+updating' || end !== 'Full') throw new Error('interim ' + mid + ' → ' + end);
  });
  const slowFull = async (screenTimeouts, expectToast) => {
    const realCall = WebBackend.call;
    let quickCalled = false;
    WebBackend.call = async (name, body) => {
      if (name === 'ai') { await new Promise(r => setTimeout(r, 900)); return { screen: { kind: 'circles', title: 'Full', circles: [{ id: 'f', label: 'F' }] } }; }
      if (name === 'quick') { quickCalled = true; return { kind: 'circles', title: 'Quick', circles: [] }; }
      return realCall(name, body);
    };
    home();
    current.screen.timeouts = screenTimeouts;
    const before = toasts.length;
    await ask({ event: 'open', target: { label: 'X' } }, { label: 'X' });
    await new Promise(r => setTimeout(r, 1200));
    WebBackend.call = realCall;
    const newToasts = toasts.slice(before);
    toasts.length = before; // expected toasts are not failures
    return { title: aiui.screen.title, quickCalled, toast: newToasts.join(' ') };
  };
  await step('stuck view: failed image, no ready -> self-fix replaces it', async () => {
    const realCall = WebBackend.call;
    let fixEvent = null;
    WebBackend.call = async (name, body) => {
      if (name === 'ai' && body.event === 'fix') { fixEvent = body; return { screen: { kind: 'circles', title: 'Fixed', circles: [{ id: 'z', label: 'Z' }] } }; }
      if (name === 'ai') return { screen: { kind: 'html', title: 'Gallery', timeouts: { render: { seconds: 4, then: 'interim' } },
        html: '<p>Loading…</p><script>const i = new Image(); i.src = "https://invalid.invalid/x.jpg";<\/script>' } };
      return realCall(name, body);
    };
    home();
    await ask({ event: 'open', target: { label: 'Gallery' } }, { label: 'Gallery' });
    await new Promise(r => setTimeout(r, 5500));
    WebBackend.call = realCall;
    const reported = fixEvent && fixEvent.problem.errors.some((e) => e.includes('invalid.invalid'));
    if (!fixEvent || !reported || aiui.screen.title !== 'Fixed') throw new Error(JSON.stringify({ fix: fixEvent && fixEvent.problem, now: aiui.screen.title }));
  });
  await step('ready but images failing -> self-fix anyway; failures recorded to avoid', async () => {
    const realCall = WebBackend.call;
    let fixEvent = null;
    const recorded = [];
    WebBackend.call = async (name, body) => {
      if (name === 'avoid') { recorded.push(...(body.items || [])); return { ok: true }; }
      if (name === 'ai' && body.event === 'fix') { fixEvent = body; return { screen: { kind: 'circles', title: 'Fixed2', circles: [] } }; }
      if (name === 'ai') return { screen: { kind: 'html', title: 'Gallery2',
        html: '<script>aiui.ready(); for (let k = 0; k < 3; k++) { const i = new Image(); i.src = "https://blocked.invalid/" + k + ".jpg"; }<\/script>' } };
      return realCall(name, body);
    };
    home();
    await ask({ event: 'open', target: { label: 'Gallery2' } }, { label: 'Gallery2' });
    await new Promise(r => setTimeout(r, 3500));
    WebBackend.call = realCall;
    if (!fixEvent || aiui.screen.title !== 'Fixed2' || !recorded.some((r) => r.url.includes('blocked.invalid')))
      throw new Error(JSON.stringify({ fixed: !!fixEvent, now: aiui.screen.title, recorded }));
  });
  const reviewRun = async (html, extraWait = 0) => {
    const realCall = WebBackend.call;
    let fixEvent = null;
    WebBackend.call = async (name, body) => {
      if (name === 'ai' && body.event === 'fix') { fixEvent = body; return { screen: { kind: 'circles', title: 'Reviewed', circles: [] } }; }
      if (name === 'ai') return { screen: { kind: 'html', title: 'V', html } };
      return realCall(name, body);
    };
    home();
    await ask({ event: 'open', target: { label: 'V' } }, { label: 'V' });
    await new Promise(r => setTimeout(r, 2500));
    const hidden = !!document.querySelector('#view iframe.testing');
    await new Promise(r => setTimeout(r, extraWait));
    WebBackend.call = realCall;
    return { fixEvent, title: aiui.screen.title, hidden };
  };
  await step('ui test: overlapping text is caught and repaired', async () => {
    const r = await reviewRun('<div style="position:relative;height:200px"><p style="position:absolute;top:0;font-size:30px">Overlapping title text</p><p style="position:absolute;top:6px;font-size:30px">Another heading here</p></div><script>aiui.ready()<\/script>');
    const issues = r.fixEvent ? r.fixEvent.problem.errors.join(' ') : '';
    if (!issues.includes('overlaps') || r.title !== 'Reviewed') throw new Error(JSON.stringify({ issues, title: r.title }));
  });
  await step('ui test: clean view is revealed as is (no reload, no repair)', async () => {
    const r = await reviewRun('<section style="padding:20px"><h1>Hello</h1><p>All good here.</p></section><script>aiui.ready()<\/script>');
    if (r.fixEvent || r.title !== 'V' || r.hidden) throw new Error(JSON.stringify({ fixed: !!r.fixEvent, title: r.title, hidden: r.hidden }));
  });
  await step('interaction lab: a dead button is caught and repaired', async () => {
    const r = await reviewRun('<section style="padding:20px"><h1>Panel</h1><button id="dead">Start</button></section><script>aiui.ready()<\\/script>', 10000);
    const issues = r.fixEvent ? r.fixEvent.problem.errors.join(' ') + ' ' + r.fixEvent.problem.reason : '';
    if (!/does nothing/.test(issues) || r.title !== 'Reviewed') throw new Error(issues || 'no interaction issue');
  });
  await step('corner cases: HTML injection through an input is caught', async () => {
    const r = await reviewRun('<section style="padding:20px"><label>Name <input id="n"></label><div id="out"></div></section><script>document.getElementById("n").addEventListener("input", (e) => { document.getElementById("out").innerHTML = e.target.value; }); aiui.ready()<\\/script>', 12000);
    const all = r.fixEvent ? r.fixEvent.problem.errors.join(' ') + ' ' + r.fixEvent.problem.reason : '';
    if (!/injection/.test(all)) throw new Error(all.slice(0, 400) || 'no fix requested');
  });
  await step('DoD: the AI writes it, tests check it, an unmet criterion is repaired and journalled', async () => {
    const journalled = [];
    const realCall = WebBackend.call;
    let fixEvent = null;
    WebBackend.call = async (name, body) => {
      if (name === 'tests') return { dod: ['Pressing Add one increases the counter by exactly one'], tests: [{ criterion: 0, name: 'counter increments', code: 'await t.click("#inc"); t.expect(t.text("#n") === "1", "counter should be 1 after one click, is " + t.text("#n"));' }] };
      if (name === 'journal') { journalled.push(body); return { ok: true }; }
      if (name === 'ai' && body.event === 'fix') { fixEvent = body; return { screen: { kind: 'circles', title: 'TestsFixed', circles: [] } }; }
      if (name === 'ai') return { screen: { kind: 'html', title: 'Counter', html: '<section style="padding:20px"><p id="n" aria-live="polite">0</p><button id="inc" style="min-width:48px;min-height:48px">Add one</button></section><script>let n = 0; document.getElementById("inc").onclick = () => { n += 2; document.getElementById("n").textContent = n; }; aiui.ready()<\\/script>' } };
      return realCall(name, body);
    };
    home();
    await ask({ event: 'open', target: { label: 'Counter' } }, { label: 'Counter' });
    await new Promise(r => setTimeout(r, 16000));
    WebBackend.call = realCall;
    const why = fixEvent ? fixEvent.problem.reason + ' ' + fixEvent.problem.errors.join(' ') : '';
    if (!/Definition of Done/.test(why) || !/increases the counter/.test(why) || !journalled.some((j) => j.kind === 'dod'))
      throw new Error(why.slice(0, 300) || 'no fix');
  });
  await step('context menus: per-class actions, disabled class, AI action', async () => {
    const realCall = WebBackend.call;
    let ctxEvent = null;
    WebBackend.call = async (name, body) => {
      if (name === 'menus') return { classes: [
        { class: 'circle', enabled: true, actions: [{ id: 'explain', label: 'Explain', icon: '💡', kind: 'ai', prompt: 'explain it' }, { id: 'cp', label: 'Copy', icon: '⧉', kind: 'copy' }] },
        { class: 'empty-space', enabled: false } ] };
      if (name === 'ai' && body.event === 'context') { ctxEvent = body; return { screen: { kind: 'circles', title: 'Ctx', circles: [] } }; }
      return realCall(name, body);
    };
    home();
    current = { screen: normalize({ kind: 'circles', circles: [{ id: 'a', label: 'Alpha' }] }), label: null };
    render(); await new Promise(r => setTimeout(r, 200));
    const n = [...el.circles.children].find((x) => x.dataset.id === 'a');
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    await new Promise(r => setTimeout(r, 300));
    const items = [...el.ctx.querySelectorAll('button')].map((b) => b.textContent);
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    await new Promise(r => setTimeout(r, 200));
    const emptyHidden = el.ctx.hidden;
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    await new Promise(r => setTimeout(r, 100));
    el.ctx.querySelector('button').click();
    await new Promise(r => setTimeout(r, 300));
    WebBackend.call = realCall;
    if (items.length !== 2 || !emptyHidden || !ctxEvent || ctxEvent.object.label !== 'Alpha' || ctxEvent.class !== 'circle')
      throw new Error(JSON.stringify({ items, emptyHidden, ctx: ctxEvent && { cls: ctxEvent.class, obj: ctxEvent.object } }));
  });
  await step('hotkeys: zoom, back + forward, Home/End', async () => {
    const key = (k, o = {}) => onKey(new KeyboardEvent('keydown', { key: k, cancelable: true, ...o }));
    key('=', { metaKey: true }); const zIn = zoomLevel; key('0', { metaKey: true }); const z0 = zoomLevel;
    home();
    current = { screen: normalize({ kind: 'circles', title: 'P1', circles: Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, label: 'X' + i })) }), label: 'P1' };
    stack = [{ screen: JSON.parse(JSON.stringify(ROOT)), label: null }];
    render(); await new Promise(r => setTimeout(r, 300));
    key('End'); const endPage = current.screen.page; key('Home'); const homePage = current.screen.page;
    back(); await new Promise(r => setTimeout(r, 200)); const afterBack = current.label;
    key(']', { metaKey: true }); await new Promise(r => setTimeout(r, 200)); const afterFwd = current.label;
    if (!(zIn > 1) || z0 !== 1 || !(endPage > 0) || homePage !== 0 || afterBack !== null || afterFwd !== 'P1')
      throw new Error(JSON.stringify({ zIn, z0, endPage, homePage, afterBack, afterFwd }));
  });
  await step('status bar: titled activity, summary, pause, settings, address goTo', async () => {
    const realCall = WebBackend.call;
    WebBackend.call = async (name, body) => name === 'ai' ? (await new Promise(r => setTimeout(r, 500)), { screen: { kind: 'circles', title: 'Deep', circles: [{ id: 'd', label: 'D' }] } }) : realCall(name, body);
    home();
    const p = ask({ event: 'open', target: { label: 'Games' } }, { label: 'Games' });
    await new Promise(r => setTimeout(r, 150));
    const during = el.activity.textContent;
    await p; await new Promise(r => setTimeout(r, 100));
    const after = el.activity.textContent;
    setPaused(true); let prefetchCalls = 0;
    const rc = WebBackend.call; WebBackend.call = async (n, b) => { if (n === 'prefetch') prefetchCalls++; return rc(n, b); };
    prefetchCircle('d');
    setPaused(false); WebBackend.call = realCall;
    await showSystem(); await new Promise(r => setTimeout(r, 600));
    const hasSettings = /data-k="prefetch"/.test(aiui.screen.html || '');
    setSetting('quickAfter', 9); const q = QUICK_AFTER_MS; setSetting('quickAfter', 6);
    goTo(0); const atRoot = !stack.length;
    if (!/opening «Games»/.test(during) || !/ready/.test(after) || prefetchCalls || !hasSettings || q !== 9000 || !atRoot)
      throw new Error(JSON.stringify({ during, after, prefetchCalls, hasSettings, q, atRoot }));
  });
  await step('live improvement: an improved scene reloads in place and keeps its state', async () => {
    const realCall = WebBackend.call;
    const seen = [];
    const h = (e) => { if (e.data && e.data.stateSeen != null) seen.push(e.data.stateSeen); };
    addEventListener('message', h);
    WebBackend.call = async (name, body) => {
      if (name === 'ai') return { key: 'k-live', screen: { kind: 'html', title: 'Clicker', html: '<p>v1</p><script>(async () => { await aiui.state.save({ n: 5 }); parent.postMessage({ stateSeen: "v1" }, "*"); aiui.ready(); })()<\\/script>' } };
      if (name === 'usage' && body.op === 'outcome') return { screen: { kind: 'html', title: 'Clicker', html: '<p>v2</p><script>(async () => { const s = await aiui.state.load(); parent.postMessage({ stateSeen: "v2:" + (s && s.n) }, "*"); aiui.ready(); })()<\\/script>' } };
      return realCall(name, body);
    };
    home();
    await ask({ event: 'open', target: { label: 'Clicker' } }, { label: 'Clicker' });
    await new Promise(r => setTimeout(r, 1500));
    await onImproved({ key: 'k-live' });
    await new Promise(r => setTimeout(r, 1500));
    WebBackend.call = realCall; removeEventListener('message', h);
    if (!seen.includes('v1') || !seen.includes('v2:5') || current.key !== 'k-live') throw new Error(JSON.stringify({ seen, key: current.key }));
  });
  const sceneRun = async (html) => {
    const realCall = WebBackend.call;
    WebBackend.call = async (name, body) => name === 'ai' ? { screen: { kind: 'html', title: 'Scene', html } } : realCall(name, body);
    home();
    await ask({ event: 'open', target: { label: 'Scene' } }, { label: 'Scene' });
    await new Promise(r => setTimeout(r, 1200));
    WebBackend.call = realCall;
  };
  await step('scene Back listener handles Back (stays), then passes it on', async () => {
    await sceneRun('<p id="p">detail open</p><script>let open = true; aiui.onBack(() => { if (open) { open = false; document.getElementById("p").textContent = "closed"; return true; } return false; }); aiui.ready()<\\/script>');
    back(); await new Promise(r => setTimeout(r, 400));
    const stayed = aiui.screen.title === 'Scene';
    back(); await new Promise(r => setTimeout(r, 400));
    if (!stayed || aiui.screen.title === 'Scene') throw new Error('stayed=' + stayed + ' now=' + aiui.screen.title);
  });
  await step('scene More listener shows More and is invoked', async () => {
    await sceneRun('<p id="n">0</p><script>aiui.onMore(() => { document.getElementById("n").textContent = "1"; window.parent.postMessage({ moreHit: 1 }, "*"); }); aiui.ready()<\\/script>');
    let hit = false; const h = (e) => { if (e.data && e.data.moreHit) hit = true; }; addEventListener('message', h);
    const shown = el.more.classList.contains('on');
    nextPage(); await new Promise(r => setTimeout(r, 400));
    removeEventListener('message', h);
    if (!shown || !hit) throw new Error('shown=' + shown + ' hit=' + hit);
  });
  await step('long press on Back returns to the circles', async () => {
    await sceneRun('<p>app</p><script>aiui.onBack(() => true); aiui.ready()<\\/script>');
    el.prev.dispatchEvent(new PointerEvent('pointerdown'));
    await new Promise(r => setTimeout(r, 700));
    el.prev.dispatchEvent(new PointerEvent('pointerup'));
    if (current.screen.kind !== 'circles') throw new Error('still on ' + current.screen.kind);
  });
  await step('app interactions: arrows, Space select, no ears, Enter opens, locked while generating', async () => {
    home();
    current = { screen: normalize({ kind: 'circles', circles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] }), label: null };
    render(); await new Promise(r => setTimeout(r, 200));
    const key = (k) => onKey(new KeyboardEvent('keydown', { key: k, cancelable: true }));
    key('ArrowRight'); const f1 = focusedId();
    key(' '); const sel = current.screen.circles.find((c) => c.id === f1).selected;
    const cSel = !document.querySelector('.circle .ear');           // the ears are gone
    const nodeC = [...el.circles.children].find((n) => n.dataset.id === 'c');
    nodeC.querySelector('.face').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const aGone = current.screen.circles.find((c) => c.id === 'c').selected; // Shift-click selects
    let opened = null; const realOpen = openCircle; openCircle = (c) => { opened = c.id; };
    key('Enter'); openCircle = realOpen;
    // Locked while generating: another circle can't be opened; the generating one cancels.
    const realCall = WebBackend.call;
    WebBackend.call = async (n, b) => n === 'ai' ? new Promise(() => {}) : realCall(n, b);
    const nodeA = [...el.circles.children].find((n) => n.dataset.id === 'a');
    openCircle(current.screen.circles[0], nodeA);
    await new Promise(r => setTimeout(r, 100));
    let other = null; const ro = openCircle; openCircle = (c) => { other = c.id; };
    nodeC.querySelector('.face').click(); openCircle = ro;
    const lockedOk = other === null && busy;
    nodeA.querySelector('.face').click(); await new Promise(r => setTimeout(r, 100));
    const cancelled = !busy;
    WebBackend.call = realCall;
    if (f1 !== 'b' || !sel || !cSel || !aGone || !opened || !lockedOk || !cancelled)
      throw new Error(JSON.stringify({ f1, sel, noEars: cSel, shiftSel: aGone, opened, lockedOk, cancelled }));
  });
  await step('policy wait: no interim, full screen arrives', async () => {
    const r = await slowFull({ open: { seconds: 0.3, then: 'wait', label: 'searching' } });
    if (r.quickCalled || r.title !== 'Full') throw new Error(JSON.stringify(r));
  });
  await step('policy cancel: stops and says why', async () => {
    const r = await slowFull({ open: { seconds: 0.3, then: 'cancel', label: 'searching mail' } });
    if (r.quickCalled || r.title === 'Full' || !r.toast.includes('searching mail')) throw new Error(JSON.stringify(r));
  });
  toast = realToast;
  return { steps, toasts, errors };
})()`);
console.log(result);
const failed = typeof result === 'string' || result.errors.length || result.toasts.length ||
  result.steps.some((x) => !x.endsWith(': ok'));
process.exit(failed ? 1 : 0);
