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

test('uncategorized items: titled "Uncategorized", weight 0, no coverage term', () => {
  assert.equal(A.categoryTitle(A.UNCATEGORIZED), 'Uncategorized');
  assert.equal(A.categoryWeight(A.UNCATEGORIZED), 0);
  const v = A.itemValue({ item: { kind: 'util', name: 'x', path: [] }, category: A.UNCATEGORIZED, novel: 512, duplicateOf: null, countsBefore: {}, liveIds: new Set(), tests: false });
  assert.deepEqual(v.terms.map((t) => t.term), ['source']);
  assert.equal(v.value, 5, '10 x log2(2) x 0.5 (no docs)');
});

test('builds on: one live shared item, not itself, not a withdrawn one', () => {
  const v = A.itemValue({ item: { id: 'X', kind: 'util', name: 'x', path: [], uses: ['A', 'X', 'GONE'] }, category: 'files', previousCategory: 'files', novel: 0, duplicateOf: null, countsBefore: {}, liveIds: new Set(['A', 'X']), tests: true });
  assert.deepEqual(v.terms.at(-1), { term: 'builds on', value: 2, why: 'uses 1 shared item: 2 each, at most 5' });
  assert.equal(v.terms.length, 2, 'staying in its category earns no coverage again');
});

test('the source of an item: code and css, applet html or its JSON, or the raw bytes', () => {
  assert.equal(A.sourceOf('util', Buffer.from('{"code":"a()","css":".x{}"}')), 'a()\n.x{}');
  assert.equal(A.sourceOf('component', Buffer.from('{"css":".x{}"}')), '\n.x{}');
  assert.equal(A.sourceOf('component', Buffer.from('{"code":"a()"}')), 'a()\n');
  assert.equal(A.sourceOf('applet', Buffer.from('{"kind":"screen","html":"<b>x</b>"}')), '<b>x</b>');
  assert.equal(A.sourceOf('applet', Buffer.from('{"kind":"screen","rows":[1]}')), '{"kind":"screen","rows":[1]}');
  assert.equal(A.sourceOf('util', Buffer.from('not json')), 'not json');
});

test('similarity of empty and very short sources', () => {
  assert.equal(A.novelBytes('  \n '), 0);
  assert.equal(A.novelBytes('const a = 1;', ['', '   ']), A.compressedSize('const a = 1;'), 'blank references are no references');
  assert.equal(A.similarity(A.signature(''), A.signature('')), 1);
  assert.equal(A.similarity(A.signature('a + b'), A.signature('a + b')), 1, 'fewer than 5 tokens: one shingle');
  assert.ok(A.similarity(A.signature('a + b'), A.signature('a - b')) < 0.5);
  assert.equal(A.similarity(null, A.signature('x')), 0);
  assert.equal(A.similarity(A.signature('x'), ''), 0);
  assert.equal(A.pairKey('b', 'a'), 'a|b');
  assert.equal(A.pairKey('a', 'b'), 'a|b');
});

// A collection state for openNotes: entries by id.
const entry = (id, { meta = {}, ...over } = {}) => ({
  meta: { id, kind: 'util', path: [], name: id, created: '2026-01-01', uses: [], adoptions: 0, ...meta },
  category: 'files', docs: { description: true, usage: true }, tests: true, ...over,
});

test('notes: duplicates, building on, items already linked, pairs whose items are gone', () => {
  const items = {
    old: entry('old', { meta: { created: '2026-01-01' } }),
    new: entry('new', { meta: { created: '2026-02-01' } }),
    rel: entry('rel', { meta: { created: '2026-01-15' } }),
    lnk: entry('lnk', { meta: { created: '2026-03-01', uses: ['old'] } }),
    rev: entry('rev', { meta: { created: '2026-04-01' } }),
  };
  items.old.meta.uses = ['rev'];
  const near = { 'new|old': 0.7, 'new|rel': 0.4, 'old|rel': 0.4, 'lnk|old': 0.9, 'gone|old': 0.9, 'old|rev': 0.5 };
  const notes = A.openNotes({ items, near });
  const pairs = notes.filter((n) => n.kind === 'duplicate' || n.kind === 'build-on');
  assert.deepEqual(pairs.map((n) => n.id), ['dup:new|old', 'buildon:new:rel', 'buildon:rel:old'], 'most similar first; equal ones by key; linked and gone pairs skipped');
  assert.match(pairs[0].text, /util `new` and util `old` are 70% alike - merge them into one\./);
  assert.match(pairs[1].text, /util `new` overlaps 40% with util `rel` - build on it/);
  assert.equal(A.openNotes({ items: {} }).filter((n) => n.kind === 'duplicate').length, 0, 'no near map yet');
});

test('notes: docs, tests and placement per item, most adopted first', () => {
  const items = {
    b: entry('b', { meta: { adoptions: 1 }, docs: { description: false, usage: true }, tests: false }),
    a: entry('a', { meta: { adoptions: 1 }, docs: { description: true, usage: false }, category: A.UNCATEGORIZED }),
    c: entry('c', { meta: { kind: 'applet', adoptions: 5 }, docs: { description: false, usage: false }, tests: false }),
  };
  const notes = A.openNotes({ items, near: {} }).filter((n) => ['docs', 'tests', 'category'].includes(n.kind));
  assert.deepEqual(notes.map((n) => n.id), ['docs:c', 'docs:a', 'category:a', 'docs:b', 'tests:b']);
  assert.match(notes[0].text, /applet `c` needs a description \(40\+ characters\) and usage \(20\+ characters\)\./);
  assert.match(notes[1].text, /needs usage/);
  assert.match(notes[2].text, /fits no taxonomy category/);
});

test('notes: with every category covered, the next step deepens the thinnest heaviest one', () => {
  const items = {};
  for (const c of A.TAXONOMY.categories) for (let i = 0; i < 3; i++) items[`${c.id}${i}`] = entry(`${c.id}${i}`, { category: c.id });
  assert.deepEqual(A.openNotes({ items, near: {} }).filter((n) => n.kind === 'next' || n.kind === 'gap'), [], 'three in every category: nothing to suggest');
  delete items.files1; delete items.files2;
  delete items.games1;
  const next = A.openNotes({ items, near: {} }).filter((n) => n.kind === 'next');
  assert.deepEqual(next, [{ id: 'next:files', kind: 'next', text: 'Most value next: deepen files and storage (1 item).' }]);
  delete items.files0;
  items.files9 = entry('files9', { category: 'files' });
  items.files8 = entry('files8', { category: 'files' });
  assert.equal(A.openNotes({ items, near: {} }).find((n) => n.kind === 'next').text, 'Most value next: deepen files and storage (2 items).');
});

test('carrying notes: no previous notes; kinds without a limit are capped at 5', () => {
  const open = Array.from({ length: 7 }, (_, i) => ({ id: `x:${i}`, kind: 'other', text: `${i}` }));
  const c = A.carryNotes(null, open, 9);
  assert.deepEqual([c.addressed, c.stillOpen], [[], []]);
  assert.equal(c.shown.length, 5);
  assert.equal(c.shown[0].since, 9);
  assert.equal(c.totals.other, 7);
});
