// Native libraries (web/native.js): the page, its actions, and the Settings & System section.
import { test, expect } from '../harness.mjs';
import { routes, err } from './util.mjs';

const frame = async (app) => (await app.page.waitForSelector('#view iframe')).contentFrame();

test('native libraries: installed and available tools, policy, actions; refreshes while installing', async ({ app }) => {
  let status = { policy: { allowed: true, setting: true, managed: null, network: 'wifi', paused: true }, pack: true, used: 2.5e8, budget: 2e9, catalogVersion: '7',
    installing: ['jq'], tools: [
      { id: 'jq', installed: true, installedVersion: '1.7', version: '1.8', diskBytes: 1.2e6, default: true, description: 'JSON', license: 'MIT', source: 'gh', executables: ['jq'], previous: '1.6', error: 'x' },
      { id: 'rg', installed: true, installedVersion: '14', version: '14', diskBytes: 3e5, installing: true },
      { id: 'ffmpeg', installed: false, version: '7', bytes: 8e7, default: true },
      { id: 'duckdb', installed: false, version: '1', bytes: 4e5 },
    ] };
  let fail = false;
  await app.open({ native: true, api: routes({
    native: () => (fail ? Promise.reject(err('native down')) : status),
    sys: (b) => (b.op === 'native' ? (b.on === false ? Promise.reject(err('refused')) : status) : { ok: true }),
  }) });
  await app.ev(() => aiui.nativeLibraries());
  await expect(app.page.locator('#title')).toHaveText('Native libraries');
  const f = await frame(app);
  await f.waitForSelector('#rows tr');
  expect(await f.textContent('#sum')).toBe('2 installed · 250 MB of 2000 MB budget · catalog 7');
  expect(await f.textContent('#policy')).toContain('Allowed');
  expect(await f.textContent('#policy')).toContain('Admin policy: not set · Network: wifi · background work paused');
  expect(await f.textContent('#policy')).toContain('Offline pack bundled');
  expect(await f.$$eval('#rows tr td:first-child b', (ns) => ns.map((n) => n.textContent))).toEqual(['jq', 'rg', 'ffmpeg', 'duckdb']);
  expect(await f.textContent('#rows')).toContain('→ 1.8 available');
  expect(await f.textContent('#rows')).toContain('1.2 MB');
  expect(await f.textContent('#rows')).toContain('300 KB');
  expect(await f.textContent('#rows')).toContain('80.0 MB download');
  expect(await f.textContent('#rows')).toContain('installing…');
  await f.click('button[data-op="rollback"]');
  await expect.poll(() => app.sent('sys').some((c) => c.body.op === 'native' && c.body.action === 'rollback' && c.body.id === 'jq' && c.body.wait === 1)).toBe(true);
  await f.click('button[data-op="ensure"][data-id="duckdb"]');
  await f.click('button[data-op="update"]');
  await f.click('button[data-op="cancel"]');
  await f.click('button[data-op="remove"]');
  // The setting checkbox; refused: an alert.
  f.page().on('dialog', (d) => d.dismiss());
  await f.evaluate(() => { const c = document.getElementById('setting'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await expect.poll(() => app.sent('sys').some((c) => c.body.action === 'setting' && c.body.on === false)).toBe(true);
  expect(app.sent('sys').filter((c) => c.body.op === 'native').map((c) => c.body.action)).toEqual(expect.arrayContaining(['rollback', 'ensure', 'update', 'cancel', 'remove', 'status']));
  // While installing it refreshes every 1.5 s.
  const n = app.sent('sys').length;
  await app.tick(1600);
  await expect.poll(() => app.sent('sys').length).toBeGreaterThan(n);
  // Blocked by policy, admin denied; refresh failing is quiet.
  status = { policy: { allowed: false, reason: 'metered network', managed: false, setting: false }, tools: [], used: 0, budget: 0 };
  await f.click('button[data-op="update"]');
  await expect.poll(() => f.textContent('#policy')).toContain('Blocked: metered network');
  expect(await f.textContent('#policy')).toContain('Admin policy: denied');
  expect(await f.textContent('#sum')).toBe('0 installed · 1 KB of 1 KB budget · catalog —');
  status = { policy: { allowed: true, managed: true }, tools: [] };
  await f.click('button[data-op="update"]');
  await expect.poll(() => f.textContent('#policy')).toContain('Admin policy: allowed');
  app.api = routes({ sys: () => Promise.reject(err('x')) });
  await f.click('button[data-op="update"]');
  await app.settle(200);
  // Status failing: a toast.
  app.api = routes({ native: () => Promise.reject(err('native down')) });
  await app.ev(() => showNativeLibraries());
  await expect(app.page.locator('#toast')).toHaveText('native down');
  // The settings section: only with a native store.
  expect(await app.ev(() => [nativeSettingHtml(null), nativeSettingHtml({}), nativeSection(null), nativeSection({})])).toEqual(['', '', '', '']);
  expect(await app.ev(() => nativeSettingHtml({ policy: { setting: false } }))).not.toContain('checked');
  expect(await app.ev(() => nativeSection({ tools: [] }, (t, rows) => rows.join('|'), (k, v) => k + '=' + v))).toBe('Installed=0 of 0: —|Disk=0 B of 0 B|Downloads=blocked: undefined|On the PATH=—');
});
