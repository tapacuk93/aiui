// The in-memory store's own semantics (the handlers' tests cover the common paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/store/memory.mjs';

const live = (id, updated) => ({ id, updated, status: 'live', version: 1 });

test('items: conflicts, withdraw and hide only once, counters on missing items', async () => {
  const s = createMemoryStore();
  await s.createItem(live('A', 'T1'), 'k1');
  await assert.rejects(s.createItem(live('A', 'T1'), 'k2'), { status: 409 });
  await assert.rejects(s.createItem(live('B', 'T1'), 'k1'), { status: 409 });
  await assert.rejects(s.saveVersion({ ...live('Z', 'T1'), version: 2 }, 1), { status: 409 }, 'no such item');
  await assert.rejects(s.saveVersion({ ...live('A', 'T2'), version: 3 }, 2), { status: 409 }, 'not the version it was based on');
  await s.saveVersion({ ...live('A', 'T2'), version: 2 }, 1);
  assert.equal((await s.getItem('A')).version, 2);
  assert.equal(await s.hideItem('A', 'T3'), true);
  assert.equal(await s.hideItem('A', 'T4'), false, 'already hidden');
  assert.equal(await s.hideItem('Z', 'T4'), false);
  assert.equal(await s.withdrawItem('A', 'k1', 'T5'), true);
  assert.equal(await s.withdrawItem('A', 'k1', 'T6'), false);
  assert.equal(await s.withdrawItem('Z', 'k9', 'T6'), false);
  assert.equal(await s.findItemByKey('k1'), null, 'a withdrawn item frees its key');
  await assert.rejects(s.saveVersion({ ...live('A', 'T7'), version: 3 }, 2), { status: 409 }, 'withdrawn');
  assert.equal(await s.bump('Z', 'adoptions'), null);
  assert.equal(await s.getItem('Z'), null);
});

test('items: live ones newest first (ties by id), removed ones newest first', async () => {
  const s = createMemoryStore();
  for (const [id, u] of [['A', 'T1'], ['C', 'T2'], ['B', 'T2'], ['D', 'T2'], ['E', 'T0']]) await s.createItem(live(id, u), id);
  assert.deepEqual((await s.allLive()).map((x) => x.id), ['D', 'C', 'B', 'A', 'E']);
  await s.withdrawItem('A', 'A', '2026-01-01');
  await s.hideItem('C', '2026-03-01');
  await s.withdrawItem('E', 'E', '2026-02-01');
  assert.deepEqual(await s.listRemoved('2025-12-31'), ['C', 'E', 'A']);
  assert.deepEqual(await s.listRemoved('2026-01-15'), ['C', 'E']);
});

test('payloads: missing ones are null, in memory and in a directory', async (t) => {
  assert.equal(await createMemoryStore().getPayload('nope'), null);
  const dir = mkdtempSync(join(tmpdir(), 'aiui-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = createMemoryStore({ dir });
  assert.equal(await s.getPayload('nope'), null);
  await s.putPayload('abc', Buffer.from('{"x":1}'));
  assert.deepEqual(await createMemoryStore({ dir }).getPayload('abc'), Buffer.from('{"x":1}'), 'read back from the directory');
});

test('router events: none yet, then in key order, unexpired, after a cursor', async () => {
  let t = 1000_000;
  const s = createMemoryStore({ now: () => t });
  assert.deepEqual(await s.listEvents('O', null, 10), []);
  for (const sk of ['b', 'a', 'c']) await s.addEvent('O', { sk, expires: 2000 });
  await s.addEvent('O', { sk: 'old', expires: 999 });
  assert.deepEqual((await s.listEvents('O', null, 10)).map((e) => e.sk), ['a', 'b', 'c']);
  assert.deepEqual((await s.listEvents('O', 'a', 1)).map((e) => e.sk), ['b']);
  t = 2000_000;
  assert.deepEqual(await s.listEvents('O', null, 10), [], 'all expired');
});
