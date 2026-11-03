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
