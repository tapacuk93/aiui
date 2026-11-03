import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { world, newKey, item } from './helpers.mjs';
import { startMockGitHub } from '../mock-github.mjs';
import { githubClient } from '../src/github.mjs';
import { runMirror, itemDirs } from '../src/mirror.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MIN = 60_000;

async function setup() {
  const w = world(), gh = await startMockGitHub({ token: 'tok', repo: 'tapacuk93/aiui-shared' });
  const client = githubClient({ token: 'tok', repo: gh.repo, apiUrl: gh.url });
  const mirror = (force = false) => runMirror({ store: w.store, github: client, branch: 'main', now: w.now, force });
  return { w, gh, mirror };
}

test('the mirror writes the tree as one commit, and skips unchanged runs', async (t) => {
  const { w, gh, mirror } = await setup();
  t.after(() => gh.close());
  const a = newKey(), b = newKey();
  await w.users('PUT', '/v1/profile', { key: a, body: { name: 'Ann' } });
  const comp = (await w.shared('POST', '/v1/items', { key: a, body: item() })).json;
  const applet = (await w.shared('POST', '/v1/items', { key: b, body: item({ kind: 'applet', name: 'chess', path: ['games'], payload: { kind: 'html', html: '<b>chess</b>' } }) })).json;
  const util = (await w.shared('POST', '/v1/items', { key: b, body: item({ kind: 'util', name: 'fmt', path: [], payload: { code: 'export const fmt = (x) => String(x)' } }) })).json;

  const r = await mirror(true);
  assert.equal(r.status, 'committed');
  assert.equal(r.message, 'Shared: +3 updated 0 removed 0');
  assert.deepEqual(gh.log(), ['Shared: +3 updated 0 removed 0', 'Initialize the mirror']);
  const files = gh.files();
  assert.deepEqual([...files.keys()].sort(), [
    'README.md', 'applet/games/chess/meta.json', 'applet/games/chess/payload.json',
    'component/games/core/gameKit/code.js', 'component/games/core/gameKit/meta.json', 'component/games/core/gameKit/payload.json',
    'index.json', 'util/fmt/code.js', 'util/fmt/meta.json', 'util/fmt/payload.json',
  ]);
  const meta = JSON.parse(files.get('component/games/core/gameKit/meta.json'));
  assert.deepEqual(meta, (await w.shared('GET', `/v1/items/${comp.id}`)).json);
  assert.equal(meta.authorName, 'Ann');
  assert.equal(sha(files.get('component/games/core/gameKit/payload.json')), meta.sha256);
  assert.deepEqual(files.get('component/games/core/gameKit/payload.json'), (await w.shared('GET', `/v1/items/${comp.id}/payload`)).body);
  assert.equal(files.get('component/games/core/gameKit/code.js').toString(), item().payload.code);
  assert.equal(sha(files.get('applet/games/chess/payload.json')), applet.sha256);
  assert.equal(files.get('util/fmt/code.js').toString(), 'export const fmt = (x) => String(x)');
  const index = JSON.parse(files.get('index.json'));
  const api = (await w.shared('GET', '/v1/index')).json;
  assert.deepEqual(index.items, api.items);
  assert.equal(index.next, null);
  assert.equal(index.generated, util.updated, 'stable: the latest change, not the run time');
  const readme = files.get('README.md').toString();
  assert.match(readme, /Live items: 3 \(components 1, utilities 1, applets 1\)/);
  assert.match(readme, /`games\/core\/gameKit` v1 - Game kit - by Ann/);

  // nothing changed: no commit, and not even a GitHub call
  const calls = gh.calls.length;
  w.advance(7 * 3600_000);
  assert.equal((await mirror()).status, 'unchanged');
  assert.equal((await mirror(true)).status, 'unchanged');
  assert.equal(gh.calls.length, calls);
  assert.equal(gh.log().length, 2);

  // a forgotten fingerprint: compares with the branch, still no commit
  await w.store.setMeta('mirror', null);
  assert.equal((await mirror(true)).status, 'unchanged');
  assert.equal(gh.log().length, 2);

  // a version, a withdrawal, a hidden item and a new one: one commit
  w.advance(MIN);
  await w.shared('POST', '/v1/items', { key: a, body: item({ description: 'v2' }) });
  await w.shared('DELETE', `/v1/items/${util.id}`, { key: b });
  for (let i = 0; i < 3; i++) await w.shared('POST', `/v1/items/${applet.id}/report`, { key: newKey(), body: { reason: 'broken' } });
  await w.shared('POST', '/v1/items', { key: b, body: item({ name: 'newOne', path: [] }) });
  const r2 = await mirror(true);
  assert.equal(r2.message, 'Shared: +1 updated 1 removed 2');
  assert.deepEqual([...gh.files().keys()].sort(), [
    'README.md', 'component/games/core/gameKit/code.js', 'component/games/core/gameKit/meta.json',
    'component/games/core/gameKit/payload.json', 'component/newOne/code.js', 'component/newOne/meta.json',
    'component/newOne/payload.json', 'index.json',
  ]);
  assert.equal(JSON.parse(gh.files().get('component/games/core/gameKit/meta.json')).version, 2);
  assert.equal(gh.log().length, 3);
});

test('the schedule: settle 15 minutes after a burst, or every 6 hours', async (t) => {
  const { w, gh, mirror } = await setup();
  t.after(() => gh.close());
  const k = newKey();
  assert.equal((await mirror()).status, 'committed', 'the first run is always due');
  w.advance(MIN);
  assert.equal((await mirror()).status, 'not-due');
  await w.shared('POST', '/v1/items', { key: k, body: item() });
  w.advance(10 * MIN);
  await w.shared('POST', `/v1/items/${(await w.shared('GET', '/v1/index')).json.items[0].id}/adopted`, { key: newKey() });
  w.advance(10 * MIN);
  assert.equal((await mirror()).status, 'not-due', 'the burst has not settled for 15 minutes');
  w.advance(5 * MIN);
  const r = await mirror();
  assert.equal(r.status, 'committed');
  assert.equal(r.message, 'Shared: +1 updated 0 removed 0');
  w.advance(5 * 3600_000);
  assert.equal((await mirror()).status, 'not-due');
  w.advance(3600_000);
  assert.equal((await mirror()).status, 'unchanged', '6 hours: runs, finds nothing new');
});

test('a lazy GitHub connection is opened only when there is something to compare', async (t) => {
  const { w, gh } = await setup();
  t.after(() => gh.close());
  let opened = 0;
  const connect = async () => { opened++; return githubClient({ token: 'tok', repo: gh.repo, apiUrl: gh.url }); };
  const run = () => runMirror({ store: w.store, github: connect, repo: gh.repo, now: w.now });
  assert.equal((await run()).status, 'committed');
  assert.equal(opened, 1);
  w.advance(MIN);
  assert.equal((await run()).status, 'not-due');
  w.advance(7 * 3600_000);
  assert.equal((await run()).status, 'unchanged');
  assert.equal(opened, 1);
});

test('a wrong token fails loudly and leaves the state for the next run', async (t) => {
  const { w, gh } = await setup();
  t.after(() => gh.close());
  const bad = githubClient({ token: 'nope', repo: gh.repo, apiUrl: gh.url });
  await assert.rejects(runMirror({ store: w.store, github: bad, now: w.now }), /401/);
  assert.equal(await w.store.getMeta('mirror'), null);
});

test('same kind+path+name from two authors: the later one gets a suffix', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const x = (id, author, created) => ({ id, author, created, kind: 'util', path: ['p'], name: 'n' });
  const dirs = itemDirs([x('2', b, '2026-02-01'), x('1', a, '2026-01-01'), { ...x('3', b, '2026-01-01'), name: 'm' }]);
  assert.equal(dirs.get('1'), 'util/p/n');
  assert.equal(dirs.get('2'), `util/p/n.${'b'.repeat(12)}`);
  assert.equal(dirs.get('3'), 'util/p/m');
});
