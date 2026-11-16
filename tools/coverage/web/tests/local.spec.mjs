// The app's own screens (no AI involved): AI provider setup and the AICoin link, the utility
// library, the profile, "is it still you?", network, JS libraries, Settings & System, Actions.
import { test, expect } from '../harness.mjs';
import { routes, labels, until, deferred, err } from './util.mjs';
import { clickCircle, frameWith } from './util.mjs';

const click = clickCircle;
const frame = async (app) => (await app.page.waitForSelector('#view iframe')).contentFrame();

test('web setup: paste a key, it connects; forget it', async ({ app }) => {
  app.ai = () => ({ content: [{ type: 'tool_use', name: 'screen', id: 't', input: { kind: 'circles', circles: [] } }], stop_reason: 'tool_use' });
  await app.open({ storage: { 'aiui.paused': '1' } });
  await expect(app.page.locator('#title')).toHaveText('Connect an AI');
  await expect(app.page.locator('#message')).toHaveText(/^Web version: your API key stays in this browser/);
  expect(await labels(app)).toEqual(['API Key']);
  await click(app, 'API Key');
  await expect(app.page.locator('#title')).toHaveText('Paste an API key');
  await expect(app.page.locator('#message')).toHaveText(/Stored only in this browser\.$/);
  await app.page.keyboard.type('nonsense');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#toast')).toHaveText(/Unrecognised key/);
  await app.ev(() => { el.write.value = 'sk-ant-xyz'; });
  await app.page.click('#go');
  await expect(app.page.locator('#status')).toHaveText('Connected: Anthropic · claude-opus-5-5');
  await expect(app.page.locator('#title')).toHaveText('');
  await app.ev(() => showSetup());
  await expect(app.page.locator('#title')).toHaveText('AI');
  await expect(app.page.locator('#message')).toHaveText(/^Using Anthropic · claude-opus-5-5\. Web version/);
  await expect(app.page.locator('.circle[data-id="use:key"]')).toHaveClass(/selected/);
  await click(app, 'Forget Key');
  await expect(app.page.locator('#title')).toHaveText('Connect an AI');
  await click(app, 'API Key');
  await app.ev(() => { el.write.value = 'sk-1'; submitText(); });
  await expect(app.page.locator('#status')).toHaveText('Connected: OpenAI · gpt-5');
  // Status failing: a toast.
  await app.ev(() => { WebBackend.call = () => Promise.reject(new Error('down')); showSetup(); });
  await expect(app.page.locator('#toast')).toHaveText('down');
});

test('native setup: agent CLIs, AICoin, keys; choosing one; the AICoin wallet link by QR', async ({ app }) => {
  let st = { options: [{ id: 'claude', label: 'Claude Code', kind: 'cli' }, { id: 'aicoin', label: 'AICoin', kind: 'aicoin', balance: 12.7 }, { id: 'k', label: 'OpenAI key', kind: 'key' }], active: null };
  let link = deferred(), aicoin = { linked: false };
  await app.open({ native: true, api: routes({
    engine: (b) => (b.op === 'use' && b.id === 'bad' ? Promise.reject(err('cannot use')) : st),
    aicoin: (b) => (b.op === 'status' ? aicoin : b.op === 'link' ? link.promise : b.op === 'unlink' && aicoin.failUnlink ? Promise.reject(err('unlink failed')) : { ok: true }),
  }) });
  await app.ev(() => showSetup());
  await expect(app.page.locator('#title')).toHaveText('Connect an AI');
  await expect(app.page.locator('#message')).toHaveText(/^No AI command-line tool was found on this Mac/);
  expect(await labels(app)).toEqual(['Claude Code', 'AICoin', 'OpenAI key', 'API Key', 'Link AICoin wallet (scan QR)', 'Forget Key']);
  await expect(app.page.locator('.circle[data-id="aicoin"] .hint')).toHaveText('12 coins');
  await expect(app.page.locator('.circle[data-id="use:claude"] .hint')).toHaveText('agent CLI on this Mac');
  await click(app, 'API Key');
  await expect(app.page.locator('#message')).toHaveText(/iCloud Keychain/);
  await app.ev(() => back());
  await click(app, 'Claude Code');
  await expect(app.page.locator('#status')).toHaveText('Using Claude Code');
  expect(app.sent('engine', 'use')[0].body.id).toBe('claude');
  await app.ev(() => showSetup());
  await click(app, 'AICoin');
  expect(app.sent('engine', 'aicoin').length).toBe(1);
  await app.ev(() => { showSetup(); });
  await until(app, () => current.screen.local === 'setup');
  await app.ev(() => localOpen({ id: 'use:bad', label: 'Bad' }));
  await expect(app.page.locator('#toast')).toHaveText('cannot use');
  // Active, with a balance unknown; linked wallet circles.
  st = { options: [{ id: 'aicoin', label: 'AICoin', kind: 'aicoin' }], active: { id: 'aicoin', label: 'AICoin' } };
  aicoin = { linked: true, spendable: 5.5 };
  await app.ev(() => showSetup());
  await expect(app.page.locator('#message')).toHaveText('Using AICoin. Pick another, or add an API key.');
  await expect(app.page.locator('.circle[data-id="aicoin"] .hint')).toHaveText('free coins to start, no key');
  await expect(app.page.locator('.circle[data-id="aicoinLink"] .hint')).toHaveText('linked · 5 coins to spend');
  // Unlink from the circle.
  await click(app, 'Unlink wallet');
  expect(app.sent('aicoin', 'unlink').length).toBe(1);
  aicoin = { linked: true, spendable: 0, limit: 10, spent: 10, failUnlink: true };
  await app.ev(() => showSetup());
  await expect(app.page.locator('.circle[data-id="aicoinLink"] .hint')).toHaveText('The link limit is reached. Raise it in the AICoin wallet app.');
  await click(app, 'Unlink wallet');
  await expect(app.page.locator('#toast')).toHaveText('unlink failed');
  aicoin = { linked: true, spendable: 0 };
  await app.ev(() => showSetup());
  await expect(app.page.locator('.circle[data-id="aicoinLink"] .hint')).toHaveText(/out of coins/);
  // The QR link dialog.
  await click(app, 'Link AICoin wallet');
  const dlg = app.page.locator('#aicoinlink');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.count')).toHaveText('Preparing the code…');
  link.resolve({ qr: 'data:image/png;base64,AA==', short: 'ab…cd', address: 'abcdef' });
  await expect(dlg.locator('.count')).toHaveText('Waiting for the AICoin wallet app…');
  await expect(dlg.locator('code')).toHaveText('ab…cd');
  // The wallet app confirms (an event from the native side).
  await app.ev(() => aiui._event({ type: 'aicoinLink', state: 'connected', ownerShort: 'ow…ner', owner: 'owner', balance: 42, limit: 50, spent: 3.14159 }));
  await expect(dlg).toHaveClass('connected');
  await expect(dlg.locator('h1')).toHaveText('✓ Linked to your AICoin wallet');
  await expect(dlg.locator('.count')).toHaveText('42 coins to spend');
  await expect(dlg.locator('.limit')).toHaveText('Limit 50 · spent 3.1');
  // Unlinked from the wallet app while the dialog shows "connected": back to the code.
  link = deferred();
  await app.ev(() => aiui._event({ type: 'aicoinLink', state: 'unlinked' }));
  await expect(dlg.locator('.count')).toHaveText('Preparing the code…');
  // Code fails.
  link.reject(err('no network'));
  await expect(dlg.locator('.steps')).toHaveText('Could not show the code.');
  await expect(dlg.locator('.count')).toHaveText('no network');
  await expect(dlg.locator('.again')).toBeVisible();
  // Again; then a timeout from the native side.
  link = deferred();
  await dlg.locator('.again').click();
  await app.ev(() => aiui._event({ type: 'aicoinLink', state: 'timeout' }));
  await expect(dlg.locator('.steps')).toHaveText('Stopped waiting for the wallet app.');
  await expect(dlg.locator('.count')).toHaveText('');
  // Events for a view no longer waiting are ignored.
  await app.ev(() => aiui._event({ type: 'aicoinLink', state: 'failed' }));
  // Esc closes; a link answer arriving after closing cancels it.
  link = deferred();
  await dlg.locator('.again').click();
  await app.page.keyboard.press('a');
  await app.page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(app.sent('aicoin', 'cancel').length).toBeGreaterThan(0);
  const n = app.sent('aicoin', 'cancel').length;
  link.resolve({ qr: 'x', linked: false });
  await expect.poll(() => app.sent('aicoin', 'cancel').length).toBe(n + 1);
  // Already linked when the code comes: connected at once; Done goes home.
  link = deferred();
  await app.ev(() => showAicoinLink());
  link.resolve({ qr: 'x', short: 's', address: 'a', linked: true, spendable: 2, spent: 1 });
  await expect(dlg).toHaveClass('connected');
  await expect(dlg.locator('.limit')).toHaveText('No limit');
  // Unlink in the dialog: failing, then working.
  aicoin.failUnlink = true;
  await dlg.locator('.unlink').click();
  await expect(app.page.locator('#toast')).toHaveText('unlink failed');
  aicoin.failUnlink = false;
  link = deferred();
  await dlg.locator('.unlink').click();
  await expect(dlg.locator('.count')).toHaveText('Preparing the code…');
  link.resolve({ qr: 'x', short: 's', address: 'a', linked: true, ownerShort: null });
  await expect(dlg).toHaveClass('connected');
  await expect(dlg.locator('.limit')).toHaveText('');
  await dlg.locator('.close').click();
  await expect(dlg).toHaveCount(0);
  await expect(app.page.locator('#status')).toHaveText('🪙 AICoin');
  // Connected with no dialog: home; unlinked on the setup screen: refreshed.
  await app.ev(() => aiui._event({ type: 'aicoinLink', state: 'connected' }));
  await app.ev(() => showSetup());
  await until(app, () => current.screen.local === 'setup');
  await app.ev(() => aiui._event({ type: 'aicoinLink', state: 'unlinked' }));
  await expect(app.page.locator('#status')).toHaveText('AICoin wallet: not linked');
  await app.ev(() => { home(); aiui._event({ type: 'aicoinLink', state: 'unlinked' }); aiui._event({ type: 'aicoinLink', state: 'other' }); closeAicoinLink(); });
  // The status call failing: just the link circle.
  app.api = routes({ aicoin: () => Promise.reject(err('x')) });
  expect(await app.ev(() => aicoinLinkCircles())).toEqual([expect.objectContaining({ id: 'aicoinLink', hint: 'not linked · scan with the AICoin wallet app' })]);
});

test('iOS bridge: calls go through the WebKit message handler; errors carry the status', async ({ app }) => {
  await app.open({ native: true, ios: true, api: routes({ engine: { options: [], active: null }, sys: () => Promise.reject(err('denied')), people: () => Promise.reject(err('x', 503)) }) });
  await expect(app.page.locator('html')).toHaveClass(/ios/);
  await expect(app.page.locator('#message')).toHaveText(/^Choose how AI UI reaches AI: AICoin/);
  expect(await app.ev(() => aiui.sys({ op: 'x' }).catch((e) => e.message))).toBe('denied');
  expect(await app.ev(() => callRaw('people', {}).catch((e) => e.message))).toBe('HTTP 503');
  expect(await app.ev(() => IOS_BRIDGE.postMessage({ name: 'x' }).then(() => rawCall('x')))).toEqual({ ok: true });
  // Full screen on iOS stays in the page.
  await app.ev(() => setImmersive(true));
  expect(app.sent('window', 'fullscreen').length).toBe(0);
  await app.ev(() => window.__iosBridge = undefined);
});

test('native transport: HTTP errors, bad JSON and error replies', async ({ app }) => {
  await app.open({ native: true, api: routes({ a: () => ({ __raw: 'not json', status: 200 }), b: () => ({ __raw: '{}', status: 502 }), c: () => Promise.reject(err('bad thing')) }) });
  expect(await app.ev(() => callRaw('a').catch((e) => e.message))).toBe('bad response');
  expect(await app.ev(() => callRaw('b').catch((e) => e.message))).toBe('HTTP 502');
  expect(await app.ev(() => callRaw('c').catch((e) => e.message))).toBe('bad thing');
  // A deadline: the call times out and its channel is cancelled.
  app.api = routes({ suggest: () => new Promise(() => {}), info: () => new Promise(() => {}) });
  const p = app.ev(() => callRaw('suggest', {}).catch((e) => e.message));
  await app.settle();
  await app.tick(25100);
  expect(await p).toBe('timeout');
  await expect.poll(() => app.sent('cancel').some((c) => c.body.suggest)).toBe(true);
  const q = app.ev(() => callRaw('info').catch((e) => e.message));
  await app.settle();
  await app.tick(10100);
  expect(await q).toBe('timeout');
  app.api = routes({ unknownthing: () => new Promise(() => {}) });
  const r = app.ev(() => callRaw('unknownthing').catch((e) => e.message));
  await app.settle();
  await app.tick(30100);
  expect(await r).toBe('timeout');
});

test('utility library: categories, utilities by use, the shared-by-others circle; × removes', async ({ app }) => {
  await app.open({ native: true, api: routes({ utilities: (b) => (b.op === 'tree' ? (b.path && b.path.length
    ? { categories: [], utilities: [{ id: 'u1', name: 'Timer', description: 'counts', uses: 4 }, { id: 'u2', name: 'Clock', icon: '⏰', uses: 1 }], total: 2 }
    : { categories: [{ name: 'Tools', count: 2 }], utilities: [], total: 2 }) : { ok: true }) }) });
  await app.ev(() => showLibrary());
  await expect(app.page.locator('#title')).toHaveText('Utility library');
  await expect(app.page.locator('#message')).toHaveText(/Code the AI wrote once/);
  expect(await labels(app)).toEqual(['Shared by others', 'Tools']);
  await click(app, 'Tools');
  await expect(app.page.locator('#title')).toHaveText('Tools');
  expect(await labels(app)).toEqual(['Timer', 'Clock']);
  await expect(app.page.locator('.circle[data-id="util:u1"] .value')).toHaveText('4');
  app.api = routes({ utilities: () => ({ categories: [], utilities: [], total: 0 }) });
  await app.ev(() => showLibrary());
  await expect(app.page.locator('#message')).toHaveText(/Empty so far/);
  app.api = routes({ utilities: () => Promise.reject(err('lib down')) });
  await app.ev(() => showLibrary());
  await expect(app.page.locator('#toast')).toHaveText('lib down');
});

test('profile: what the app knows, by branch; "is it still you?" and guest mode', async ({ app }) => {
  await app.open({ native: true, api: routes({ profile: (b) => (b.op === 'tree' ? (b.path.length
    ? { branches: [], traits: [{ name: 'Tea', value: 'green', confidence: 0.876, path: ['Food', 'Tea'] }], total: 1 }
    : { branches: [{ name: 'Food', count: 1 }], traits: [], total: 1 }) : { traits: [], baseline: {} }) }) });
  await app.ev(() => aiui.profile());
  await expect(app.page.locator('#title')).toHaveText('About you');
  await click(app, 'Food');
  await expect(app.page.locator('#title')).toHaveText('Food');
  await expect(app.page.locator('.circle[data-id="t:Food/Tea"] .hint')).toHaveText('green');
  await click(app, 'Tea'); // a trait: nothing to open
  await expect(app.page.locator('#title')).toHaveText('Food');
  app.api = routes({ profile: (b) => (b.op === 'tree' ? { branches: [], traits: [], total: 0 } : {}) });
  await app.ev(() => showProfile());
  await expect(app.page.locator('#message')).toHaveText(/Nothing learned yet/);
  app.api = routes({ profile: () => Promise.reject(err('p down')) });
  await app.ev(() => showProfile());
  await expect(app.page.locator('#toast')).toHaveText('p down');
  // Who: suspect, then "It's me"; then "Someone else" (guest).
  await app.ev(() => { who.suspect = ['typing slower than usual']; who.base = { hours: Array(24).fill(0) }; who.session = { typeGap: { n: 3, mean: 1, m2: 0 } }; showWho(); });
  await expect(app.page.locator('#who')).toBeVisible();
  await expect(app.page.locator('#who')).toHaveText('👤?');
  await app.page.click('#who');
  await expect(app.page.locator('#message')).toHaveText('This session looks different from how you usually use AI UI. (typing slower than usual)');
  await click(app, "It's me");
  await expect(app.page.locator('#who')).toBeHidden();
  expect(await app.ev(() => who.base.typeGap.n)).toBe(3);
  await app.ev(() => showWhoScreen());
  await click(app, 'Someone else');
  await expect(app.page.locator('#who')).toHaveText('👤 guest');
  expect(app.sent('reset').length).toBe(1);
  await app.page.click('#who');
  await expect(app.page.locator('#message')).toHaveText('Guest mode: no personal history is used.');
  expect(await labels(app)).toEqual(["It's me"]);
  await click(app, "It's me");
  await app.ev(() => { who.base = null; whoOpen({ id: 'me' }); });
});

test('network: networks with strength and state, join (with a password), rescan, Wi-Fi power', async ({ app }) => {
  let scan = { networks: [{ ssid: 'Home', rssi: -50, band: '5 GHz', secure: true, current: true }, { ssid: 'Cafe', rssi: -60, secure: false },
    { ssid: 'Office', rssi: -70, secure: true, known: true }, { ssid: 'Far', rssi: -90, secure: true }], power: true };
  let connect = { ok: true };
  await app.open({ native: true, api: routes({ network: (b) => (b.op === 'scan' ? (scan instanceof Error ? Promise.reject(scan) : scan) : b.op === 'connect' ? (connect instanceof Error ? Promise.reject(connect) : connect) : b.op === 'power' && b.on ? Promise.reject(err('no power')) : { ok: true }) }) });
  await app.page.keyboard.press('Meta+n'); // native: the Mac menu has ⌘N
  await app.ev(() => aiui.network());
  await expect(app.page.locator('#title')).toHaveText('Network');
  expect(await labels(app)).toEqual(['Home', 'Cafe', 'Office', 'Far', 'Scan again', 'Turn Wi-Fi off']);
  await expect(app.page.locator('.circle[data-id="net:Home"] .hint')).toHaveText('▂▄▆█ · 5 GHz · connected');
  await expect(app.page.locator('.circle[data-id="net:Cafe"] .hint')).toHaveText('▂▄▆ · open');
  await expect(app.page.locator('.circle[data-id="net:Office"] .hint')).toHaveText('▂▄ · saved');
  await expect(app.page.locator('.circle[data-id="net:Far"] .hint')).toHaveText('▂ · secured');
  await click(app, 'Home');
  await expect(app.page.locator('#status')).toHaveText('📶 Home · connected');
  await click(app, 'Cafe');
  await expect.poll(() => app.sent('network', 'connect').length).toBe(1);
  expect(app.sent('network', 'connect')[0].body).toEqual({ op: 'connect', ssid: 'Cafe', password: '' });
  // Secured unknown network: password screen, then join.
  await click(app, 'Far');
  await expect(app.page.locator('#title')).toHaveText('Password for «Far»');
  await app.page.keyboard.type('secret');
  await app.page.keyboard.press('Enter');
  await expect.poll(() => app.sent('network', 'connect').length).toBe(2);
  expect(app.sent('network', 'connect')[1].body.password).toBe('secret');
  await expect(app.page.locator('#title')).toHaveText('Network');
  // A saved one that needs a password after all.
  await expect(app.page.locator('#circles')).not.toHaveClass(/holding/);
  await expect.poll(() => labels(app)).toContain('Office');
  await app.settle(100);
  connect = { ok: false, needsPassword: true };
  await click(app, 'Office');
  await expect(app.page.locator('#title')).toHaveText('Password for «Office»');
  connect = err('wrong password');
  await app.page.keyboard.type('bad');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#toast')).toHaveText('wrong password');
  connect = { ok: false };
  await app.ev(() => joinNetwork('X', 'y'));
  await expect(app.page.locator('#toast')).toHaveText('failed');
  connect = err('join failed');
  await app.ev(() => joinNetwork('X', ''));
  await expect(app.page.locator('#toast')).toHaveText('join failed');
  await app.ev(() => back());
  // Power and rescan.
  await click(app, 'Turn Wi-Fi off');
  await expect.poll(() => app.sent('network', 'power').length).toBe(1);
  scan = { networks: [], power: false, locationAllowed: false };
  await click(app, 'Scan again');
  await expect(app.page.locator('#message')).toHaveText(/macOS shows network names only with Location access/);
  await click(app, 'Turn Wi-Fi on');
  await expect(app.page.locator('#toast')).toHaveText('no power');
  scan = { networks: [] };
  await app.ev(() => showNetwork(true));
  await expect(app.page.locator('#message')).toHaveText('No networks found');
  scan = err('Wi-Fi is off');
  await app.ev(() => showNetwork(true));
  await expect(app.page.locator('#toast')).toHaveText('Wi-Fi is off');
  scan = err('scan failed');
  await app.ev(() => showNetwork(true));
  await expect(app.page.locator('#toast')).toHaveText('scan failed');
  await expect(app.page.locator('#circles')).not.toHaveClass(/holding/);
  // A scan arriving after the user left: stored, not shown.
  const d = deferred();
  app.api = routes({ network: () => d.promise });
  await app.ev(() => { showNetwork(true); home(); });
  d.resolve({ networks: [] });
  await app.settle();
  await expect(app.page.locator('#title')).toHaveText('');
});

test('web: ⌘N, ⌘I and ⌘K open network, activity and actions (no Mac menu)', async ({ app }) => {
  await app.open({ storage: { 'aiui.paused': '1' } });
  await app.page.keyboard.press('Meta+k');
  await expect(app.page.locator('#title')).toHaveText('Actions');
  await app.page.keyboard.press('Meta+k'); // already there
  await app.page.keyboard.press('Meta+i');
  await expect(app.page.locator('#actscreen')).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('#actscreen')).toBeHidden();
  await app.page.keyboard.press('Meta+n');
  await expect(app.page.locator('#toast')).toHaveText(/Not available in the web version|unknown endpoint/);
});

test('JS libraries: installed ones by use; × removes', async ({ app }) => {
  await app.open({ native: true, api: routes({ libraries: (b) => (b.op === 'list' ? { libraries: [{ id: 'd3', installed: true, uses: 3, description: 'charts' }, { id: 'lodash', installed: true }, { id: 'x', installed: false }], used: 2e6, budget: 1e10 } : { ok: true }) }) });
  await app.ev(() => aiui.jsLibraries());
  await expect(app.page.locator('#title')).toHaveText('JS libraries');
  await expect(app.page.locator('#message')).toHaveText('2 / 3 · 2.0 MB / 10.0 GB');
  expect(await labels(app)).toEqual(['d3', 'lodash']);
  app.api = routes({ libraries: () => ({}) });
  await app.ev(() => showJSLibraries());
  await expect(app.page.locator('#message')).toHaveText('0 / 0 · 0 B / 0 B');
  app.api = routes({ libraries: () => Promise.reject(err('libs down')) });
  await app.ev(() => showJSLibraries());
  await expect(app.page.locator('#toast')).toHaveText('libs down');
  expect(await app.ev(() => [fmtBytes(5), fmtBytes(5000), fmtBytes(5e6), fmtBytes(5e9), fmtBytes('x'), fmtSecs(30), fmtSecs(120)])).toEqual(['5 B', '5 KB', '5.0 MB', '5.0 GB', '0 B', '30s', '2m']);
});

test('Settings & System: everything the app knows; settings and actions from the scene', async ({ app }) => {
  const sys = { app: { version: '1.2', build: '7', bundle: 'com.x', platform: 'macOS', language: 'de', generation: 'g1' },
    ai: { active: { label: 'Claude' }, options: [{ label: 'Claude' }, { label: 'Key' }] },
    storage: { icloud: true, root: '/data', freeBytes: 5e9, sharedBudget: 1e10 }, cache: { entries: 3, bytes: 1e6, limitBytes: 6e7 },
    libraries: { installed: 2, catalog: 1100, usedBytes: 1e6, budgetBytes: 1e9, installing: ['d3'] }, utilities: { total: 4, lastReview: 'yesterday' },
    profile: { traits: 5, top: ['likes tea'] }, avoid: { active: ['x.com'], all: 2 },
    hints: { journal: 9, sinceRetro: 2, lastRetro: 'today', summary: 'fine', hints: [{ text: 'h', scope: 'all', evidence: 2 }], recent: [{ kind: 'error', scene: 'S', detail: 'd' }] } };
  await app.open({ native: true, api: routes({
    system: () => sys,
    usage: (b, d) => (b.op === 'list' ? { scenes: [{ title: 'Applet', shot: 'data:image/png;base64,AA', opens: 2, minutes: 3, interactions: 4, improves: 1, nextImprove: Date.now() + 1000 }, { opens: 1 }] } : d('usage', b)),
    native: { policy: { setting: true, allowed: false, reason: 'metered', network: 'wifi' }, tools: [{ id: 'jq', installed: true, installedVersion: '1.7' }, { id: 'rg', installed: false }], used: 1e6, budget: 1e9, path: '/bin' },
    people: { id: 'abcdef0123456789', short: 'abc…789' },
    hints: { ok: true }, cache: { ok: true }, avoid: { ok: true },
  }) });
  await app.ev(() => {
    lastQuality = { title: 'Last', screen: { scores: { ux: 90, readability: 80, accessibility: 70, security: 100 }, issues: ['ux: x'] }, lab: { scores: { ux: 60, readability: 60, accessibility: 60 }, issues: [], corners: [{ case: 'offline', ok: true, note: 'fine' }, { case: 'narrow', ok: false, note: 'cut' }] },
      dod: [{ text: 'A', ok: true, notes: [] }, { text: 'B', ok: false, notes: [] }, { text: 'C', ok: null, notes: [] }, { text: 'D', ok: false, notes: ['n'] }], tests: [{ name: 't1', ok: true, note: 'passed' }, { name: 't2', ok: false, note: 'no' }] };
    who.suspect = ['x'];
    noteTiming('gen', 2000); noteTiming('use', 1000);
  });
  await app.page.keyboard.press('Meta+Shift+D');
  await expect(app.page.locator('#title')).toHaveText('Settings & System');
  const f = await frameWith(app, 'text=Prompt generation');
  const text = await f.textContent('body');
  for (const s of ['1.2 (7)', 'com.x', 'iCloud (synced)', '3', 'd3', 'jq 1.7', 'blocked: metered', 'abc…789', 'yesterday', 'likes tea', 'looks like someone else: x', 'x.com',
    'UX 90 · readability 80 · accessibility 70 · security 100', '✗ narrow — cut', '✓ A', 'not met', 'untested', 'n', '✗ t2', 'Applet', 'opened 2× · 3 min', 'next improvement',
    'error · S: d', 'h — all, ×2', 'generate as soon as a scene renders', 'Download native libraries']) expect(text).toContain(s);
  // Settings change from the scene.
  await f.evaluate(() => { const i = document.querySelector('[data-k="prefetch"]'); i.checked = false; i.dispatchEvent(new Event('change')); });
  await expect.poll(() => app.ev(() => settings.prefetch)).toBe(false);
  await f.evaluate(() => { const i = document.querySelector('[data-k="quickAfter"]'); i.value = '5'; i.dispatchEvent(new Event('change')); });
  await expect.poll(() => app.ev(() => QUICK_AFTER_MS)).toBe(5000);
  await f.evaluate(() => { const i = document.querySelector('input[data-a="budget"]'); i.value = '3'; i.dispatchEvent(new Event('change')); });
  await expect.poll(() => app.sent('window', 'budget').length).toBe(1);
  expect(app.sent('window', 'budget')[0].body.gb).toBe(3);
  await f.evaluate(() => { const i = document.querySelector('input[data-a="nativeDownloads"]'); i.checked = false; i.dispatchEvent(new Event('change')); });
  await expect.poll(() => app.sent('native', 'setting').length).toBe(1);
  for (const a of ['retro', 'librarian', 'clearCache', 'clearAvoid']) await f.evaluate((a) => document.querySelector(`button[data-a="${a}"]`).click(), a);
  await expect.poll(() => app.sent('hints', 'retro').length).toBe(1);
  await expect.poll(() => app.sent('cache', 'clear').length).toBe(1);
  await expect.poll(() => app.sent('avoid', 'clear').length).toBe(1);
  await expect.poll(() => app.sent('utilities', 'review').length).toBe(1);
  await f.evaluate(() => document.querySelector('button[data-a="zoom"][data-arg="1"]').click());
  await expect(app.page.locator('#status')).toHaveText('✓ zoom');
  await f.evaluate(() => { const i = document.querySelector('input[data-a="pause"]'); i.checked = true; i.dispatchEvent(new Event('change')); });
  await expect.poll(() => app.ev(() => paused)).toBe(true);
  await app.ev(() => settingsAction('nothing'));
  await f.evaluate(() => document.querySelector('button[data-a="provider"]').click());
  await expect(app.page.locator('#title')).toHaveText('AI');
  // Minimal data (web-like): the defaults.
  app.api = routes({ system: () => ({}), usage: () => Promise.reject(err('x')), native: () => Promise.reject(err('x')), people: () => Promise.reject(err('x')) });
  await app.ev(() => { lastQuality = { title: '', screen: { scores: { ux: 1 } }, tests: [] }; who.suspect = null; who.guest = true; ctxTiming.gen = []; ctxTiming.use = []; settings.quickAfter = 'x'; settings.qaMin = 'y'; applySettings(); showSystem(); });
  const g = await frameWith(app, 'text=guest mode');
  const t2 = await g.textContent('body');
  for (const s of ['— (—)', 'web', 'none', 'this device only', 'browser storage', 'guest mode', 'generate when the scene is idle', 'not yet']) expect(t2).toContain(s);
  expect(await app.ev(() => [QUICK_AFTER_MS, QA_MIN])).toEqual([2000, 70]);
  await app.ev(() => { lastQuality = null; who.guest = false; showSystem(); });
  const h = await frameWith(app, 'text=no AI scene yet');
  expect(await h.textContent('body')).toContain('normal');
  app.api = routes({ system: () => Promise.reject(err('sys down')) });
  await app.ev(() => aiui.system());
  await expect(app.page.locator('#toast')).toHaveText('sys down');
});

test('Actions (⌘K): instant actions for the scene it was opened from', async ({ app }) => {
  let improve = 0;
  await app.open({ native: true, api: routes({ usage: (b, d) => { if (b.op === 'improve') improve++; if (b.op === 'pause' && b.on === false) return Promise.reject(err('cannot resume')); return d('usage', b); },
    utilities: { categories: [], utilities: [], total: 0 }, libraries: { libraries: [] }, native: { policy: {}, tools: [] } }) });
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'html', title: 'App', fullscreen: true, html: '<p>x</p>' }, label: 'App', key: 'ap' }; render(); });
  await app.ev(() => aiui.actions());
  await expect(app.page.locator('#title')).toHaveText('Actions');
  const l = await labels(app);
  for (const s of ['Improve now', 'Pause improvements', 'Reload scene', 'Find', 'Print', 'Full screen', 'Back to the circles', 'AI UI', 'Network', 'Activity', 'Settings & System', 'JS libraries', 'Native libraries', 'Utility Library', 'What AI UI knows about you', 'AI provider', 'Pause background work', 'Console', 'New session']) expect(l).toContain(s);
  await click(app, 'Improve now');
  await expect(app.page.locator('#title')).toHaveText('App');
  await expect.poll(() => improve).toBe(1);
  await expect(app.page.locator('#status')).toHaveText('↻ Improve now');
  await app.ev(() => aiui.actions());
  await click(app, 'Pause improvements');
  await expect(app.page.locator('#status')).toHaveText('⏸ improvements paused');
  await app.ev(() => aiui.actions());
  await click(app, 'Resume improvements');
  await expect(app.page.locator('#toast')).toHaveText('cannot resume');
  await app.ev(() => aiui.actions());
  await click(app, 'Full screen');
  await expect(app.page.locator('body')).toHaveClass(/immersive/);
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('body')).not.toHaveClass(/immersive/);
  await app.ev(() => aiui.actions());
  await click(app, 'New session');
  await expect(app.page.locator('#status')).toHaveText('✦ New session');
  expect(app.sent('reset').length).toBe(1);
  // Actions on a scene deeper in the history bring it on display first.
  await app.ev(() => { stack = [{ screen: clone(ROOT), label: null }, { screen: { kind: 'html', title: 'Deep', html: '' }, label: 'Deep', key: 'dp' }]; current = { screen: { kind: 'circles', circles: [] }, label: 'Top' }; render(); });
  await app.ev(() => runInstant(INSTANT.find((a) => a.id === 'reloadScene'), instantContext(stack[1])));
  await expect(app.page.locator('#title')).toHaveText('Deep');
  // An action whose condition throws is left out; one gone is ignored.
  await app.ev(() => { registerInstant({ id: 'bad', when: () => { throw new Error('x'); }, label: () => 'Bad', run: () => {} }); registerInstant({ id: 'bad', when: () => false, label: () => 'Bad', run: () => {} }); });
  expect(await app.ev(() => instantFor(instantContext(current)).some((a) => a.id === 'bad'))).toBe(false);
  await app.ev(() => { aiui.actions(); instantOpen({ instant: 'none' }); });
  // Pause/resume all, console, activity, the remaining app screens.
  for (const [label, check] of [['Pause background work', () => paused], ['Resume background work', () => !paused], ['Console', () => !el.console.hidden], ['Activity', () => !el.actscreen.hidden]]) {
    await app.ev(() => { toggleConsole(false); toggleActivityScreen(false); home(); aiui.actions(); });
    await click(app, label);
    await until(app, check);
  }
  for (const [label, t] of [['Network', 'Network'], ['Utility Library', 'Utility library'], ['What AI UI knows about you', 'About you'], ['AI provider', 'AI'], ['JS libraries', 'JS libraries'], ['Native libraries', 'Native libraries']]) {
    await app.ev(() => { toggleActivityScreen(false); home(); aiui.actions(); });
    await click(app, label);
    await expect(app.page.locator('#title')).toHaveText(t);
  }
});
