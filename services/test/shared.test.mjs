import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { world, newKey, item } from './helpers.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('share, read the item and its byte-exact payload', async () => {
  const w = world(), k = newKey();
  const body = item();
  const r = await w.shared('POST', '/v1/items', { key: k, body });
  assert.equal(r.status, 201);
  const x = r.json;
  assert.match(x.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual({ kind: x.kind, name: x.name, path: x.path, title: x.title, version: x.version, author: x.author, adoptions: x.adoptions, reports: x.reports },
    { kind: 'component', name: 'gameKit', path: ['games', 'core'], title: 'Game kit', version: 1, author: k.id, adoptions: 0, reports: 0 });
  assert.equal(x.created, '2026-11-03T12:00:00.000Z');
  assert.equal(x.updated, x.created);
  assert.deepEqual(x.libs, ['three']);
  assert.equal(x.git, undefined);
  assert.equal(x.status, undefined);
  const exact = Buffer.from(JSON.stringify(body.payload));
  assert.equal(x.sha256, sha(exact));
  assert.equal(x.size, exact.length);

  const g = await w.shared('GET', `/v1/items/${x.id}`);
  assert.equal(g.status, 200);
  assert.deepEqual(g.json, x);
  assert.equal(g.headers['cache-control'], 'public, max-age=60');

  const p = await w.shared('GET', `/v1/items/${x.id}/payload`);
  assert.equal(p.status, 200);
  assert.equal(p.headers['content-type'], 'application/json');
  assert.ok(Buffer.isBuffer(p.body));
  assert.equal(sha(p.body), x.sha256);
  assert.deepEqual(p.body, exact);

  assert.equal((await w.shared('GET', '/v1/items/01ARZ3NDEKTSV4RRFFQ69G5FAV')).status, 404);
  assert.equal((await w.shared('GET', '/v1/items/nope')).status, 404);
});

test('the display name comes from the profile', async () => {
  const w = world(), k = newKey();
  await w.users('PUT', '/v1/profile', { key: k, body: { name: 'Taras' } });
  const r = await w.shared('POST', '/v1/items', { key: k, body: item() });
  assert.equal(r.json.authorName, 'Taras');
});

test('versions: same kind+path+name by the same author', async () => {
  const w = world(), a = newKey(), b = newKey();
  const v1 = (await w.shared('POST', '/v1/items', { key: a, body: item() })).json;
  w.advance(1000);
  const same = await w.shared('POST', '/v1/items', { key: a, body: item() });
  assert.equal(same.status, 200);
  assert.equal(same.json.version, 1, 'nothing changed: no new version');
  assert.equal(same.json.updated, v1.updated);

  w.advance(1000);
  const v2 = await w.shared('POST', '/v1/items', { key: a, body: item({ payload: { code: 'export default () => 2' } }) });
  assert.equal(v2.status, 200);
  assert.equal(v2.json.id, v1.id);
  assert.equal(v2.json.version, 2);
  assert.equal(v2.json.created, v1.created);
  assert.notEqual(v2.json.updated, v1.updated);
  assert.notEqual(v2.json.sha256, v1.sha256);
  const p = await w.shared('GET', `/v1/items/${v1.id}/payload`);
  assert.equal(JSON.parse(p.text).code, 'export default () => 2');

  w.advance(1000);
  const v3 = await w.shared('POST', '/v1/items', { key: a, body: item({ payload: { code: 'export default () => 2' }, description: 'better words' }) });
  assert.equal(v3.json.version, 3, 'metadata changes make a version too');

  const other = await w.shared('POST', '/v1/items', { key: b, body: item() });
  assert.equal(other.status, 201);
  assert.notEqual(other.json.id, v1.id);
  const elsewhere = await w.shared('POST', '/v1/items', { key: a, body: item({ path: ['games'] }) });
  assert.equal(elsewhere.status, 201);
  const otherKind = await w.shared('POST', '/v1/items', { key: a, body: item({ kind: 'util' }) });
  assert.equal(otherKind.status, 201);
});

test('validation and limits', async () => {
  const w = world(), k = newKey();
  const post = (over, raw) => w.shared('POST', '/v1/items', { key: k, body: raw ?? item(over) });
  const big = 'x'.repeat(512 * 1024);
  const cases = [
    [{ kind: 'plugin' }, 400], [{ name: '' }, 400], [{ name: 'a/b' }, 400], [{ name: 'a.b' }, 400], [{ name: 'x'.repeat(81) }, 400],
    [{ path: ['ok', '../x'] }, 400], [{ path: 'games' }, 400], [{ path: Array(9).fill('a').map((x, i) => x + i) }, 400],
    [{ title: 't'.repeat(81) }, 413], [{ description: 'd'.repeat(4097) }, 413], [{ usage: 'u'.repeat(4097) }, 413],
    [{ title: 7 }, 400], [{ libs: ['ok', 'bad lib'] }, 400], [{ uses: ['not-an-id'] }, 400],
    [{ payload: null }, 400], [{ payload: [] }, 400], [{ payload: { css: 'x' } }, 400], [{ payload: { code: 'x', extra: 1 } }, 400],
    [{ payload: { code: big } }, 413], [{ kind: 'applet', payload: { html: '<p>' } }, 400],
  ];
  for (const [over, status] of cases) assert.equal((await post(over)).status, status, JSON.stringify(over).slice(0, 80));
  assert.equal((await post(null, 'not json')).status, 400);
  assert.equal((await post(null, '[1]')).status, 400);
  assert.equal((await post({ title: 't'.repeat(80), description: 'd'.repeat(4096), name: 'x'.repeat(80) })).status, 201);
  assert.equal((await post({ payload: { code: 'y'.repeat(512 * 1024 - 20) } })).status, 201);
  const applet = await post({ kind: 'applet', name: 'chess', path: [], payload: { kind: 'html', html: '<b>chess</b>', uses: [], libs: [] } });
  assert.equal(applet.status, 201);
  assert.equal(applet.json.title, 'Game kit');
  const noTitle = await post({ name: 'plain', title: undefined });
  assert.equal(noTitle.json.title, 'plain');
});

test('index: newest first, paging, since and removed', async () => {
  const w = world(), k = newKey();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push((await w.shared('POST', '/v1/items', { key: k, body: item({ name: `n${i}` }) })).json.id);
    w.advance(1000);
  }
  const all = await w.shared('GET', '/v1/index');
  assert.equal(all.status, 200);
  assert.equal(all.headers['cache-control'], 'public, max-age=60');
  assert.deepEqual(all.json.items.map((x) => x.id), [...ids].reverse());
  assert.equal(all.json.next, null);
  assert.equal(all.json.generated, new Date(w.now()).toISOString());
  assert.equal(all.json.removed, undefined);
  assert.ok(all.json.items.every((x) => !('payload' in x)));

  const seen = [];
  let next = '/v1/index?limit=2', pages = 0;
  while (next) { const r = await w.shared('GET', next); seen.push(...r.json.items.map((x) => x.id)); next = r.json.next; pages++; }
  assert.deepEqual(seen, [...ids].reverse());
  assert.equal(pages, 3);
  assert.equal((await w.shared('GET', '/v1/index?limit=501')).status, 400);
  assert.equal((await w.shared('GET', '/v1/index?after=garbage')).status, 400);

  const mark = all.json.generated;
  w.advance(1000);
  await w.shared('POST', '/v1/items', { key: k, body: item({ name: 'n1', description: 'v2' }) });
  await w.shared('DELETE', `/v1/items/${ids[3]}`, { key: k });
  const fresh = await w.shared('POST', '/v1/items', { key: k, body: item({ name: 'n9' }) });
  const since = await w.shared('GET', `/v1/index?since=${encodeURIComponent(mark)}`);
  assert.deepEqual(since.json.items.map((x) => x.id).sort(), [ids[1], fresh.json.id].sort());
  assert.deepEqual(since.json.removed, [ids[3]]);
  assert.equal(since.json.items.find((x) => x.id === ids[1]).version, 2);

  // since + paging: removed comes with the first page; next keeps since
  const p1 = await w.shared('GET', `/v1/index?since=${encodeURIComponent(mark)}&limit=1`);
  assert.equal(p1.json.items.length, 1);
  assert.deepEqual(p1.json.removed, [ids[3]]);
  assert.match(p1.json.next, /since=/);
  const p2 = await w.shared('GET', p1.json.next);
  assert.equal(p2.json.items.length, 1);
  assert.equal(p2.json.removed, undefined);
  assert.equal(p2.json.next, null);

  assert.equal((await w.shared('GET', '/v1/index?since=yesterday')).status, 400);
  const later = await w.shared('GET', `/v1/index?since=${encodeURIComponent(new Date(w.now() + 1).toISOString())}`);
  assert.deepEqual([later.json.items, later.json.removed], [[], []]);
});

test('index paging is stable across items with the same updated time', async () => {
  const w = world(), keys = [newKey(), newKey(), newKey(), newKey()];
  for (const k of keys) await w.shared('POST', '/v1/items', { key: k, body: item() });
  const ids = [];
  let next = '/v1/index?limit=1';
  while (next) { const r = await w.shared('GET', next); ids.push(...r.json.items.map((x) => x.id)); next = r.json.next; }
  assert.equal(new Set(ids).size, 4);
});

test('search: ranked, by kind, at most 50', async () => {
  const w = world(), k = newKey();
  await w.shared('POST', '/v1/items', { key: k, body: item({ name: 'chart', title: 'Bar chart', description: 'draws bars', path: ['viz'] }) });
  await w.shared('POST', '/v1/items', { key: k, body: item({ name: 'pieChart', title: 'Pie', description: 'a round chart', path: ['viz'] }) });
  await w.shared('POST', '/v1/items', { key: k, body: item({ name: 'table', title: 'Table', description: 'rows; can chart too', path: ['data'] }) });
  await w.shared('POST', '/v1/items', { key: k, body: item({ kind: 'util', name: 'chart', title: 'Chart util', path: [] }) });
  const r = await w.shared('GET', '/v1/search?q=chart');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((x) => x.name), ['chart', 'chart', 'pieChart', 'table']);
  const comp = await w.shared('GET', '/v1/search?q=chart&kind=component');
  assert.deepEqual(comp.json.items.map((x) => x.name), ['chart', 'pieChart', 'table']);
  assert.deepEqual((await w.shared('GET', '/v1/search?q=viz%20bars')).json.items.map((x) => x.name), ['chart']);
  assert.deepEqual((await w.shared('GET', '/v1/search?q=nothing')).json.items, []);
  assert.equal((await w.shared('GET', '/v1/search')).status, 400);
  assert.equal((await w.shared('GET', '/v1/search?q=x&kind=bad')).status, 400);
  for (let i = 0; i < 60; i++) await w.shared('POST', '/v1/items', { key: k, body: item({ name: `many${i}`, title: 'many' }) });
  assert.equal((await w.shared('GET', '/v1/search?q=many')).json.items.length, 50);
});

test('withdraw: author only; leaves the index; a new share starts over', async () => {
  const w = world(), a = newKey(), b = newKey();
  const x = (await w.shared('POST', '/v1/items', { key: a, body: item() })).json;
  assert.equal((await w.shared('DELETE', `/v1/items/${x.id}`, { key: b })).status, 403);
  assert.equal((await w.shared('DELETE', `/v1/items/${x.id}`)).status, 401);
  const d = await w.shared('DELETE', `/v1/items/${x.id}`, { key: a });
  assert.equal(d.status, 200);
  assert.equal(d.json.id, x.id);
  assert.equal((await w.shared('DELETE', `/v1/items/${x.id}`, { key: a })).status, 404);
  assert.equal((await w.shared('GET', `/v1/items/${x.id}`)).status, 404);
  assert.equal((await w.shared('GET', `/v1/items/${x.id}/payload`)).status, 404);
  assert.equal((await w.shared('POST', `/v1/items/${x.id}/adopted`, { key: b })).status, 404);
  assert.deepEqual((await w.shared('GET', '/v1/index')).json.items, []);
  const again = await w.shared('POST', '/v1/items', { key: a, body: item() });
  assert.equal(again.status, 201);
  assert.notEqual(again.json.id, x.id);
  assert.equal(again.json.version, 1);
});

test('adoptions count once per app id', async () => {
  const w = world(), a = newKey(), b = newKey(), c = newKey();
  const x = (await w.shared('POST', '/v1/items', { key: a, body: item() })).json;
  assert.equal((await w.shared('POST', `/v1/items/${x.id}/adopted`, { key: b })).json.adoptions, 1);
  w.advance(1);
  assert.equal((await w.shared('POST', `/v1/items/${x.id}/adopted`, { key: b })).json.adoptions, 1);
  assert.equal((await w.shared('POST', `/v1/items/${x.id}/adopted`, { key: c })).json.adoptions, 2);
  assert.equal((await w.shared('GET', `/v1/items/${x.id}`)).json.adoptions, 2);
  assert.equal((await w.shared('POST', `/v1/items/${x.id}/adopted`)).status, 401);
});

test('reports from 3 different app ids hide the item', async () => {
  const w = world(), author = newKey(), r1 = newKey(), r2 = newKey(), r3 = newKey();
  const x = (await w.shared('POST', '/v1/items', { key: author, body: item({ name: 'evil', title: 'Evil kit' }) })).json;
  const mark = new Date(w.now()).toISOString();
  w.advance(1000);
  const report = (k, reason = 'malicious: posts the keychain') => w.shared('POST', `/v1/items/${x.id}/report`, { key: k, body: { reason } });
  assert.equal((await w.shared('POST', `/v1/items/${x.id}/report`, { key: r1, body: {} })).status, 400);
  assert.equal((await report(r1, 'r'.repeat(1001))).status, 413);
  assert.deepEqual((await report(r1)).json, { id: x.id, reports: 1, hidden: false });
  w.advance(1);
  assert.deepEqual((await report(r1)).json, { id: x.id, reports: 1, hidden: false }, 'same reporter counts once');
  assert.deepEqual((await report(r2)).json, { id: x.id, reports: 2, hidden: false });
  assert.equal((await w.shared('GET', '/v1/index')).json.items.length, 1);
  assert.deepEqual((await report(r3)).json, { id: x.id, reports: 3, hidden: true });
  assert.deepEqual((await w.shared('GET', '/v1/index')).json.items, []);
  assert.deepEqual((await w.shared('GET', '/v1/search?q=evil')).json.items, []);
  assert.equal((await w.shared('GET', `/v1/items/${x.id}`)).status, 404);
  assert.equal((await w.shared('GET', `/v1/items/${x.id}/payload`)).status, 404);
  assert.deepEqual((await w.shared('GET', `/v1/index?since=${mark}`)).json.removed, [x.id]);
  // a new version by the author stays hidden; the author can still withdraw it
  w.advance(1000);
  const v2 = await w.shared('POST', '/v1/items', { key: author, body: item({ name: 'evil', title: 'Evil kit', description: 'now innocent' }) });
  assert.equal(v2.json.version, 2);
  assert.deepEqual((await w.shared('GET', '/v1/index')).json.items, []);
  assert.equal((await w.shared('DELETE', `/v1/items/${x.id}`, { key: author })).status, 200);
});

test('rate limits: writes per app id, public reads per IP', async () => {
  const w = world({ writesPerHour: 3, readsPerHour: 4 }), k = newKey(), other = newKey();
  for (let i = 0; i < 3; i++) assert.equal((await w.shared('POST', '/v1/items', { key: k, body: item({ name: `w${i}` }) })).status, 201);
  const limited = await w.shared('POST', '/v1/items', { key: k, body: item({ name: 'w3' }) });
  assert.equal(limited.status, 429);
  assert.ok(limited.json.error);
  assert.equal((await w.users('PUT', '/v1/profile', { key: k, body: { name: 'x' } })).status, 429, 'one budget across both hosts');
  assert.equal((await w.shared('POST', '/v1/items', { key: other, body: item() })).status, 201);
  w.advance(3600_000);
  assert.equal((await w.shared('POST', '/v1/items', { key: k, body: item({ name: 'w3' }) })).status, 201);

  for (let i = 0; i < 4; i++) assert.equal((await w.shared('GET', '/v1/index', { ip: '1.2.3.4' })).status, 200);
  assert.equal((await w.shared('GET', '/v1/index', { ip: '1.2.3.4' })).status, 429);
  assert.equal((await w.users('GET', '/v1/find?q=x', { ip: '1.2.3.4' })).status, 429);
  assert.equal((await w.shared('GET', '/v1/index', { ip: '5.6.7.8' })).status, 200);
});

test('routing: unknown paths, methods, hosts; CORS', async () => {
  const w = world();
  assert.equal((await w.shared('GET', '/v1/nothing')).status, 404);
  assert.equal((await w.shared('PUT', '/v1/index')).status, 405);
  assert.equal((await w.users('GET', '/v1/index')).status, 404, 'the index is on shared only');
  assert.equal((await w.call('www', 'GET', '/v1/index')).status, 404);
  const o = await w.shared('OPTIONS', '/v1/items');
  assert.equal(o.status, 204);
  assert.equal(o.headers['access-control-allow-origin'], '*');
  assert.match(o.headers['access-control-allow-headers'], /x-aiui-signature/);
  const e = await w.shared('GET', '/v1/items/%E0%A4%A');
  assert.equal(e.status, 400);
  assert.equal(e.headers['cache-control'], 'no-store');
});
