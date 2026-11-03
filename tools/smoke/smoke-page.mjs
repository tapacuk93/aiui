// Smoke test: drives the page through every AI-turn path with a stubbed backend; reports errors.
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = list.find(t => t.id === process.argv[2]);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const send = (method, params = {}) => new Promise(res => { const my = ++id; ws.addEventListener('message', function h(m) { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener('message', h); res(d.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
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
  const step = async (name, f) => { try { await f(); steps.push(name + ': ok'); } catch (e) { steps.push(name + ': ' + e.message); } await new Promise(r => setTimeout(r, 300)); };
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
  await step('app interactions: arrows, Space select, + / × ears, Enter opens', async () => {
    home();
    current = { screen: normalize({ kind: 'circles', circles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] }), label: null };
    render(); await new Promise(r => setTimeout(r, 200));
    const key = (k) => onKey(new KeyboardEvent('keydown', { key: k, cancelable: true }));
    key('ArrowRight'); const f1 = focusedId();
    key(' '); const sel = current.screen.circles.find((c) => c.id === f1).selected;
    const nodeC = [...el.circles.children].find((n) => n.dataset.id === 'c');
    nodeC.querySelector('.plus').click(); const cSel = current.screen.circles.find((c) => c.id === 'c').selected;
    const nodeA = [...el.circles.children].find((n) => n.dataset.id === 'a');
    nodeA.querySelector('.minus').click(); await new Promise(r => setTimeout(r, 400));
    const aGone = current.screen.circles.find((c) => c.id === 'a').removed;
    let opened = null; const realOpen = openCircle; openCircle = (c) => { opened = c.id; };
    key('Enter'); openCircle = realOpen;
    if (f1 !== 'b' || !sel || !cSel || !aGone || !opened) throw new Error(JSON.stringify({ f1, sel, cSel, aGone, opened }));
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
