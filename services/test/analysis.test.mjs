import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/analysis.mjs';
import { code } from './helpers.mjs';

const item = (over = {}) => ({ id: 'X', kind: 'component', name: 'thing', path: [], title: 'Thing', description: '', usage: '', uses: [], ...over });
test('taxonomy mapping', () => {
  assert.equal(A.categorize(item({ name: 'gameKit', path: ['games', 'core'] })).id, 'games');
  assert.equal(A.categorize(item({ name: 'barChart', title: 'Bar chart' })).id, 'charts');
  assert.equal(A.categorize(item({ name: 'pomodoroTimer', title: 'Pomodoro' })).id, 'time');
  assert.equal(A.categorize(item({ name: 'markdownEditor' })).id, 'text');
  assert.equal(A.categorize(item({ name: 'zork', title: 'Zork' })).id, A.UNCATEGORIZED);
  assert.ok(A.TAXONOMY.categories.length >= 20);
  for (const c of A.TAXONOMY.categories) assert.ok(c.weight >= 1 && c.weight <= 3 && c.keywords.length && c.examples.length, c.id);
});

test('coverage is weighted by category', () => {
  const cov = A.coverage([{ category: 'files' }, { category: 'files' }, { category: 'games' }, { category: A.UNCATEGORIZED }]);
  const all = A.TAXONOMY.categories.reduce((a, c) => a + c.weight, 0);
  assert.equal(cov.covered, 2);
  assert.equal(cov.counts.files, 2);
  assert.ok(Math.abs(cov.weighted - 4 / all) < 1e-9);
});

test('novel bytes: duplicates and reformatting add ~nothing, new source adds', () => {
  const a = code('alpha'), b = code('bravo');
  assert.ok(A.novelBytes(a) > 400);
  assert.ok(A.novelBytes(a, [a]) < 20, 'the same source again');
  assert.ok(A.novelBytes(a.replace(/ /g, '   ').replace(/\n/g, '\n\n'), [a]) < 20, 'reformatted');
  assert.ok(A.novelBytes(a + '\nexport const x = 1;', [a]) < 40, 'a trivial addition');
  assert.ok(A.novelBytes(b, [a]) > 150, 'different code');
  assert.ok(A.novelBytes(code('charlie', 120)) > A.novelBytes(code('charlie', 20)), 'more source, more value');
  assert.equal(A.similarity(A.signature(a), A.signature(a)), 1);
  assert.ok(A.similarity(A.signature(a), A.signature(b)) < 0.3);
  assert.ok(A.similarity(A.signature(a), A.signature(a + '\nexport const x = 1;')) > 0.9);
});

test('value: duplicate 0, new category beats the same category, docs and uses count', () => {
  const base = { novel: 1024, duplicateOf: null, liveIds: new Set(['U1', 'U2']), tests: false };
  const counts = { games: 3, time: 0 };
  const dup = A.itemValue({ ...base, item: item(), category: 'games', countsBefore: counts, duplicateOf: 'Y' });
  assert.equal(dup.value, 0);
  const same = A.itemValue({ ...base, item: item(), category: 'games', countsBefore: counts });
  const fresh = A.itemValue({ ...base, item: item(), category: 'time', countsBefore: counts });
  assert.ok(fresh.value > same.value);
  assert.equal(fresh.value - same.value, 15 * 3);
  assert.equal(same.value, Math.round(10 * Math.log2(3) * 0.5 * 100) / 100, 'source only, undocumented: x0.5');
  const documented = A.itemValue({ ...base, item: item({ description: 'd'.repeat(40), usage: 'u'.repeat(20), uses: ['U1', 'U2', 'nope'] }), category: 'games', countsBefore: counts, tests: true });
  assert.equal(documented.terms.find((t) => t.term === 'source').value, Math.round(10 * Math.log2(3) * 1.1 * 100) / 100);
  assert.equal(documented.terms.find((t) => t.term === 'builds on').value, 4);
  const second = A.itemValue({ ...base, item: item(), category: 'time', countsBefore: { time: 1 } });
  assert.equal(second.terms.find((t) => t.term === 'coverage').value, 9, 'deepening: 3 x weight');
  const trivial = A.itemValue({ ...base, novel: 10, item: item(), category: 'games', countsBefore: counts, previousCategory: 'games' });
  assert.ok(trivial.value < 0.2);
  assert.equal(trivial.terms.length, 1, 'an update in the same category earns no coverage');
});

test('maturity index and versions', () => {
  assert.equal(A.maturityIndex(0), 0);
  assert.equal(A.maturityIndex(1000), 50);
  assert.ok(A.maturityIndex(9000) > 89 && A.maturityIndex(9000) < 100);
  assert.deepEqual(A.nextVersion('0.0.0', 3, 0.1).version, '0.0.1');
  assert.deepEqual(A.nextVersion('0.0.1', 25, 0.1).version, '0.1.0');
  assert.deepEqual(A.nextVersion('0.4.2', 1, 0.26).version, '1.0.0');
  assert.deepEqual(A.nextVersion('1.0.0', -10, 0.2).version, '1.0.1', 'a lower coverage never lowers MAJOR');
  assert.deepEqual(A.nextVersion('1.2.3', 30, 0.9).version, '3.0.0');
});

test('notes: carried over, addressed, capped', () => {
  const prev = [{ id: 'gap:files', kind: 'gap', text: 'files', since: 1 }, { id: 'docs:X', kind: 'docs', text: 'docs', since: 2 }];
  const open = [{ id: 'gap:files', kind: 'gap', text: 'files' }, ...Array.from({ length: 12 }, (_, i) => ({ id: `tests:${i}`, kind: 'tests', text: `t${i}` }))];
  const c = A.carryNotes(prev, open, 3);
  assert.deepEqual(c.addressed.map((n) => n.id), ['docs:X']);
  assert.deepEqual(c.stillOpen.map((n) => n.id), ['gap:files']);
  assert.equal(c.shown.find((n) => n.id === 'gap:files').since, 1);
  assert.equal(c.shown.filter((n) => n.kind === 'tests').length, 8);
  assert.equal(c.totals.tests, 12);
});
