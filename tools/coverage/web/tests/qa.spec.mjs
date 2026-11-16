// Scene QA (web/qa.js) on its own: pages with known problems get the expected issues and scores.
// qa.js is loaded by URL into a test page whose `parent` is a stub collecting the reports.
import { test, expect } from '../harness.mjs';

const page = (mode, body, { head = '', parentDoc = true, lab = false } = {}) => `<!doctype html><html><head><meta charset="utf-8">
<script>
  window.__out = [];
  ${parentDoc ? '' : "const realDoc = 0;"}
  window.parent = { postMessage: (m) => window.__out.push(m), get document() { ${parentDoc ? 'return document;' : "throw new Error('cross-origin');"} } };
  ${mode ? `window.__qaMode = '${mode}';` : ''}
  ${lab ? `window.__mockCalls = 0; window.__activity = 0; window.__handlers = {}; window.__realSetTimeout = setTimeout.bind(window);
    addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a) { e.preventDefault(); window.__mockCalls++; } }, true);
    addEventListener('submit', (e) => { e.preventDefault(); window.__mockCalls++; }, true);` : ''}
</script>${head}<script src="/qa.js"></script></head><body>${body}</body></html>`;

const run = async (app, html, { ready = true, wait = 15000 } = {}) => {
  app.files['/qa-test.html'] = html;
  await app.open({ clock: false, storage: { 'aiui.paused': '1' }, url: '/qa-test.html' });
  if (ready) await app.ev(() => postMessage({ aiuiReadySignal: true }, '*'));
  await app.page.waitForFunction(() => window.__out.length > 0, null, { timeout: wait });
  return app.ev(() => window.__out[0]);
};

test('review: a clean page scores well; classes of objects are listed', async ({ app }) => {
  const r = await run(app, page('review', `<h1>Title</h1><p>Some readable text here.</p><a href="https://x.example/">link</a><button>Go</button><img alt="pic" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">
    <table><tr><td>cell text</td></tr></table><pre>code block</pre><ul><li>item one</li></ul><input aria-label="name"><canvas width="10" height="10"></canvas><video width="10" height="10"></video>
    <script>window.__aiuiClassify = (el) => el.tagName === 'H1' ? 'heading' : el.tagName === 'P' ? 'text' : 'empty-space';</script>`));
  expect(r.aiuiReview).toBeTruthy();
  const x = r.aiuiReview;
  expect(x.scores.security).toBe(100);
  expect(x.classes).toEqual(expect.arrayContaining(['heading', 'text', 'empty-space']));
  expect(x.report.readyMs).toBeGreaterThanOrEqual(0);
  expect(x.width).toBeGreaterThan(0);
});

test('review: layout, readability and accessibility problems are found', async ({ app }) => {
  const long = 'word '.repeat(80);
  const r = (await run(app, page('review', `
    <div style="width:3000px">wide content here</div>
    <p style="position:absolute;left:-200px;width:150px">cut at the left edge</p>
    <div style="width:60px;height:14px;overflow:hidden">cropped text that is far too long for its box</div>
    <div style="width:60px;height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">ellipsis is fine here</div>
    <span style="position:absolute;top:300px;left:10px">overlapping one</span><span style="position:absolute;top:300px;left:12px">overlapping two</span>
    <img src="https://broken.invalid/x.png"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="30" height="30">
    <p style="font-size:9px">tiny tiny text</p><p style="width:2000px">${long}</p>
    <p style="color:#777;background:#888">low contrast text</p><p style="color:#eee">light text on white</p>
    <h2 style="font-size:30px;color:#999">big grey heading</h2><b style="font-size:20px;color:#999">bold mid</b>
    <div style="background-image:linear-gradient(red,blue)"><span>over a gradient</span></div>
    <p style="color:rgba(0,0,0,0.3)">faint</p>
    <button></button><a href="#"></a><div role="button" aria-label="named">x</div>
    <input><label>labelled <input></label><input placeholder="p"><input id="li"><label for="li">for li</label><input type="hidden">
    <script>throw new Error('page error'); </script><script>Promise.reject(new Error('rejected'));</script><script>Promise.reject('plain');</script>`))).aiuiReview;
  const issues = r.issues.join('\n');
  for (const s of ['content wider than the screen', 'is cut off at the left edge', 'text is cropped by its box', 'overlaps', 'broken image', 'smaller than 12px', 'lines over ~95 characters',
    'contrast']) expect(issues).toContain(s); // (at most 16 issues are reported; the counts below have the rest)
  expect(r.report).toMatchObject({ noAlt: 2, unnamed: 1, unlabeled: 1 });
  expect(r.report.lowContrast).toBeGreaterThan(2);
  expect(r.scores.accessibility).toBeLessThan(70);
  expect(r.report.errors).toBe(3);
});

test('review: empty pages and pages still loading; the page background from the theme when the parent is closed', async ({ app }) => {
  const r1 = (await run(app, page('review', '', { parentDoc: false }))).aiuiReview;
  expect(r1.issues).toContain('layout: the screen looks empty');
  const r2 = (await run(app, page(null, '<p>Loading…</p>', { parentDoc: false, head: '<style>:root{--bg:#000000}</style>' }))).aiuiReview;
  expect(r2.issues).toContain('layout: still showing only a loading message');
});

test('review: a page with a broken --bg falls back to white; phones count small targets', async ({ app }) => {
  await app.page.setViewportSize({ width: 390, height: 844 });
  const r = (await run(app, page('review', '<p style="color:#fff">white text</p><button style="width:20px;height:20px">b</button><p>see <a href="#x">inline</a> link</p><select style="width:10px"><option>a</option></select>', { parentDoc: false, head: '<style>:root{--bg:nothex}</style>' }))).aiuiReview;
  expect(r.issues.join('\n')).toContain('touch target(s) smaller than 44px on a phone');
  expect(r.issues.join('\n')).toContain('contrast');
});

test('review: runs on its own 4 s after load without ready(); a broken check still reports', async ({ app }) => {
  const r = await run(app, page('review', '<p>No ready call here at all.</p>'), { ready: false });
  expect(r.aiuiReview.scores.ux).toBeLessThanOrEqual(100);
  const r2 = await run(app, page('review', '<p>text</p><script>window.getComputedStyle = () => { throw new Error("broken"); };</script>'));
  expect(r2.aiuiReview.qaError).toMatch(/broken/);
  // A second ready signal does not run it twice.
  await app.ev(() => postMessage({ aiuiReadySignal: true }, '*'));
  await app.page.waitForTimeout(400);
  expect(await app.ev(() => window.__out.length)).toBe(1);
});

test('lab: every control is used; dead, covered and throwing ones are reported; corner cases', async ({ app }) => {
  const r = (await run(app, page('lab', `
    <button id="ok" onclick="document.getElementById('o').textContent += '.'">works</button>
    <button id="dead">does nothing</button>
    <button id="boom" onclick="throw new Error('kaboom')">throws</button>
    <div style="position:relative"><button id="under">under</button><div style="position:absolute;inset:0;background:#fff">cover</div></div>
    <a href="https://x.example/">a link</a>
    <input id="t" aria-label="text"><input type="number" aria-label="n"><input type="date" aria-label="d"><textarea aria-label="ta"></textarea>
    <select aria-label="s"><option>a</option><option>b</option></select><select aria-label="one"><option>x</option></select>
    <input type="checkbox" aria-label="c"><summary>sum</summary><span style="cursor:pointer">pointer span</span>
    <button disabled>off</button><button id="gone" onclick="this.remove(); document.getElementById('dead').remove()">removes</button>
    <form><input id="f" aria-label="f"></form>
    <div id="o"></div>
    <div id="echo"></div>
    <script>
      document.getElementById('t').addEventListener('input', (e) => { document.getElementById('echo').innerHTML = e.target.value; });
      document.getElementById('f').addEventListener('keydown', () => { fetch('/x').catch(() => {}); });
      window.__handlers.back = () => { throw new Error('back broke'); };
      window.__handlers.more = async () => {};
    </script>`, { lab: true })))?.aiuiInteract;
  expect(r).toBeTruthy();
  const issues = r.issues.join('\n');
  for (const s of ['does nothing when used', 'throws: Uncaught Error: kaboom', 'cannot be clicked: covered by', "the scene's back listener throws: back broke", 'rapid double click', 'typed HTML was rendered as markup (injection)'])
    expect(issues).toContain(s);
  expect(r.tested).toBeGreaterThan(5);
  expect(r.corners.find((c) => c.case === 'special text').ok).toBe(false);
  expect(r.scores.security).toBe(40);
  expect(r.listens).toEqual(['back', 'more']);
});

test('lab: keyboard focus, very long input, offline, narrow screens, large text, listeners twice', async ({ app }) => {
  const r = (await run(app, page('lab', `
    <style>button:focus{outline:none} .crop{width:80px;height:18px;overflow:hidden;white-space:nowrap}</style>
    <button tabindex="-1">skipped</button><button>no focus ring</button>
    <input id="long" aria-label="long" style="width:100px"><div id="mirror" style="white-space:nowrap"></div>
    <div style="width:600px">a fixed wide block that does not fit in a narrow screen at all</div>
    <p class="crop">cropped when larger text</p>
    <button id="net">network</button>
    <script>
      document.getElementById('long').addEventListener('input', (e) => { document.getElementById('mirror').textContent = e.target.value; });
      document.getElementById('net').addEventListener('click', () => { fetch('/data').then(() => {}); });
      let n = 0;
      window.__handlers.more = () => { if (++n > 1) throw new Error('twice'); };
      window.__handlers.back = () => {};
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') throw new Error('esc broke'); });
    </script>`, { lab: true }))).aiuiInteract;
  const byCase = Object.fromEntries(r.corners.map((c) => [c.case, c]));
  expect(byCase['keyboard: tab order'].ok).toBe(false);
  expect(byCase['keyboard: visible focus'].ok).toBe(false);
  expect(byCase['keyboard: Enter / Space / Escape'].ok).toBe(false);
  expect(byCase['very long input'].note).toMatch(/content|cut off/);
  expect(byCase['offline'].ok).toBe(false);
  expect(byCase['narrow screen (320px)'].ok).toBe(false);
  expect(byCase['large text (200%)'].ok).toBe(false);
  expect(byCase['more twice'].ok).toBe(false);
  expect(byCase['back twice'].ok).toBe(true);
});

test('lab: a page with nothing to test, and a page that goes blank offline', async ({ app }) => {
  const r = (await run(app, page('lab', '<p>Just text, nothing to click.</p>', { lab: true }))).aiuiInteract;
  expect(r.tested).toBe(0);
  expect(r.corners.map((c) => c.case)).not.toContain('empty input + Enter');
  const r2 = (await run(app, page('lab', '<button id="b">clear</button><script>document.getElementById("b").onclick = () => { document.body.innerHTML = ""; };</script>', { lab: true }))).aiuiInteract;
  expect(r2.corners.find((c) => c.case === 'offline').note).toBe('screen goes blank');
  // Cut off text in a narrow screen; content cut off with very long input.
  const r3 = (await run(app, page('lab', '<p style="white-space:nowrap">a long line of text that does not wrap at all in a narrow screen, really long</p><input aria-label="x" id="i"><p id="m" style="position:fixed;left:0;top:0;white-space:nowrap"></p><script>i.oninput = () => { m.textContent = i.value.slice(0, 400); };</script>', { lab: true }))).aiuiInteract;
  expect(r3.corners.find((c) => c.case === 'narrow screen (320px)').note).toMatch(/reaches/);
  expect(r3.corners.find((c) => c.case === 'very long input').note).toMatch(/cut off$/);
});

test('tests mode: the AI-written tests run with helpers; failures and timeouts are reported', async ({ app }) => {
  const tests = [
    { name: 'clicks and types', code: `await t.click('#b'); t.expect(t.text('#o') === 'clicked', 'not clicked'); await t.type('#i', 'hi'); t.expect(t.text('#i') === 'hi'); await t.key('Enter', '#i'); await t.key('a'); await t.wait(10); t.expect(t.count('p') === 1); t.expect(t.exists('#b')); t.expect(t.text('#none') === '');` },
    { name: 'fails', code: `t.expect(false, 'nope')` },
    { name: 'fails without a message', code: `t.expect(false)` },
    { name: 'missing element', code: `await t.click('#none')` },
    { name: 'missing input', code: `await t.type('#none', 'x')` },
    { name: 'error event', code: `setTimeout(() => { throw new Error('async boom'); }); await t.wait(50);` },
    { name: 'slow', code: `await new Promise(() => {})` },
    { name: 'throws a string', code: `throw 'str'` },
  ];
  const r = (await run(app, page('tests', '<button id="b" onclick="o.textContent=\'clicked\'">b</button><input id="i"><p id="o"></p>', { head: `<script>window.__aiTests = ${JSON.stringify(tests)};</script>` }), { wait: 20000 })).aiuiTests;
  expect(r.results.map((x) => [x.name, x.ok, x.note])).toEqual([
    ['clicks and types', true, 'passed'], ['fails', false, 'nope'], ['fails without a message', false, 'expectation failed'], ['missing element', false, 'no element #none'],
    ['missing input', false, 'no element #none'], ['error event', false, 'Uncaught Error: async boom'], ['slow', false, 'timed out after 3 s'], ['throws a string', false, 'str']]);
});

test('tests mode: no tests; a broken runner still reports', async ({ app }) => {
  const r = (await run(app, page('tests', '<p>x</p>'))).aiuiTests;
  expect(r.results).toEqual([]);
  const r2 = (await run(app, page('tests', '<p>x</p>', { head: '<script>Object.defineProperty(window, "__aiTests", { get() { throw new Error("bad tests"); } });</script>' }))).aiuiTests;
  expect(r2.results).toEqual([{ name: 'tests', ok: false, note: 'Error: bad tests' }]);
});
