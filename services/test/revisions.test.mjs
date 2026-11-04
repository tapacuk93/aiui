import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { world, newKey, item, code } from './helpers.mjs';
import { startMockGitHub } from '../mock-github.mjs';
import { githubClient } from '../src/github.mjs';
import { runRevisions, itemDirs } from '../src/mirror.mjs';
import { createReviewer } from '../src/review.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MIN = 60_000;
const documented = { description: 'A reusable building block that does one thing well.', usage: 'lib.thing(el, options) -> handle' };

async function setup(t) {
  const w = world(), gh = await startMockGitHub({ token: 'tok', repo: 'tapacuk93/aiui-shared' });
  t.after(() => gh.close());
  const client = githubClient({ token: 'tok', repo: gh.repo, apiUrl: gh.url });
  const notified = [];
  const run = (o = {}) => runRevisions({ store: w.store, github: client, now: w.now, notify: async (s) => notified.push(s), ...o });
  const share = async (key, over) => {
    const r = await w.shared('POST', '/v1/items', { key, body: item({ uses: [], libs: [], path: [], description: '', usage: '', ...over }) });
    assert.ok(r.status === 201 || r.status === 200, r.text);
    return r.json;
  };
  const md = (n) => gh.files().get(`revisions/r${n}.md`)?.toString();
  return { w, gh, client, run, share, notified, md };
}

test('one revision per added item: a commit, tags r<N> and v<version>, revision files', async (t) => {
  const { w, gh, run, share, md } = await setup(t);
  const a = newKey(), b = newKey();
  await w.users('PUT', '/v1/profile', { key: a, body: { name: 'Ann' } });
  const game = await share(a, { name: 'gameKit', path: ['games', 'core'], title: 'Game kit', payload: { code: code('game') }, ...documented });
  w.advance(1000);
  const chart = await share(b, { name: 'barChart', path: ['viz'], title: 'Bar chart', payload: { code: code('chart') } });
  w.advance(1000);
  const fmt = await share(b, { kind: 'util', name: 'fmt', path: [], title: 'Number formatting', payload: { code: code('fmt', 10) } });
  w.advance(2 * MIN);

  const r = await run();
  assert.equal(r.status, 'committed');
  assert.deepEqual(r.revisions.map((x) => x.n), [1, 2, 3]);
  const log = gh.log();
  assert.equal(log.length, 4);
  assert.match(log[3], /^Initialize/);
  assert.match(log[2], /^r1 v0\.\d+\.\d+: added component\/games\/core\/gameKit \(value \+[\d.]+, maturity [\d.]+\)/);
  assert.match(log[1], /^r2 .*added component\/viz\/barChart/);
  assert.match(log[0], /^r3 .*added util\/fmt/);
  for (const x of r.revisions) {
    assert.equal(gh.tags.get(`r${x.n}`), x.commit);
    assert.equal(gh.tags.get(`v${x.version}`), x.commit);
  }
  assert.equal(new Set(r.revisions.map((x) => x.version)).size, 3, 'every revision has its own version');

  // each revision commit holds the collection as of that change
  const at1 = gh.filesAt(gh.tags.get('r1'));
  assert.ok(at1.has('component/games/core/gameKit/payload.json'));
  assert.ok(!at1.has('component/viz/barChart/meta.json'));
  assert.ok(at1.has('revisions/r1.md') && !at1.has('revisions/r2.md'));

  const files = gh.files();
  for (const f of ['README.md', 'TAXONOMY.json', 'COLLECTION.json', 'REVISIONS.md', 'index.json', 'revisions/r1.md', 'revisions/r2.md', 'revisions/r3.md',
    'component/games/core/gameKit/code.js', 'component/viz/barChart/meta.json', 'util/fmt/payload.json']) assert.ok(files.has(f), f);
  assert.equal(sha(files.get('component/games/core/gameKit/payload.json')), game.sha256);
  assert.equal(files.get('util/fmt/code.js').toString(), code('fmt', 10));
  const revs = files.get('REVISIONS.md').toString();
  assert.ok(revs.indexOf('[r3]') < revs.indexOf('[r2]') && revs.indexOf('[r2]') < revs.indexOf('[r1]'), 'newest first');

  const col = JSON.parse(files.get('COLLECTION.json'));
  assert.equal(col.revision, 3);
  assert.equal(col.items[game.id].category, 'games');
  assert.equal(col.items[chart.id].category, 'charts');
  assert.equal(col.items[fmt.id].category, 'utilities');
  assert.equal(col.coverage.covered, 3);
  assert.equal(col.coverage.categories.find((c) => c.id === 'games').items, 1);
  assert.match(files.get('README.md').toString(), /How value and maturity are measured/);
  assert.match(files.get('README.md').toString(), /coverage \d+\.\d% \(3 of 25 categories\)/);

  const r1 = md(1);
  assert.match(r1, /## Change\n\n- \*\*added\*\* component `games\/core\/gameKit` v1/);
  assert.match(r1, new RegExp(`author: Ann \\(\`${a.id}\`\\)`));
  assert.match(r1, /## Value: \+/);
  assert.match(r1, /\| source \| \+[\d.]+ \| \d+ new compressed bytes/);
  assert.match(r1, /\| coverage \| \+15 \| first item in Games/);
  assert.match(r1, /## Coverage\n\n- before 0\.0% \(0 of 25 categories\) -> after/);
  assert.match(r1, /newly covered: Games/);
  assert.match(r1, /## Notes for the next revision/);
  assert.match(r1, /### Gaps in the taxonomy/);
  assert.match(r1, /### Most valuable next contribution/);

  // nothing new: no run, no commit
  const commits = gh.log().length;
  w.advance(MIN);
  assert.equal((await run()).status, 'nothing');
  assert.equal(gh.log().length, commits);
});

test('a burst settles first, then makes one revision per item, in order', async (t) => {
  const { w, gh, run, share, notified } = await setup(t);
  const k = newKey(), j = newKey();
  await run();                                   // bootstraps an empty collection
  const a1 = await share(k, { name: 'alpha', payload: { code: code('alpha') } });
  w.advance(20_000);
  await share(j, { name: 'bravo', payload: { code: code('bravo') } });
  w.advance(20_000);
  await share(k, { name: 'alpha', payload: { code: code('alpha') + '\nexport const v = 2;' } });
  await share(k, { name: 'alpha', payload: { code: code('alpha') + '\nexport const v = 3;' } });
  w.advance(10_000);
  const early = await run();
  assert.equal(early.status, 'not-settled');
  assert.equal(early.pending, 4);
  assert.deepEqual(notified, [80], 'asks again when the burst will have settled');
  assert.equal(gh.log().length, 0, 'not even the repository is touched');
  w.advance(80_000);
  const r = await run();
  assert.deepEqual(r.revisions.map((x) => x.message.replace(/ \(.*/, '').replace(/v[\d.]+/, 'v')), [
    'r1 v: added component/alpha', 'r2 v: added component/bravo']);
  assert.equal(JSON.parse(gh.files().get('component/alpha/meta.json')).version, 3, 'the last state of the item');
  assert.equal(JSON.parse(gh.files().get('component/alpha/meta.json')).id, a1.id);

  // a never-settling stream is processed after 10 minutes at most
  for (let i = 0; i < 11; i++) { await share(k, { name: `s${i}`, payload: { code: code(`s${i}`, 5) } }); w.advance(MIN); }
  const r2 = await run();
  assert.equal(r2.status, 'committed');
  assert.equal(r2.revisions.length, 11);
});

test('notes for the next revision are carried over and marked addressed', async (t) => {
  const { w, run, share, md } = await setup(t);
  const k = newKey();
  await run();
  const x = await share(k, { name: 'gameKit', path: ['games'], title: 'Game kit', payload: { code: code('game') } });
  w.advance(2 * MIN);
  await run();
  assert.match(md(1), /### Missing usage docs\n\n- component `games\/gameKit` needs a description \(40\+ characters\) and usage/);
  assert.match(md(1), /### Missing tests\n\n- component `games\/gameKit` has no self-tests/);
  assert.match(md(1), /- System and settings has nothing yet \(weight 3\)/);
  assert.match(md(1), /Most value next: a first system and settings item/);

  await share(k, { name: 'gameKit', path: ['games'], title: 'Game kit', payload: { code: code('game') + '\ntest("works", () => assert(gameKitStep1(1, {})));' }, ...documented });
  w.advance(2 * MIN);
  await run();
  const r2 = md(2);
  assert.match(r2, /## Notes from r1/);
  assert.match(r2, /- \[x\] addressed: component `games\/gameKit` needs a description/);
  assert.match(r2, /- \[x\] addressed: component `games\/gameKit` has no self-tests/);
  assert.match(r2, /- \[ \] still open \(since r1\): System and settings has nothing yet/);
  assert.doesNotMatch(r2, /### Missing usage docs/);

  await share(k, { name: 'settingsPanel', path: ['system'], title: 'Settings panel', payload: { code: code('settings') }, ...documented });
  w.advance(2 * MIN);
  await run();
  assert.match(md(3), /- \[x\] addressed: System and settings has nothing yet/);
  assert.match(md(3), /- \[x\] addressed: Most value next: a first system and settings item/);
  assert.match(md(3), /Most value next: a first files and storage item/);
  assert.equal(x.name, 'gameKit');
});

test('value and maturity: duplicates ~0, a new category beats the same category, withdrawal and reports move back', async (t) => {
  const { w, run, share, md, gh } = await setup(t);
  const a = newKey(), b = newKey();
  await run();
  const go = async () => { w.advance(2 * MIN); return (await run()).revisions[0]; };
  await share(a, { name: 'gameKit', path: ['games'], title: 'Game kit', payload: { code: code('game') }, ...documented });
  const r1 = await go();
  await share(b, { name: 'myGameKit', path: ['games'], title: 'Game kit too', payload: { code: code('game').replace(/\n/g, '\n\n') }, ...documented });
  const dup = await go();
  assert.equal(dup.value, 0, 'a reformatted copy adds nothing');
  assert.match(md(2), /\| duplicate \| 0 \| duplicates /);
  assert.match(md(2), /### Duplicates to merge\n\n- component `games\/(my)?[gG]ameKit` and component `games\/(my)?[gG]ameKit` are \d+% alike - merge them into one\./);
  const same = await share(a, { name: 'puzzle', path: ['games'], title: 'Puzzle', payload: { code: code('puzzle') }, ...documented });
  const rSame = await go();
  const fresh = await share(a, { name: 'alarm', path: ['time'], title: 'Alarm clock', payload: { code: code('alarm') }, ...documented });
  const rNew = await go();
  assert.ok(rNew.value > rSame.value + 30, `${rNew.value} vs ${rSame.value}`);
  assert.ok(r1.value > 20 && rSame.value > 10, 'substantial source moves it a lot');
  await share(a, { name: 'alarm', path: ['time'], title: 'Alarm clock', payload: { code: code('alarm') + '\n' }, ...documented, description: documented.description + ' ' });
  const trivial = await go();
  assert.ok(trivial.value >= 0 && trivial.value < 1, `trivial change ${trivial.value}`);
  assert.match(trivial.version, /^0\.\d+\.[1-9]\d*$/, 'a trivial change is a PATCH');
  assert.match(rNew.version, /^0\.\d+\.0$/, 'a new capability is a MINOR');

  const before = JSON.parse(gh.files().get('COLLECTION.json')).maturity.points;
  await w.shared('DELETE', `/v1/items/${fresh.id}`, { key: a });
  const wd = await go();
  assert.equal(wd.value, -(rNew.value + trivial.value), 'withdrawal takes back what the item added');
  const after = JSON.parse(gh.files().get('COLLECTION.json'));
  assert.ok(after.maturity.points < before);
  assert.equal(after.coverage.categories.find((c) => c.id === 'time').items, 0);
  assert.match(md(wd.n), /no longer covered: Calendar, clock and reminders/);
  for (let i = 0; i < 3; i++) await w.shared('POST', `/v1/items/${same.id}/report`, { key: newKey(), body: { reason: 'broken' } });
  const hidden = await go();
  assert.equal(hidden.value, -(rSame.value + 5));
  assert.ok(!gh.files().has('component/games/puzzle/meta.json'));
});

test('adoptions and reports since the previous revision count as usage', async (t) => {
  const { w, run, share, md } = await setup(t);
  const k = newKey();
  await run();
  const x = await share(k, { name: 'notes', path: ['notes'], payload: { code: code('notes') }, ...documented });
  w.advance(2 * MIN); await run();
  for (let i = 0; i < 4; i++) await w.shared('POST', `/v1/items/${x.id}/adopted`, { key: newKey() });
  await w.shared('POST', `/v1/items/${x.id}/report`, { key: newKey(), body: { reason: 'meh' } });
  await share(k, { name: 'todo', path: ['notes'], payload: { code: code('todo') }, ...documented });
  w.advance(2 * MIN); await run();
  assert.match(md(2), /\| usage \| 0 \| 4 adoption\(s\), 1 report\(s\)/);
  assert.equal((await w.store.getState("collection")).items[x.id].meta.adoptions, 4);
});

test('the first run bootstraps the items already live, in creation order', async (t) => {
  const { w, run, share } = await setup(t);
  const k = newKey();
  for (const n of ['one', 'two', 'three']) { await share(k, { name: n, payload: { code: code(n) } }); w.advance(1000); }
  await share(k, { name: 'one', payload: { code: code('one') + '\n// v2' } });
  const r = await run({ force: true });
  assert.deepEqual(r.revisions.map((x) => x.message.split(': ')[1].split(' (')[0]), ['added component/one', 'added component/two', 'added component/three']);
});

test('a run that fails half-way is completed by the next one, without duplicates', async (t) => {
  const { w, gh, client, share } = await setup(t);
  const k = newKey();
  await share(k, { name: 'first', payload: { code: code('first') } });
  w.advance(2 * MIN);
  await runRevisions({ store: w.store, github: client, now: w.now });
  await share(k, { name: 'second', payload: { code: code('second') } });
  await share(k, { name: 'third', payload: { code: code('third') } });
  w.advance(2 * MIN);
  let commits = 0;
  const flaky = { ...client, async createCommit(...a) { if (++commits === 2) throw new Error('GitHub is down'); return client.createCommit(...a); } };
  await assert.rejects(runRevisions({ store: w.store, github: flaky, now: w.now }), /GitHub is down/);
  assert.equal(gh.log().filter((m) => /^r\d/.test(m)).length, 2);
  const r = await runRevisions({ store: w.store, github: client, now: w.now });
  assert.deepEqual(r.revisions.map((x) => x.n), [3]);
  assert.deepEqual(gh.log().filter((m) => /^r\d/.test(m)).map((m) => m.split(' ')[0]), ['r3', 'r2', 'r1']);
});

test('a second run while one holds the lock steps aside and asks to run later', async (t) => {
  const { w, run, notified } = await setup(t);
  assert.equal(await w.store.acquireLock('revisions', 'someone', 900), true);
  assert.equal((await run()).status, 'busy');
  assert.deepEqual(notified, [60]);
});

test('optional AI review: its notes go into the revision, the previous ones go back to it', async (t) => {
  const { w, run, share, md } = await setup(t);
  const k = newKey(), calls = [];
  let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '- Merge the two kits.' }] };
  const fake = { beta: { messages: { create: async (p) => { calls.push(p); return reply; } } }, messages: { create: async (p) => { calls.push({ plain: true, ...p }); return reply; } } };
  const review = createReviewer({ provider: 'anthropic', apiKey: 'k' }, { client: fake });
  await run({ review });
  await share(k, { name: 'gameKit', path: ['games'], payload: { code: code('game') } });
  w.advance(2 * MIN); await run({ review });
  assert.match(md(1), /### Reviewer notes \(AI\)\n\n- Merge the two kits\./);
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].fallbacks, 'default');
  assert.ok(calls[0].messages[0].content.includes(`<source>\n${code('game').slice(0, 40)}`));
  assert.match(calls[0].system, /untrusted user content/);
  reply = { stop_reason: 'refusal', content: [] };
  await share(k, { name: 'other', path: ['games'], payload: { code: code('other') } });
  w.advance(2 * MIN); await run({ review });
  assert.match(calls[1].messages[0].content, /Your notes from the previous revision:\n- Merge the two kits\./);
  assert.doesNotMatch(md(2), /Reviewer notes/);

  const aicoin = createReviewer({ provider: 'aicoin', token: 't' }, { client: fake });
  reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  await share(k, { name: 'third', path: ['games'], payload: { code: code('third') } });
  w.advance(2 * MIN); await run({ review: aicoin });
  assert.equal(calls[2].plain, true);
  assert.equal(calls[2].fallbacks, undefined);
});

test('same kind+path+name from two authors: the later one gets a suffix', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const x = (id, author, created) => ({ id, author, created, kind: 'util', path: ['p'], name: 'n' });
  const dirs = itemDirs([x('2', b, '2026-02-01'), x('1', a, '2026-01-01'), { ...x('3', b, '2026-01-01'), name: 'm' }]);
  assert.equal(dirs.get('1'), 'util/p/n');
  assert.equal(dirs.get('2'), `util/p/n.${'b'.repeat(12)}`);
  assert.equal(dirs.get('3'), 'util/p/m');
});
