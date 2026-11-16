// Shared code and people (web/shared.js): "Shared by others", adopting with review, sharing
// globally, module cards, People (profile, find, add, contacts), events, and the share offer.
import { test, expect } from '../harness.mjs';
import { routes, labels, until, deferred, err, clickCircle as click, frameWith } from './util.mjs';

const frame = async (app) => (await app.page.waitForSelector('#view iframe', { state: 'attached' })).contentFrame();
const ready = async (app) => { const f = await frame(app); await f.waitForFunction(() => window.aiui && document.readyState === 'complete'); return f; };
const ID = 'a'.repeat(64);
// Clicks inside a scene (DOM click: the scene's own layout doesn't matter here).
const fclick = (f, sel) => f.$eval(sel, (n) => n.click()).catch((e) => { if (!/detached|destroyed/.test(e.message)) throw e; });
const item = (x = {}) => ({ id: 'it1', name: 'chart', title: 'Chart', kind: 'component', version: 3, adoptions: 5, path: ['viz'], description: 'draws charts', author: ID, ...x });

test('Shared by others: the index, kinds, items; sync; search; updates; mine', async ({ app }) => {
  let list = { status: { count: 3, syncedAt: new Date(Date.now() - 30000).toISOString(), kinds: { component: 2, applet: 1 }, updates: ['x'], mine: 1 },
    items: [item(), item({ id: 'it2', title: '', name: 'util2', kind: 'util', updateAvailable: true, version: 4 }), item({ id: 'it3', kind: 'applet', adoptedVersion: 2, adoptions: 0 }), item({ id: 'it4', mine: true, path: undefined })] };
  let sync = { ok: true };
  await app.open({ native: true, api: routes({ shared: (b) => {
    if (b.op === 'list') return b.kind ? { items: [item({ id: 'k1', title: 'Kinded' })] } : list;
    if (b.op === 'sync') return sync instanceof Error ? Promise.reject(sync) : sync;
    if (b.op === 'search') return b.q === 'fail' ? Promise.reject(err('search down')) : { items: b.q === 'none' ? [] : [item({ title: 'Found' })] };
    if (b.op === 'updates') return { items: [item({ title: 'Updated', updateAvailable: true })] };
    if (b.op === 'mine') return {};
    if (b.op === 'item') return { item: item() };
    if (b.op === 'shareable') return {};
    return { ok: true };
  } }) });
  await app.ev(() => aiui.sharedByOthers());
  await expect(app.page.locator('#title')).toHaveText('Shared by others');
  await expect(app.page.locator('#message')).toHaveText(/^Global — shared by other AI UI users/);
  expect(await labels(app)).toEqual(['Sync now', 'Search', 'Updates', 'Share globally…', 'Shared by me', 'Components', 'Applets', 'Chart', 'util2', 'Chart', 'Chart']);
  await expect(app.page.locator('.circle[data-id="sh:sync"]')).toHaveAttribute('title', 'updated 30 s');
  await expect(app.page.locator('.circle[data-id="item:it2"] .hint')).toHaveText('utility · v4 · 5 ↓ · update v4');
  await expect(app.page.locator('.circle[data-id="item:it3"] .hint')).toHaveText('applet · v3 · 0 ↓ · adopted');
  await expect(app.page.locator('.circle[data-id="item:it4"] .hint')).toHaveText('component · v3 · 5 ↓ · yours');
  expect(await app.page.getAttribute('.circle[data-id="item:it1"]', 'title')).toBe('global · viz › chart — draws charts');
  // Kinds, updates, mine.
  await click(app, 'Components');
  await expect(app.page.locator('#title')).toHaveText('Components');
  expect(await labels(app)).toEqual(['Kinded']);
  await app.ev(() => back());
  await click(app, 'Updates');
  await expect(app.page.locator('#title')).toHaveText('Updates for what you adopted');
  expect(await labels(app)).toEqual(['Updated']);
  await app.ev(() => back());
  await click(app, 'Shared by me');
  await expect(app.page.locator('#title')).toHaveText('Shared by me');
  await expect(app.page.locator('#message')).toHaveText('Nothing found.');
  await app.ev(() => back());
  // Search: a text screen; results; nothing; failing.
  await click(app, 'Search');
  await expect(app.page.locator('#title')).toHaveText('Search');
  await app.page.keyboard.type('charts');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('Search: charts');
  expect(await labels(app)).toEqual(['Found']);
  await app.ev(() => back());
  await app.ev(() => searchShared('fail'));
  await expect(app.page.locator('#toast')).toHaveText('search down');
  await app.ev(() => searchShared('none'));
  await expect(app.page.locator('#message')).toHaveText('Nothing found.');
  await app.ev(() => back());
  // Sync: flash, then refreshed in place; sync failing toasts.
  list.status.syncedAt = new Date(Date.now() - 7200000).toISOString();
  await click(app, 'Sync now');
  await expect(app.page.locator('.circle[data-id="sh:sync"]')).toHaveAttribute('title', 'updated 2 h');
  sync = err('sync down');
  await click(app, 'Sync now');
  await expect(app.page.locator('#toast')).toHaveText('sync down');
  // Synced event: refreshes the screen in place, notes updates.
  list = { status: { count: 0, syncedAt: new Date(Date.now() - 3 * 86400000).toISOString() }, items: [] };
  await app.ev(() => aiui._event({ type: 'shared', what: 'synced', count: 0, updates: 2 }));
  await expect(app.page.locator('#message')).toHaveText(/^Nobody has shared anything yet\./);
  await expect(app.page.locator('.circle[data-id="sh:sync"]')).toHaveAttribute('title', 'updated 3 d');
  await app.ev(() => { aiui._event({ type: 'shared', what: 'synced', count: 1, added: 1, removed: 2 }); aiui._event({ type: 'shared', what: 'other' }); });
  // Refresh in place while the shared screen is back in the history; not shown anywhere: nothing.
  await app.ev(() => push({ kind: 'circles', local: 'x', circles: [] }, 'X'));
  await app.ev(() => showShared(true));
  await app.ev(() => { home(); return showShared(true); });
  // Never synced: syncs at once.
  list = { status: {}, items: [] };
  await app.ev(() => showShared());
  await expect(app.page.locator('#message')).toHaveText('Fetching the shared index…');
  await expect.poll(() => app.sent('shared', 'sync').length).toBe(3);
  await expect(app.page.locator('.circle[data-id="sh:sync"]')).toHaveAttribute('title', 'not synced yet');
  // The list failing.
  app.api = routes({ shared: () => Promise.reject(err('index down')) });
  await app.ev(() => showShared());
  await expect(app.page.locator('#toast')).toHaveText('index down');
  await app.ev(() => sharedOpen({ id: 'sh:updates' }));
  expect(await app.ev(() => sharedOpen({ id: 'zzz' }))).toBe(false);
  expect(await app.ev(() => [ago('x'), ago(new Date(Date.now() - 600000).toISOString()), ago(new Date().toISOString())])).toEqual(['', '10 min', '1 s']);
});

test('adopting: review by the AI, confirm, open; reporting; withdrawing your own', async ({ app }) => {
  let prepare = { sha256: 'f'.repeat(64), code: 'lib.x = 1;', staticFindings: ['uses fetch'], review: { verdict: 'unsafe', summary: 'S', network: 'N', system: 'Y', suspicious: ['eval'] } };
  let adopt = { key: 'ak', title: 'Chart applet', version: 3 };
  let it = item({ uses: ['dep1'], libs: ['d3'], usage: 'lib.chart()', size: 2048, updated: '2026-01-01T00:00:00Z', sha256: 'abc', authorName: 'Ann', mine: true, adoptedVersion: 1, updateAvailable: true });
  await app.open({ native: true, api: routes({ shared: (b) => {
    if (b.op === 'item') return b.id === 'bad' ? Promise.reject(err('no item')) : { item: b.id === 'dep1' ? item({ id: 'dep1', title: 'Dep' }) : it };
    if (b.op === 'prepare') return prepare instanceof Error ? Promise.reject(prepare) : prepare;
    if (b.op === 'adopt') return adopt instanceof Error ? Promise.reject(adopt) : adopt;
    if (b.op === 'report') return b.reason === 'fail' ? Promise.reject(err('report failed')) : { ok: true };
    if (b.op === 'withdraw') return b.id === 'bad2' ? Promise.reject(err('withdraw failed')) : { ok: true };
    return { ok: true };
  }, usage: (b, d) => (b.op === 'outcome' ? { screen: { kind: 'html', title: 'Chart applet', html: '' } } : d('usage', b)) }) });
  await app.ev(() => showSharedItem('it1'));
  await expect(app.page.locator('#title')).toHaveText('Chart');
  let f = await ready(app);
  const t = await f.textContent('body');
  for (const s of ['draws charts', 'component', 'viz', 'aaaaaa…aaaaaa · Ann · yours', 'v3 · Adopted, version 1', '5', 'lib.chart()', 'd3', '2 KB', 'abc']) expect(t).toContain(s);
  expect(await f.textContent('#adopt')).toBe('Review the update to v3');
  // Review: unsafe verdict, "Adopt anyway".
  await fclick(f, '#adopt');
  await f.waitForSelector('#review:not([hidden]) .verdict.unsafe');
  expect(await f.textContent('#out')).toBe('✓ sha256 verified · ffffffffffffffff…');
  expect(await f.textContent('#confirm')).toBe('Adopt anyway');
  expect(await f.textContent('#review')).toContain('eval');
  expect(await f.textContent('#code')).toBe('lib.x = 1;');
  await fclick(f, '#cancelAdopt');
  expect(await f.isHidden('#review')).toBe(true);
  // Safe; adopt fails, then works; open it.
  prepare = { ...prepare, review: { verdict: 'safe' }, staticFindings: [] };
  await fclick(f, '#adopt');
  await f.waitForSelector('#review .verdict.safe');
  adopt = err('adopt failed');
  await fclick(f, '#confirm');
  await f.waitForSelector('#done.err');
  adopt = { key: 'ak', title: 'Chart applet', version: 3 };
  await fclick(f, '#confirm');
  await f.waitForSelector('#openIt');
  expect(await f.textContent('#adopt')).toBe('✓ Adopted, version 3');
  await fclick(f, '#openIt');
  await expect(app.page.locator('#title')).toHaveText('Chart applet');
  await app.ev(() => back());
  await expect(app.page.locator('#title')).toHaveText('Chart');
  f = await frameWith(app, '#adopt');
  // Adopted without a key (a module): no open button; an unknown verdict counts as caution.
  prepare = { sha256: 'e'.repeat(64), review: { verdict: 'weird' } };
  adopt = { version: 4 };
  await f.evaluate(() => { document.getElementById('adopt').disabled = false; });
  await fclick(f, '#adopt');
  await f.waitForSelector('#review .verdict.caution');
  await fclick(f, '#confirm');
  await f.waitForFunction(() => document.getElementById('done').textContent.includes('Adopted'));
  expect(await f.$('#openIt')).toBe(null);
  // Prepare failing; no review at all.
  prepare = err('download failed');
  await f.evaluate(() => { document.getElementById('adopt').disabled = false; });
  await fclick(f, '#adopt');
  await f.waitForFunction(() => document.getElementById('out').textContent === '✗ download failed');
  prepare = { sha256: 'd'.repeat(64) };
  await fclick(f, '#adopt');
  await f.waitForSelector('#review .verdict.caution');
  // Report: a reason, failing then sent.
  await fclick(f, '#report');
  await f.fill('#why', 'fail');
  await fclick(f, '#sendReport');
  await f.waitForFunction(() => document.getElementById('out').textContent === 'report failed');
  await f.fill('#why', 'malicious');
  await fclick(f, '#sendReport');
  await f.waitForFunction(() => document.getElementById('out').textContent.includes('Reported'));
  // Withdraw: asks once more, then goes.
  await fclick(f, '#withdraw');
  expect(await f.textContent('#withdraw')).toBe('Withdraw — sure?');
  await fclick(f, '#withdraw');
  await f.waitForFunction(() => document.getElementById('out').textContent.includes('Withdrawn'));
  // A dependency button opens that item with the review.
  await fclick(f, '[data-item="dep1"]');
  await expect(app.page.locator('#title')).toHaveText('Dep');
  // Already adopted, not mine, without extras; withdraw failing.
  it = item({ id: 'bad2', adoptedVersion: 3, mine: true });
  await app.ev(() => showSharedItem('bad2'));
  f = await ready(app);
  expect(await f.isDisabled('#adopt')).toBe(true);
  await fclick(f, '#withdraw');
  await fclick(f, '#withdraw');
  await f.waitForFunction(() => document.getElementById('out').textContent === 'withdraw failed');
  it = item();
  await app.ev(() => aiui.adoptShared('x'));
  f = await ready(app);
  await f.waitForSelector('#review:not([hidden])');
  await app.ev(() => showSharedItem('bad'));
  await expect(app.page.locator('#toast')).toHaveText('no item');
  await app.ev(() => aiui.adoptShared());
});

test('sharing globally: what you can share, the exact preview, then the signed post', async ({ app }) => {
  let share = { version: 1, id: 'new1' };
  await app.open({ native: true, api: routes({ shared: (b) => {
    if (b.op === 'shareable') return { modules: [{ id: 'm1', name: 'Chart', role: 'component', path: ['viz'], version: 2, description: 'd' }, { id: 'm2', name: 'Fmt', version: 1 }], applets: [{ key: 'ap', title: 'Budget' }, { key: 'ap2', title: 'B2', opens: 3 }] };
    if (b.op === 'preview') return b.module === 'bad' ? Promise.reject(err('cannot preview')) : { body: { title: b.applet ? 'Budget' : '', name: 'chart' }, json: '{"x":1}', digest: 'dg', author: ID, payloadBytes: 1500,
      warnings: b.applet ? ['contains a URL'] : [], strip: b.applet ? ['token'] : [] };
    if (b.op === 'share') return share instanceof Error ? Promise.reject(share) : share;
    return { ok: true };
  } }) });
  await app.ev(() => sharedOpen({ id: 'sh:share' }));
  await expect(app.page.locator('#title')).toHaveText('Share globally');
  expect(await labels(app)).toEqual(['Chart', 'Fmt', 'Budget', 'B2']);
  await expect(app.page.locator('.circle[data-id="shm:m1"] .hint')).toHaveText('component · viz · v2');
  await expect(app.page.locator('.circle[data-id="sha:ap"] .hint')).toHaveText('applet · 0 ×');
  await click(app, 'Budget');
  await expect(app.page.locator('#title')).toHaveText('Share globally: Budget');
  let f = await ready(app);
  expect(await f.textContent('#json')).toBe('{"x":1}');
  expect(await f.textContent('body')).toContain('⚠ contains a URL');
  expect(await f.textContent('body')).toContain('The applet says these must never be shared: token');
  expect(await f.textContent('body')).toContain('aaaaaa…aaaaaa · 2 KB');
  share = err('share failed');
  await fclick(f, '#share');
  await f.waitForFunction(() => document.getElementById('out').textContent === 'share failed');
  share = { version: 1, id: 'new1' };
  await fclick(f, '#share');
  await f.waitForFunction(() => document.getElementById('out').textContent.includes('Shared globally as version 1 · new1'));
  expect(app.sent('shared', 'share')[1].body).toEqual({ op: 'share', digest: 'dg', applet: 'ap' });
  await fclick(f, '#cancel');
  await expect(app.page.locator('#title')).toHaveText('Share globally');
  await click(app, 'Chart');
  await expect(app.page.locator('#title')).toHaveText('Share globally: chart');
  await app.ev(() => aiui.sharePreview({ module: 'bad' }));
  await expect(app.page.locator('#toast')).toHaveText('cannot preview');
  app.api = routes({ shared: () => ({}) });
  await app.ev(() => showShareList());
  await expect(app.page.locator('#message')).toHaveText('Nothing of your own to share yet.');
});

test('module cards from the Utility Library: local, from the registry, shared by me', async ({ app }) => {
  let mod = { id: 'm1', name: 'Chart', role: 'component', kind: 'js', path: ['viz'], version: 2, usage: 'lib.chart()', code: 'lib.chart = 1;', description: 'charts' };
  await app.open({ native: true, api: routes({
    shared: (b) => (b.op === 'module' ? (mod instanceof Error ? Promise.reject(mod) : mod) : b.op === 'preview' ? { body: { name: 'Chart' }, json: '{}', author: ID } : { item: item({ id: b.id, title: 'Item ' + b.id }) }),
    utilities: { categories: [], utilities: [{ id: 'm1', name: 'Chart', uses: 1 }], total: 1 },
  }) });
  await app.ev(() => showLibrary());
  await click(app, 'Chart');
  await expect(app.page.locator('#title')).toHaveText('Chart');
  let f = await ready(app);
  expect(await f.textContent('body')).toContain('Local — on this device');
  expect(await f.textContent('#code')).toBe('lib.chart = 1;');
  // Instant actions on the card: share this module.
  expect(await app.ev(() => instantFor(instantContext(current)).map((a) => a.id))).toContain('shareModule');
  await fclick(f, '#share');
  await expect(app.page.locator('#title')).toHaveText('Share globally: Chart');
  // Adopted from the registry: its origin opens the item; no share button.
  mod = { ...mod, role: 'util', origin: 'o1', originVersion: 3, originItem: { title: 'Origin item' } };
  await app.ev(() => showModuleCard('m1'));
  f = await ready(app);
  expect(await f.$('#share')).toBe(null);
  await fclick(f, '#origin');
  await expect(app.page.locator('#title')).toHaveText('Item o1');
  mod = { ...mod, origin: 'o2', originItem: null, sharedAs: 's1' };
  await app.ev(() => showModuleCard('m1'));
  f = await ready(app);
  expect(await f.textContent('#origin')).toBe('o2');
  await fclick(f, '#mine');
  await expect(app.page.locator('#title')).toHaveText('Item s1');
  mod = err('no module');
  await app.ev(() => showModuleCard('m1'));
  await expect(app.page.locator('#toast')).toHaveText('no module');
  // The library's own circles: categories fall through to the app.
  expect(await app.ev(() => LOCAL_SCREENS.library.open({ id: 'cat:x' }))).toBe(false);
});

test('People: your id, profile, find, add by id, contacts; events', async ({ app, context }) => {
  let st = { id: ID, short: 'aaa…aaa', profile: { name: 'Me', handle: 'me', findable: true }, lastCheck: new Date(Date.now() - 120000).toISOString(),
    contacts: [{ id: 'b'.repeat(64), name: 'Bob', state: 'mutual' }, { id: 'c'.repeat(64), state: 'pending' }, { id: 'd'.repeat(64), name: 'Dee', state: 'incoming' }, { id: 'e'.repeat(64), state: 'weird' }] };
  let find = { profiles: [{ id: 'f'.repeat(64), name: 'Fay', handle: 'fay', state: 'mutual' }, { id: ID, self: true }, { id: '1'.repeat(64), state: 'incoming' }, { id: '2'.repeat(64), state: 'pending' }, { id: '3'.repeat(64) }] };
  let addOk = true;
  await app.open({ native: true, api: routes({ people: (b) => {
    if (b.op === 'status' || b.op === 'open') return st instanceof Error ? Promise.reject(st) : st;
    if (b.op === 'find') return b.q === 'fail' ? Promise.reject(err('find down')) : find;
    if (b.op === 'add') return addOk ? st : Promise.reject(err('cannot add'));
    if (b.op === 'inbox') return b.fail ? Promise.reject(err('x')) : { ok: true };
    if (b.op === 'identity') return { id: ID };
    if (b.op === 'profile') return b.profile.name === 'fail' ? Promise.reject(err('profile failed')) : { ok: true };
    if (b.op === 'deleteProfile') return { ok: true };
    if (b.op === 'remove') return { ok: true };
    return { ok: true };
  }, sys: { ok: true } }) });
  await app.ev(() => aiui.people());
  await expect(app.page.locator('#title')).toHaveText('People');
  expect(await labels(app)).toEqual(['aaa…aaa', 'Your profile', 'Find people', 'Add by id', 'Check now', 'Dee', 'Bob', 'cccccc…cccccc', 'eeeeee…eeeeee']);
  await expect(app.page.locator('.circle[data-id="p:profile"] .hint')).toHaveText('Me · @me · findable');
  await expect(app.page.locator('.circle[data-id="p:check"]')).toHaveAttribute('title', 'checked 2 min');
  await expect(app.page.locator(`.circle[data-id="c:${'b'.repeat(64)}"] .hint`)).toHaveText('✓ verified · bbbbbb…bbbbbb');
  // Copy my id (native clipboard).
  await click(app, 'aaa…aaa');
  await expect.poll(() => app.sent('sys').map((c) => c.body)).toEqual([{ op: 'clipboard', text: ID }]);
  await expect(app.page.locator('#status')).toHaveText('📋 Copied');
  // Check now: inbox, refreshed in place.
  await click(app, 'Check now');
  await expect.poll(() => app.sent('people', 'inbox').length).toBe(1);
  // An incoming contact: adding back.
  await click(app, 'Dee');
  await expect.poll(() => app.sent('people', 'add').length).toBe(1);
  await expect(app.page.locator('#status')).toHaveText('👥 Added — waiting for them to add you back.');
  addOk = false;
  await click(app, 'Dee');
  await expect(app.page.locator('#toast')).toHaveText('cannot add');
  addOk = true;
  // A contact's card: verified, remove.
  await click(app, 'Bob');
  await expect(app.page.locator('#title')).toHaveText('Bob');
  let f = await ready(app);
  expect(await f.textContent('body')).toContain('Verified: you added each other');
  expect(await f.$('#add')).toBe(null);
  await fclick(f, '#remove');
  await f.waitForFunction(() => document.getElementById('out').textContent.includes('Removed'));
  await fclick(f, '[data-copy]');
  await f.waitForFunction(() => document.querySelector('[data-copy]').textContent === 'Copied');
  // Find: results without me; nothing found offers the id; failing.
  await app.ev(() => showPeople());
  await click(app, 'Find people');
  await app.page.keyboard.type('fay');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('Find people: fay');
  expect(await labels(app)).toEqual(['Fay', '111111…111111', '222222…222222', '333333…333333']);
  await expect(app.page.locator(`.circle[data-id="f:${'f'.repeat(64)}"] .hint`)).toHaveText('@fay · ✓ verified');
  await expect(app.page.locator(`.circle[data-id="f:${'3'.repeat(64)}"] .hint`)).toHaveText('333333…333333');
  await click(app, '333333');
  f = await ready(app);
  expect(await f.textContent('#add')).toBe('Add by id');
  expect(await f.$('#remove')).toBe(null);
  addOk = false;
  await fclick(f, '#add');
  await f.waitForFunction(() => document.getElementById('out').className === 'err');
  addOk = true;
  await fclick(f, '#add');
  await f.waitForFunction(() => document.getElementById('out').textContent.includes('Added'));
  await app.ev(() => back());
  await click(app, '111111');
  f = await ready(app);
  expect(await f.textContent('#add')).toBe('Add back');
  expect(await f.textContent('body')).toContain('added you — open to add back');
  await app.ev(() => back());
  await click(app, '222222');
  f = await ready(app);
  expect(await f.textContent('body')).toContain('waiting for them to add you');
  find = { profiles: [], id: '9'.repeat(64) };
  await app.ev(() => findPeople('9999'));
  expect(await labels(app)).toEqual(['Add this id']);
  const adds = app.sent('people', 'add').length;
  await click(app, 'Add this id');
  await expect.poll(() => app.sent('people', 'add').length).toBe(adds + 1);
  addOk = false;
  await app.ev(() => findPeople('9999'));
  await click(app, 'Add this id');
  addOk = true;
  find = { profiles: [] };
  await app.ev(() => findPeople('nobody'));
  await expect(app.page.locator('#message')).toHaveText(/Nobody found/);
  await app.ev(() => findPeople('fail'));
  await expect(app.page.locator('#toast')).toHaveText('find down');
  // Add by id: a text screen.
  await app.ev(() => showPeople());
  await click(app, 'Add by id');
  await app.page.keyboard.type('  ' + '7'.repeat(64) + ' ');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('People');
  expect(app.sent('people', 'add').at(-1).body.id).toBe('7'.repeat(64));
  addOk = false;
  await click(app, 'Add by id');
  await app.page.keyboard.type('x');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#title')).toHaveText('Add by id');
  addOk = true;
  await app.ev(() => back());
  // The profile form: save, failing, delete.
  await click(app, 'Your profile');
  f = await ready(app);
  expect(await f.inputValue('#name')).toBe('Me');
  await f.fill('#handle', '@NewMe');
  await fclick(f, 'button[type=submit]');
  await expect.poll(() => app.sent('people', 'profile').length).toBe(1);
  expect(app.sent('people', 'profile')[0].body.profile).toEqual({ name: 'Me', handle: 'newme', about: '', findable: true });
  await f.fill('#name', 'fail');
  await fclick(f, 'button[type=submit]');
  await f.waitForFunction(() => document.getElementById('out').textContent === 'profile failed');
  await fclick(f, '#del');
  await f.waitForFunction(() => document.getElementById('out').textContent.includes('Profile removed'));
  // No profile, offline, never checked.
  st = { ...st, profile: null, offline: true, lastCheck: null, contacts: undefined };
  await app.ev(() => showPeople(true));
  await app.ev(() => showPeople());
  await expect(app.page.locator('#message')).toHaveText(/Can’t reach users\.aiui\.oeaio\.com/);
  await expect(app.page.locator('.circle[data-id="p:profile"] .hint')).toHaveText('not listed');
  await click(app, 'Your profile');
  f = await ready(app);
  expect(await f.$('#del')).toBe(null);
  // Listed but not findable.
  st = { ...st, profile: { name: 'Me', findable: false } };
  await app.ev(() => showPeople());
  await expect(app.page.locator('.circle[data-id="p:profile"] .hint')).toHaveText('Me · listed, not findable');
  // People events: flash, an activity for a minute, a refresh when People is on screen.
  await app.ev(() => aiui._event({ type: 'people', what: 'incoming', id: 'x'.repeat(64), note: 'hi' }));
  await expect(app.page.locator('#status')).toHaveText('👥 xxxxxx…xxxxxx added you: hi');
  await app.ev(() => aiui._event({ type: 'people', what: 'mutual', name: 'Zed', id: 'z' }));
  await expect(app.page.locator('#status')).toHaveText('👥 Zed — you added each other: id verified');
  await app.ev(() => aiui._event({ type: 'people', what: 'removed', short: 'q…q', id: 'q' }));
  await expect(app.page.locator('#status')).toHaveText('👥 q…q removed you');
  await app.ev(() => aiui._event({ type: 'people', what: 'odd', id: 'q' }));
  await app.ev(() => activities.get('people:mutual:z').actions[0].run());
  await app.tick(60100);
  expect(await app.ev(() => [...activities.keys()].some((k) => k.startsWith('people:')))).toBe(false);
  // Status failing or with an error.
  st = { error: 'not set up' };
  await app.ev(() => showPeople());
  await expect(app.page.locator('#toast')).toHaveText('not set up');
  st = err('people down');
  await app.ev(() => showPeople());
  await expect(app.page.locator('#toast')).toHaveText('people down');
  // Unknown circle; the inbox check failing.
  expect(await app.ev(() => peopleOpen({ id: 'zz' }))).toBe(false);
  app.api = routes({ people: (b) => (b.op === 'inbox' ? Promise.reject(err('inbox down')) : { id: ID }) });
  await app.ev(() => peopleOpen({ id: 'p:check' }));
  await expect(app.page.locator('#toast')).toHaveText('inbox down');
  await app.ev(() => { current.screen = { local: 'x' }; popTextScreen('peopleFind'); });
  // Copy in the web version uses the browser clipboard.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:47231' });
});

test('instant actions of shared code and people; the share offer of an applet', async ({ app }) => {
  let live = { scene: { opens: 3, improves: 2 } };
  await app.open({ native: true, api: routes({
    shared: (b) => (b.op === 'status' ? { updates: ['u'], mine: 2 } : b.op === 'preview' ? { body: { title: 'P ' + JSON.stringify(Object.keys(b).filter((k) => k !== 'op')) }, json: '{}', author: ID }
      : b.op === 'updates' ? { items: [item({ title: 'Upd' })] } : b.op === 'mine' ? { items: [item({ title: 'Mine' })] } : b.op === 'withdraw' && b.id === 'w2' ? Promise.reject(err('cannot withdraw')) : b.op === 'report' && b.reason === 'bad' ? Promise.reject(err('cannot report')) : b.op === 'item' ? { item: item() } : b.op === 'list' ? { status: { syncedAt: 'x' }, items: [] } : { ok: true }),
    people: (b) => (b.op === 'identity' ? { id: ID } : b.op === 'status' ? { id: ID, contacts: [] } : b.op === 'inbox' ? Promise.reject(err('inbox down')) : { ok: true }),
    live: () => (live === 'fail' ? Promise.reject(err('x')) : live && live.promise ? live.promise : live),
  }) });
  await expect.poll(() => app.ev(() => sharedStatus.mine)).toBe(2);
  const ids = () => app.ev(() => instantFor(instantContext(current)).map((a) => a.id));
  const run = (id) => app.ev((id) => runInstant(INSTANT.find((a) => a.id === id), instantContext(current)), id);
  expect(await ids()).toEqual(expect.arrayContaining(['sharedByOthers', 'sharedSearch', 'sharedSync', 'sharedUpdates', 'shareList', 'sharedMine', 'people', 'findPeople', 'addPerson', 'peopleProfile', 'peopleInbox', 'copyAppId']));
  await run('sharedUpdates');
  await expect(app.page.locator('#title')).toHaveText('Updates for what you adopted');
  await run('sharedMine');
  await expect(app.page.locator('#title')).toHaveText('Shared by me');
  await run('sharedSearch');
  await expect(app.page.locator('#title')).toHaveText('Search');
  await run('findPeople');
  await expect(app.page.locator('#title')).toHaveText('Find people');
  await run('addPerson');
  await expect(app.page.locator('#title')).toHaveText('Add by id');
  await run('peopleProfile');
  await expect(app.page.locator('#title')).toHaveText('Your profile');
  await run('peopleInbox');
  await expect(app.page.locator('#toast')).toHaveText('inbox down');
  await run('copyAppId');
  await expect.poll(() => app.sent('sys').some((c) => c.body.text === ID)).toBe(true);
  await run('sharedSync');
  await run('shareList');
  await run('sharedByOthers');
  await run('people');
  // A scene that is not an applet: share it as a scene.
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'html', title: 'Sc', fixed: true, html: '<p>x</p>', improve: { x: 1 }, fullscreen: true }, label: 'Sc' }; render(); });
  expect(await ids()).toContain('shareScene');
  await run('shareScene');
  await expect(app.page.locator('#title')).toHaveText('Share globally: P ["scene"]');
  expect(app.sent('shared', 'preview').at(-1).body.scene).toEqual({ kind: 'html', title: 'Sc', message: '', html: '<p>x</p>', uses: [], libs: [], improve: { x: 1 }, fullscreen: true });
  // An applet: share it; its share offer after enough use.
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'html', title: 'Ap', fixed: true, html: '', shareable: { propose: true, why: 'handy' } }, label: 'Ap', key: 'apk' }; render(); });
  await run('shareApplet');
  await expect(app.page.locator('#title')).toHaveText('Share globally: P ["applet"]');
  await app.ev(() => back());
  await app.tick(5100);
  await expect.poll(() => app.sent('live').length).toBe(1);
  await expect(app.page.locator('#status')).toHaveText('📤 Worth sharing with other AI UI users: handy');
  expect((await ids()).slice(0, 2)).toEqual(['shareOffer', 'shareOfferDecline']);
  expect(await app.ev(() => INSTANT.find((a) => a.id === 'shareOffer').label())).toBe('Share this applet with others?');
  await run('shareOffer');
  await expect(app.page.locator('#title')).toHaveText('Share globally: P ["applet"]');
  await app.ev(() => back());
  await run('shareOfferDecline');
  await expect(app.page.locator('#status')).toHaveText('✕ Not now');
  expect(await app.ev(() => JSON.parse(localStorage.getItem('aiui.shareDeclined')))).toEqual({ apk: 2 });
  // Checked at most every 2 minutes; declined for this version: no offer.
  await app.tick(5100);
  expect(app.sent('live').length).toBe(1);
  await app.tick(120000);
  await expect.poll(() => app.sent('live').length).toBe(2);
  expect(await app.ev(() => shareOffer)).toBe(null);
  // Components: one module or several.
  await app.ev(() => { runShareOffer({ as: 'component', ids: ['m1'], key: 'apk' }); });
  await expect(app.page.locator('#title')).toHaveText('Share globally: P ["module"]');
  await app.ev(() => runShareOffer({ as: 'component', ids: ['m1', 'm2'], key: 'apk' }));
  expect(await labels(app)).toEqual(['m1', 'm2']);
  await app.ev(() => runShareOffer({ as: 'component', ids: [], key: 'apk' }));
  await expect(app.page.locator('#title')).toHaveText('Share globally: P ["applet"]');
  expect(await app.ev(() => { shareOffer = { as: 'component', key: 'x' }; const l = INSTANT.find((a) => a.id === 'shareOffer').label(); shareOffer = null; return l; })).toBe('Share its component with others?');
  // Offer conditions: not enough use, another key, a failing live call, the user left meanwhile.
  await app.ev(() => { stack.push(current); current = { screen: { kind: 'html', title: 'Ap2', fixed: true, html: '', shareable: { propose: true, as: 'component', ids: ['m9'] } }, label: 'Ap2', key: 'apk2' }; render(); });
  live = { scene: { opens: 1, minutes: 2 } };
  await app.tick(5100);
  await expect.poll(() => app.sent('live').length).toBe(3);
  expect(await app.ev(() => shareOffer)).toBe(null);
  live = { scene: { minutes: 12 } };
  await app.ev(() => { offerChecked.clear(); return checkShareOffer(); });
  expect(await app.ev(() => shareOffer && shareOffer.as)).toBe('component');
  await app.ev(() => checkShareOffer()); // already offered for this key
  live = null;
  await app.ev(() => { offerChecked.clear(); shareOffer = null; return checkShareOffer(); });
  live = 'fail';
  await app.ev(() => { offerChecked.clear(); return checkShareOffer(); });
  const d = deferred();
  live = d;
  const p = app.ev(() => { offerChecked.clear(); return checkShareOffer(); });
  await app.ev(() => { current.key = 'elsewhere'; });
  d.resolve({ scene: { opens: 5 } });
  await p;
  await app.ev(() => { current.key = 'apk2'; current.screen.shareable = { propose: false }; checkShareOffer(); current.screen = { kind: 'circles' }; checkShareOffer(); });
  expect(await app.ev(() => [shareableRow(null), shareableRow({ shareable: { propose: false } }), shareableRow({ shareable: { propose: true, as: 'applet', why: 'w' } })]))
    .toEqual([[], [['Shareable', 'not proposed']], [['Shareable', 'proposed · applet — w']]]);
  // Shared item scene actions: adopt, withdraw (failing), report (failing, then sent).
  await app.ev(() => showSharedItem('it1'));
  await expect(app.page.locator('#title')).toHaveText('Chart');
  expect(await ids()).toEqual(expect.arrayContaining(['sharedAdopt', 'sharedReport']));
  await run('sharedAdopt');
  await app.ev(() => { current.screen.sharedMine = true; current.screen.sharedItem = 'w2'; });
  await run('sharedWithdraw');
  await expect(app.page.locator('#toast')).toHaveText('cannot withdraw');
  await app.ev(() => { current.screen.sharedItem = 'it1'; });
  await run('sharedWithdraw');
  await expect(app.page.locator('#status')).toHaveText('🌐 Withdrawn: it left the index.');
  await app.ev(() => showSharedItem('it1'));
  await expect(app.page.locator('#title')).toHaveText('Chart');
  await run('sharedReport');
  await expect(app.page.locator('#title')).toHaveText('Report this shared item');
  await app.page.keyboard.type('bad');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('#toast')).toHaveText('cannot report');
  await app.ev(() => { el.write.value = 'spam'; submitText(); });
  await expect(app.page.locator('#status')).toHaveText('🌐 Reported. Thank you.');
  await expect(app.page.locator('#title')).toHaveText('Chart');
  // Reviewing activities get a title; others pass through.
  await app.ev(() => { aiui._event({ type: 'activity', id: 'sr-1', kind: 'sharedReview', name: 'Chart' }); aiui._event({ type: 'activity', id: 'sr-2', kind: 'sharedReview' }); });
  expect(await app.ev(() => [activities.get('sr-1').title, activities.get('sr-2').title])).toEqual(['reviewing shared code «Chart»', 'reviewing shared code']);
  // The identity section of Settings & System.
  expect(await app.ev(() => identitySection(null))).toBe('');
  const sec = await app.ev((id) => identitySection({ id }, (t, rows) => t + rows.join(''), (k, v) => k + ':' + v), ID);
  expect(sec).toContain('App identity');
  expect(sec).toContain('aaaaaa…aaaaaa');
  // The theme's muted colour, made stronger; a non-hex theme falls back.
  expect(await app.ev(() => mutedStrong())).toMatch(/^#[0-9a-f]{6}$/);
  await app.ev(() => document.documentElement.style.setProperty('--muted', 'red'));
  expect(await app.ev(() => mutedStrong())).toBe('var(--muted)');
});

test('web: copying uses the browser clipboard; nothing of People or the registry is offered', async ({ app, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:47231' });
  await app.open({ storage: { 'aiui.paused': '1' } });
  await app.ev(() => copyText('hello'));
  expect(await app.ev(() => navigator.clipboard.readText())).toBe('hello');
  await expect(app.page.locator('#status')).toHaveText('📋 Copied');
  const ids = await app.ev(() => instantFor(instantContext(current)).map((a) => a.id));
  expect(ids).not.toContain('people');
  expect(ids).not.toContain('nativeLibs');
  // On the web the shared item's offer check is skipped.
  await app.ev(() => checkShareOffer());
  // The People screen notifies when the app is not focused (native only).
});
