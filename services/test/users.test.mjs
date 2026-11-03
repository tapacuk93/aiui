import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, newKey } from './helpers.mjs';

const DAY = 86400_000;

test('profiles: create, update, validate', async () => {
  const w = world(), k = newKey();
  const put = (body) => w.users('PUT', '/v1/profile', { key: k, body });
  const r = await put({ name: '  Taras  ', handle: 'taras', about: 'builds things', findable: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: k.id, name: 'Taras', handle: 'taras', about: 'builds things', findable: true, updated: '2026-11-03T12:00:00.000Z' });
  for (const bad of [{}, { name: '' }, { name: 'x'.repeat(61) }, { name: 'a', handle: 'ab' }, { name: 'a', handle: 'Taras' },
    { name: 'a', handle: 'x'.repeat(31) }, { name: 'a', handle: 'a b c' }, { name: 'a', about: 'x'.repeat(281) }, { name: 'a', findable: 'yes' }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await put({ name: 'x'.repeat(60), handle: 'a_b-9', about: 'y'.repeat(280) })).status, 200);
  const p = await w.store.getProfile(k.id);
  assert.equal(p.findable, true, 'findable kept when not given');
  assert.equal((await w.users('PUT', '/v1/profile', { body: { name: 'x' } })).status, 401);
});

test('handles are unique; changing or deleting frees them', async () => {
  const w = world(), a = newKey(), b = newKey();
  assert.equal((await w.users('PUT', '/v1/profile', { key: a, body: { name: 'A', handle: 'alpha' } })).status, 200);
  assert.equal((await w.users('PUT', '/v1/profile', { key: b, body: { name: 'B', handle: 'alpha' } })).status, 409);
  assert.equal((await w.users('PUT', '/v1/profile', { key: a, body: { name: 'A', handle: 'alpha' } })).status, 200, 'keeping your own');
  assert.equal((await w.users('PUT', '/v1/profile', { key: a, body: { name: 'A', handle: 'alef' } })).status, 200);
  assert.equal((await w.users('PUT', '/v1/profile', { key: b, body: { name: 'B', handle: 'alpha' } })).status, 200);
  assert.equal((await w.users('PUT', '/v1/profile', { key: b, body: { name: 'B', handle: 'alef' } })).status, 409);
  assert.equal((await w.users('DELETE', '/v1/profile', { key: a })).status, 200);
  assert.equal((await w.users('PUT', '/v1/profile', { key: b, body: { name: 'B', handle: 'alef' } })).status, 200);
  assert.equal((await w.users('PUT', '/v1/profile', { key: a, body: { name: 'A', handle: 'alpha' } })).status, 200, 'b moved off alpha');
  assert.equal((await w.users('PUT', '/v1/profile', { key: a, body: { name: 'A', handle: '' } })).status, 200);
  assert.equal((await w.users('PUT', '/v1/profile', { key: b, body: { name: 'B', handle: 'alpha' } })).status, 200, 'cleared handle is free');
});

test('public profiles: findable only', async () => {
  const w = world(), a = newKey(), b = newKey();
  await w.users('PUT', '/v1/profile', { key: a, body: { name: 'Ann', findable: true } });
  await w.users('PUT', '/v1/profile', { key: b, body: { name: 'Bob' } });
  assert.equal((await w.users('GET', `/v1/profiles/${a.id}`)).json.name, 'Ann');
  assert.equal((await w.users('GET', `/v1/profiles/${b.id}`)).status, 404);
  assert.equal((await w.users('GET', `/v1/profiles/${newKey().id}`)).status, 404);
  assert.equal((await w.users('GET', '/v1/profiles/xyz')).status, 400);
  assert.equal((await w.users('GET', `/v1/profiles/${b.id}`, { key: b })).status, 200, 'yourself');
  assert.equal((await w.users('GET', `/v1/profiles/${b.id}`, { key: a })).status, 404, 'not mutual');
});

test('find: handle exact first, then names; ids only when findable', async () => {
  const w = world();
  const mk = async (name, handle, findable = true) => {
    const k = newKey();
    await w.users('PUT', '/v1/profile', { key: k, body: { name, ...(handle ? { handle } : {}), findable } });
    return k;
  };
  const anna = await mk('Anna Smith', 'ann');
  await mk('Annabel', 'annabel');
  await mk('Joanna', null);
  const hidden = await mk('Ann Hidden', 'ann-hidden', false);
  const r = await w.users('GET', '/v1/find?q=ann');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.profiles.map((p) => p.name), ['Anna Smith', 'Annabel', 'Joanna']);
  assert.equal(r.json.profiles[0].id, anna.id);
  assert.deepEqual((await w.users('GET', '/v1/find?q=@annabel')).json.profiles.map((p) => p.name), ['Annabel']);
  assert.deepEqual((await w.users('GET', '/v1/find?q=SMITH')).json.profiles.map((p) => p.name), ['Anna Smith']);
  assert.deepEqual((await w.users('GET', '/v1/find?q=hidden')).json.profiles, []);
  assert.equal((await w.users('GET', `/v1/find?q=${anna.id}`)).json.profiles[0].id, anna.id);
  assert.equal((await w.users('GET', `/v1/find?q=${hidden.id}`)).status, 404);
  assert.equal((await w.users('GET', `/v1/find?q=${newKey().id}`)).status, 404);
  assert.equal((await w.users('GET', '/v1/find')).status, 400);
  for (let i = 0; i < 25; i++) await mk(`Many ${i}`, `many${i}`);
  assert.equal((await w.users('GET', '/v1/find?q=many')).json.profiles.length, 20);
});

test('contacts and the router: incoming, mutual, inbox, removed', async () => {
  const w = world(), a = newKey(), b = newKey();
  await w.users('PUT', '/v1/profile', { key: a, body: { name: 'Ann', findable: false } });
  await w.users('PUT', '/v1/profile', { key: b, body: { name: 'Bob', findable: false } });
  const contacts = async (k) => (await w.users('GET', '/v1/contacts', { key: k })).json.contacts;
  const inbox = async (k) => (await w.users('GET', '/v1/router/inbox', { key: k })).json;

  assert.equal((await w.users('POST', '/v1/contacts', { key: a, body: { id: a.id } })).status, 400);
  assert.equal((await w.users('POST', '/v1/contacts', { key: a, body: { id: 'B' } })).status, 400);
  assert.equal((await w.users('POST', '/v1/contacts', { key: a, body: { id: b.id, note: 'n'.repeat(281) } })).status, 400);

  const add = await w.users('POST', '/v1/contacts', { key: a, body: { id: b.id, note: 'met at the lab' } });
  assert.equal(add.status, 201);
  assert.deepEqual(add.json, { id: b.id, state: 'pending', added: '2026-11-03T12:00:00.000Z', note: 'met at the lab' });
  assert.deepEqual(await contacts(a), [{ id: b.id, state: 'pending', added: '2026-11-03T12:00:00.000Z', note: 'met at the lab' }]);
  assert.deepEqual(await contacts(b), [{ id: a.id, state: 'incoming', added: '2026-11-03T12:00:00.000Z', note: 'met at the lab' }],
    'no name: Ann is not findable and not mutual');
  assert.deepEqual(await inbox(b), { events: [{ type: 'incoming', id: a.id, note: 'met at the lab', at: '2026-11-03T12:00:00.000Z' }], more: false });
  assert.deepEqual((await inbox(b)).events, [], 'since the last call');
  assert.equal((await w.users('GET', `/v1/profiles/${a.id}`, { key: b })).status, 404, 'not mutual yet');
  assert.equal((await w.users('POST', '/v1/contacts', { key: a, body: { id: b.id, note: 'updated' } })).status, 200, 'again: updates');
  assert.deepEqual((await inbox(b)).events, [], 'no second incoming event');

  w.advance(60_000);
  const back = await w.users('POST', '/v1/contacts', { key: b, body: { id: a.id } });
  assert.equal(back.status, 201);
  assert.deepEqual(back.json, { id: a.id, state: 'mutual', since: '2026-11-03T12:01:00.000Z', name: 'Ann' });
  assert.deepEqual(await contacts(a), [{ id: b.id, state: 'mutual', since: '2026-11-03T12:01:00.000Z', name: 'Bob', note: 'updated' }]);
  assert.deepEqual((await inbox(a)).events, [{ type: 'mutual', id: b.id, at: '2026-11-03T12:01:00.000Z' }]);
  assert.deepEqual((await inbox(b)).events, [{ type: 'mutual', id: a.id, at: '2026-11-03T12:01:00.000Z' }]);
  assert.equal((await w.users('GET', `/v1/profiles/${a.id}`, { key: b })).json.name, 'Ann', 'mutual contacts see the profile');
  assert.equal((await w.users('GET', `/v1/profiles/${a.id}`)).status, 404, 'still not public');

  w.advance(60_000);
  assert.equal((await w.users('DELETE', `/v1/contacts/${b.id}`, { key: a })).status, 200);
  assert.equal((await w.users('DELETE', `/v1/contacts/${b.id}`, { key: a })).status, 404);
  assert.deepEqual((await inbox(b)).events, [{ type: 'removed', id: a.id, at: '2026-11-03T12:02:00.000Z' }]);
  assert.deepEqual((await contacts(b)).map((c) => c.state), ['pending']);
  assert.deepEqual(await contacts(a), [{ id: b.id, state: 'incoming', added: '2026-11-03T12:01:00.000Z' }]);
  assert.equal((await w.users('GET', `/v1/profiles/${a.id}`, { key: b })).status, 404, 'no longer mutual');
  assert.equal((await w.users('GET', '/v1/router/inbox')).status, 401);
});

test('router events are kept 30 days; the inbox pages by 100', async () => {
  const w = world(), me = newKey();
  for (let i = 0; i < 3; i++) await w.users('POST', '/v1/contacts', { key: newKey(), body: { id: me.id } });
  w.advance(31 * DAY);
  assert.deepEqual((await w.users('GET', '/v1/router/inbox', { key: me })).json.events, []);
  for (let i = 0; i < 105; i++) { await w.users('POST', '/v1/contacts', { key: newKey(), body: { id: me.id } }); w.advance(1); }
  const p1 = (await w.users('GET', '/v1/router/inbox', { key: me })).json;
  assert.equal(p1.events.length, 100);
  assert.equal(p1.more, true);
  const p2 = (await w.users('GET', '/v1/router/inbox', { key: me })).json;
  assert.equal(p2.events.length, 5);
  assert.equal(p2.more, false);
  assert.equal(new Set([...p1.events, ...p2.events].map((e) => e.id)).size, 105);
  assert.equal((await w.users('GET', '/v1/contacts', { key: me })).json.contacts.length, 108);
});

test('deleting the profile removes my contact requests and tells the others', async () => {
  const w = world(), a = newKey(), b = newKey(), c = newKey();
  await w.users('PUT', '/v1/profile', { key: a, body: { name: 'Ann', handle: 'ann', findable: true } });
  await w.users('POST', '/v1/contacts', { key: a, body: { id: b.id } });
  await w.users('POST', '/v1/contacts', { key: b, body: { id: a.id } });
  await w.users('POST', '/v1/contacts', { key: a, body: { id: c.id } });
  await w.users('GET', '/v1/router/inbox', { key: b });
  await w.users('GET', '/v1/router/inbox', { key: c });
  const d = await w.users('DELETE', '/v1/profile', { key: a });
  assert.deepEqual(d.json, { id: a.id, deleted: true, contactsRemoved: 2 });
  assert.equal((await w.users('GET', `/v1/profiles/${a.id}`)).status, 404);
  assert.deepEqual((await w.users('GET', '/v1/find?q=ann')).json.profiles, []);
  assert.deepEqual((await w.users('GET', '/v1/router/inbox', { key: b })).json.events.map((e) => e.type), ['removed']);
  assert.deepEqual((await w.users('GET', '/v1/router/inbox', { key: c })).json.events.map((e) => e.type), ['removed']);
  assert.deepEqual((await w.users('GET', '/v1/contacts', { key: c })).json.contacts, []);
  assert.deepEqual((await w.users('GET', '/v1/contacts', { key: b })).json.contacts.map((x) => x.state), ['pending']);
});
