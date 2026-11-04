// The GitHub mirror of shared.aiui.oeaio.com as a revisioned collection
// (docs/shared-and-users.md, "Mirror to GitHub" and "Revisions").
//
// Every change to the collection (an item added, updated, withdrawn or hidden by reports) is in the
// change log (store.appendChange). A run - started shortly after a write (SQS, delayed), by the
// safety-net schedule, or by hand - waits until the newest pending change is DEBOUNCE_MS old
// (or the oldest MAX_WAIT_MS), coalesces each item's pending changes, and makes one revision per
// changed item, in order: one commit, tags r<N> and v<version>, REVISIONS.md and revisions/r<N>.md
// with the measured value, the maturity change, coverage and the notes for the next revision.
// The revision state (items, similarity, maturity, notes, history) is kept in the store; nothing
// is read back from GitHub except the current tree listing (to commit only real differences).
import { gitBlobSha, ulid } from './util.mjs';
import { publicItem } from './shared.mjs';
import * as A from './analysis.mjs';

export const DEBOUNCE_MS = 90_000;
export const MAX_WAIT_MS = 10 * 60_000;
const LOCK_SECONDS = 900;
const json2 = (v) => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8');
const r2 = (x) => Math.round(x * 100) / 100;
const sign = (x) => (x > 0 ? `+${x}` : `${x}`);

export function initialState() {
  return { revision: 0, version: '0.0.0', points: 0, seq: 0, bootstrapped: false, items: {}, near: {}, notes: [], history: [], commit: null, ai: null };
}

// The item's directory: <kind>/<path...>/<name>. Different authors may share kind+path+name: the
// earliest-created item keeps the plain directory, later ones get "<name>.<author id, 12 hex>".
export function itemDirs(items) {
  const byDir = new Map();
  for (const x of items) {
    const d = [x.kind, ...x.path, x.name].join('/');
    (byDir.get(d) ?? byDir.set(d, []).get(d)).push(x);
  }
  const out = new Map();
  for (const [d, xs] of byDir) {
    xs.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
    xs.forEach((x, i) => out.set(x.id, i === 0 ? d : `${d}.${x.author.slice(0, 12)}`));
  }
  return out;
}

const label = (m) => `${m.kind} \`${[...m.path, m.name].join('/')}\``;
const by = (m) => (m.authorName ? `${m.authorName} (\`${m.author}\`)` : `\`${m.author}\``);
const SAME = ['kind', 'name', 'path', 'title', 'description', 'usage', 'libs', 'uses', 'version', 'sha256'];
const sameItem = (a, b) => SAME.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

// ---------------------------------------------------------------- generated files

export function formulaMarkdown() {
  const k = A.K;
  return [
    '## How value and maturity are measured', '',
    'Every revision changes one item. Its **value** is computed from the item and the collection before it,',
    'deterministically:', '',
    `- **source** = 10 x log2(1 + novel / ${k.sourceUnit}) x documentation. *novel* is the number of compressed bytes the`,
    '  item\'s source adds to what the collection already holds: brotli(references + source) - brotli(references),',
    '  where the references are its own previous version and the (up to 4) most similar items. Whitespace is',
    '  normalized first, so reformatting adds nothing. *documentation* is 0.5, +0.25 with a description of 40+',
    '  characters, +0.25 with usage of 20+ characters, +0.1 when the code carries self-tests (at most 1.1).',
    `- **coverage**: the first item in a taxonomy category earns ${k.newCategory} x the category weight; the second and third`,
    `  ${k.deepenCategory} x weight (TAXONOMY.json, weights 1-3).`,
    `- **builds on**: ${k.usesEach} per live shared item it \`uses\` (at most ${k.usesMax} counted).`,
    `- **duplicate**: an item ${k.duplicate * 100}% alike (MinHash over 5-token shingles) to another live item is worth 0.`,
    `- **usage**: ${k.adoption} per adoption and ${k.report} per report since the previous revision.`,
    `- **withdrawn** or **hidden** (3 reports): minus everything the item added (hidden: ${k.hiddenPenalty} more).`, '',
    `**Maturity points** P add up the values (never below 0). The **maturity index** is 100 x P / (P + ${k.halfMaturity}):`,
    'it approaches 100 as the collection approaches "an OS with all software". The **version** MAJOR.MINOR.PATCH:',
    `MAJOR is the number of weighted-coverage quarters reached (25%, 50%, 75%, 100%); otherwise a revision worth ${k.minor}`,
    'or more bumps MINOR and any other revision PATCH. **Coverage** is the weight of covered categories over all weights.',
  ].join('\n');
}

function readme(state, items) {
  const cov = A.coverage(Object.values(state.items));
  const count = (k) => items.filter((x) => x.kind === k).length;
  const lines = [
    '# AI UI - shared components, utilities and applets', '',
    'A read-only, generated mirror of `https://shared.aiui.oeaio.com`: what AI UI users explicitly shared,',
    'grown one revision per change toward a personal OS with all its software (TAXONOMY.json).', '',
    `**r${state.revision} - version ${state.version} - maturity ${A.maturityIndex(state.points)}/100 ` +
      `(${r2(state.points)} points) - coverage ${A.pct(cov.weighted)} (${cov.covered} of ${cov.total} categories)**`, '',
    `Live items: ${items.length} (components ${count('component')}, utilities ${count('util')}, applets ${count('applet')}).`,
    'See REVISIONS.md for the history and revisions/ for each revision with its notes for the next one.', '',
    formulaMarkdown(), '',
    '## Layout', '',
    '- `TAXONOMY.json` - the target: categories of software a complete personal OS needs.',
    '- `COLLECTION.json` - version, maturity, coverage per category, the category and value of every item.',
    '- `REVISIONS.md`, `revisions/r<N>.md` - the revisions, newest first; git tags `r<N>` and `v<version>`.',
    '- `index.json` - every live item (metadata, no payloads), newest first, as `GET /v1/index`.',
    '- `<kind>/<path...>/<name>/meta.json` - the item as the API returned it.',
    '- `<kind>/<path...>/<name>/payload.json` - the exact payload bytes; their sha256 is `meta.sha256`.',
    '- `<kind>/<path...>/<name>/code.js` - components and utilities: the code alone, for reading.', '',
    'When two authors share the same kind, path and name, the later one\'s directory ends in',
    '`.<first 12 hex of the author id>`. Authors appear by app id (and display name when set).', '',
    '## Adopting in AI UI', '',
    'Open the shared library in AI UI (global level), pick an item and choose Adopt: the app downloads',
    'the payload, checks its sha256, has the AI review it, shows the review, and only on your',
    'confirmation copies it into your local library. Global code is never run directly.', '',
    '## Items by category', '',
  ];
  const byCat = new Map();
  for (const [id, e] of Object.entries(state.items)) (byCat.get(e.category) ?? byCat.set(e.category, []).get(e.category)).push(id);
  for (const c of [...A.TAXONOMY.categories.map((x) => x.id), A.UNCATEGORIZED]) {
    const ids = byCat.get(c);
    if (!ids) continue;
    lines.push(`### ${A.categoryTitle(c)}`, '');
    for (const id of ids.sort((a, b) => (label(state.items[a].meta) < label(state.items[b].meta) ? -1 : 1))) {
      const m = state.items[id].meta;
      lines.push(`- ${label(m)} v${m.version} - ${m.title.replace(/\s+/g, ' ')} - by ${m.authorName || m.author.slice(0, 12)}`);
    }
    lines.push('');
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

function collectionJson(state) {
  const cov = A.coverage(Object.values(state.items));
  const items = {};
  for (const [id, e] of Object.entries(state.items)) items[id] = { path: [e.meta.kind, ...e.meta.path, e.meta.name].join('/'), category: e.category, value: e.value };
  return {
    revision: state.revision, version: state.version,
    maturity: { points: r2(state.points), index: A.maturityIndex(state.points) },
    coverage: {
      weighted: Math.round(cov.weighted * 1000) / 1000, covered: cov.covered, total: cov.total,
      categories: A.TAXONOMY.categories.map((c) => ({ id: c.id, title: c.title, weight: c.weight, items: cov.counts[c.id] })),
    },
    items, formula: A.K,
  };
}

function revisionsMd(state) {
  const rows = state.history.slice(-500).reverse().map((h) =>
    `| [r${h.n}](revisions/r${h.n}.md) | ${h.version} | ${h.at.slice(0, 16).replace('T', ' ')} | ${h.change} | ${sign(h.value)} | ${h.maturity} | ${h.coverage} |`);
  return Buffer.from(['# Revisions', '', 'Newest first; each revision changes one item. Value and maturity: see README.md.', '',
    '| revision | version | time (UTC) | change | value | maturity | coverage |', '|---|---|---|---|---|---|---|', ...rows, ''].join('\n'), 'utf8');
}

export function revisionMd(r) {
  const L = [`# r${r.n} - v${r.version}`, '', `${r.at} - \`${r.message}\``, '', '## Change', ''];
  const m = r.change.meta;
  L.push(`- **${r.change.type}** ${label(m)} v${m.version} (\`${m.id}\`) - "${m.title}"`,
    `- author: ${by(m)}`, `- kind: ${m.kind}, path: \`${[...m.path, m.name].join('/')}\`, category: ${A.categoryTitle(r.change.category)}`);
  if (r.change.novel !== undefined) L.push(`- new source: ${r.change.novel} compressed bytes${r.change.duplicateOf ? ` (duplicate of \`${r.change.duplicateOf}\`)` : ''}`);
  L.push('', `## Value: ${sign(r.value)}`, '', '| term | value | why |', '|---|---|---|');
  for (const t of r.terms) L.push(`| ${t.term} | ${sign(t.value)} | ${t.why} |`);
  L.push('', '## Maturity', '',
    `- points ${r.before.points} -> ${r.after.points}; index ${r.before.index} -> ${r.after.index} / 100`,
    `- version ${r.before.version} -> ${r.version} (${r.bump}: ${r.bumpWhy})`, '',
    '## Coverage', '',
    `- before ${A.pct(r.before.coverage.weighted)} (${r.before.coverage.covered} of ${r.before.coverage.total} categories) -> after ${A.pct(r.after.coverage.weighted)} (${r.after.coverage.covered} of ${r.after.coverage.total})`);
  const gained = A.TAXONOMY.categories.filter((c) => !r.before.coverage.counts[c.id] && r.after.coverage.counts[c.id]).map((c) => c.title);
  const lost = A.TAXONOMY.categories.filter((c) => r.before.coverage.counts[c.id] && !r.after.coverage.counts[c.id]).map((c) => c.title);
  if (gained.length) L.push(`- newly covered: ${gained.join(', ')}`);
  if (lost.length) L.push(`- no longer covered: ${lost.join(', ')}`);
  L.push('', r.n > 1 ? `## Notes from r${r.n - 1}` : '## Notes from the previous revision', '');
  if (!r.addressed.length && !r.stillOpen.length) L.push('- (none)');
  for (const n of r.addressed) L.push(`- [x] addressed: ${n.text}`);
  for (const n of r.stillOpen) L.push(`- [ ] still open (since r${n.since}): ${n.text}`);
  L.push('', '## Notes for the next revision', '');
  for (const kind of Object.keys(A.NOTE_TITLES)) {
    const ns = r.notes.filter((n) => n.kind === kind);
    if (!ns.length) continue;
    const more = (r.totals[kind] || 0) - ns.length;
    L.push(`### ${A.NOTE_TITLES[kind]}`, '', ...ns.map((n) => `- ${n.text}`), ...(more > 0 ? [`- ... and ${more} more`] : []), '');
  }
  if (r.ai) L.push('### Reviewer notes (AI)', '', r.ai.trim(), '');
  return Buffer.from(L.join('\n') + '\n', 'utf8');
}

// The managed files (everything except revisions/): Map path -> {sha, load()}.
export function buildTree(state, getPayload) {
  const files = new Map();
  const put = (path, buf) => files.set(path, { sha: gitBlobSha(buf), load: async () => buf });
  const metas = Object.values(state.items).map((e) => e.meta).sort((a, b) => (a.updated === b.updated ? (a.id < b.id ? 1 : -1) : a.updated < b.updated ? 1 : -1));
  const generated = metas.reduce((m, x) => (x.updated > m ? x.updated : m), '1970-01-01T00:00:00.000Z');
  put('README.md', readme(state, metas));
  put('TAXONOMY.json', json2(A.TAXONOMY));
  put('COLLECTION.json', json2(collectionJson(state)));
  put('REVISIONS.md', revisionsMd(state));
  put('index.json', json2({ items: metas, next: null, generated }));
  const dirs = itemDirs(metas);
  for (const m of metas) {
    const e = state.items[m.id], d = dirs.get(m.id);
    put(`${d}/meta.json`, json2(m));
    const payload = async () => {
      const buf = await getPayload(m.sha256);
      if (!buf || gitBlobSha(buf) !== e.git.payload) throw new Error(`payload of ${m.id} is missing or does not match`);
      return buf;
    };
    files.set(`${d}/payload.json`, { sha: e.git.payload, load: payload });
    if (m.kind !== 'applet') files.set(`${d}/code.js`, { sha: e.git.code, load: async () => Buffer.from(JSON.parse((await payload()).toString('utf8')).code, 'utf8') });
  }
  return files;
}

// ---------------------------------------------------------------- one revision

// Applies one item's coalesced change to the state; returns the revision record, or null when the
// collection does not change. `usage` is the adoption/report delta to account in this revision.
export async function applyChange(state, g, { getPayload, usage = null, at }) {
  const prev = state.items[g.id] || null;
  const before = { points: r2(state.points), index: A.maturityIndex(state.points), version: state.version, coverage: A.coverage(Object.values(state.items)) };
  let value, terms, change, source = null;
  if (g.type === 'withdrawn' || g.type === 'hidden') {
    if (!prev) return null;
    const hidden = g.type === 'hidden';
    value = r2(-prev.value - (hidden ? A.K.hiddenPenalty : 0));
    terms = [{ term: g.type, value, why: `takes back the ${prev.value} it added${hidden ? `, and ${A.K.hiddenPenalty} for being reported` : ''}` }];
    delete state.items[g.id];
    for (const k of Object.keys(state.near)) if (k.split('|').includes(g.id)) delete state.near[k];
    change = { type: g.type, meta: prev.meta, category: prev.category };
  } else {
    const meta = publicItem(g.item);
    if (prev && sameItem(prev.meta, meta)) return null;
    source = A.sourceOf(meta.kind, await getPayload(meta.sha256));
    const sig = A.signature(source), nsha = A.normalizedSha(source);
    const category = A.categorize(meta).id;
    const sims = [];
    for (const [id, o] of Object.entries(state.items)) if (id !== g.id) sims.push({ id, j: o.nsha === nsha ? 1 : A.similarity(sig, o.sig) });
    sims.sort((a, b) => b.j - a.j || (a.id < b.id ? -1 : 1));
    const duplicateOf = sims[0] && sims[0].j >= A.K.duplicate ? sims[0].id : null;
    const refs = [];
    if (prev) refs.push(A.sourceOf(prev.meta.kind, await getPayload(prev.meta.sha256)));
    for (const s of sims.slice(0, 4)) if (s.j >= 0.1) refs.push(A.sourceOf(state.items[s.id].meta.kind, await getPayload(state.items[s.id].meta.sha256)));
    const novel = duplicateOf ? 0 : A.novelBytes(source, refs);
    const others = Object.entries(state.items).filter(([id]) => id !== g.id).map(([, e]) => e);
    const tests = A.hasTests(meta.kind, source);
    ({ value, terms } = A.itemValue({
      item: meta, category, novel, duplicateOf, tests, previousCategory: prev?.category ?? null,
      countsBefore: A.coverage(others).counts, liveIds: new Set(Object.keys(state.items)),
    }));
    state.items[g.id] = {
      meta, git: g.item.git, category, sig, nsha, docs: A.documented(meta), tests,
      value: r2((prev?.value || 0) + value), seenAdoptions: meta.adoptions || 0, seenReports: meta.reports || 0,
    };
    for (const k of Object.keys(state.near)) if (k.split('|').includes(g.id)) delete state.near[k];
    for (const s of sims) if (s.j >= A.K.related) state.near[A.pairKey(g.id, s.id)] = r2(s.j);
    change = { type: prev ? 'updated' : 'added', meta, category, novel, duplicateOf };
  }
  if (usage && (usage.adoptions || usage.reports)) {
    const u = r2(usage.adoptions * A.K.adoption + usage.reports * A.K.report);
    terms.push({ term: 'usage', value: u, why: `${usage.adoptions} adoption(s), ${usage.reports} report(s) since the previous revision` });
    value = r2(value + u);
  }
  const n = state.revision + 1;
  state.points = r2(Math.max(0, state.points + value));
  const after = { points: state.points, index: A.maturityIndex(state.points), coverage: A.coverage(Object.values(state.items)) };
  const v = A.nextVersion(state.version, value, after.coverage.weighted);
  state.version = v.version;
  state.revision = n;
  const carry = A.carryNotes(state.notes, A.openNotes(state), n);
  state.notes = carry.shown;
  const path = [change.meta.kind, ...change.meta.path, change.meta.name].join('/');
  const message = `r${n} v${v.version}: ${change.type} ${path} (value ${sign(value)}, maturity ${after.index})`;
  state.history.push({ n, version: v.version, at, change: `${change.type} ${label(change.meta)}`, value, points: state.points, maturity: after.index, coverage: A.pct(after.coverage.weighted) });
  return {
    n, at, version: v.version, bump: v.bump, bumpWhy: v.why, value, terms, change, before, after, message,
    notes: carry.shown, addressed: carry.addressed, stillOpen: carry.stillOpen, totals: carry.totals, ai: null, source,
  };
}

// Coalesces pending changes: one group per item, in the order of its first pending change, with
// its last state.
export function coalesce(changes) {
  const groups = new Map();
  for (const c of changes) {
    const g = groups.get(c.id);
    if (g) Object.assign(g, { type: c.type, item: c.item ?? g.item, at: c.at, seq: c.seq });
    else groups.set(c.id, { id: c.id, type: c.type, item: c.item, at: c.at, seq: c.seq });
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------- the run

// `github`: a client (github.mjs) or an async function returning one (called only when there is a
// revision to commit). `notify(seconds)`: ask for another run later (pending changes not settled,
// or another run busy). `review(context)`: optional AI notes for the revision (review.mjs).
// A run is idempotent: when it stops half-way, the next one skips what is already applied.
export async function runRevisions({ store, github: connect, branch = 'main', now = Date.now, force = false,
  notify = null, review = null, log = () => {}, debounceMs = DEBOUNCE_MS, maxWaitMs = MAX_WAIT_MS }) {
  const owner = ulid(now());
  if (!(await store.acquireLock('revisions', owner, LOCK_SECONDS))) { await notify?.(60); return { status: 'busy', revisions: [] }; }
  try {
    let state = await store.getState('collection');
    const groups = [];
    if (!state || !state.bootstrapped) {
      // first run (until it completes): the items already live become revisions, in the order they
      // were created; the change log up to now is covered by that
      if (!state) { state = initialState(); state.seq = await store.latestChangeSeq(); }
      const live = (await store.allLive()).sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
      groups.push(...live.map((x) => ({ id: x.id, type: 'added', item: x, at: x.updated })));
    }
    const changes = await store.listChanges(state.seq, 10_000);
    let pending = 0, upTo = state.seq;
    if (changes.length) {
      const t = now(), newest = Date.parse(changes[changes.length - 1].at), oldest = Date.parse(changes[0].at);
      if (force || t - newest >= debounceMs || t - oldest >= maxWaitMs) { groups.push(...coalesce(changes)); upTo = changes[changes.length - 1].seq; }
      else { pending = changes.length; await notify?.(Math.ceil((debounceMs - (t - newest)) / 1000)); }
    }
    if (!groups.length) {
      if (!state.bootstrapped) { state.bootstrapped = true; await store.putState('collection', state); }
      return { status: pending ? 'not-settled' : 'nothing', revisions: [], pending };
    }

    const getPayload = (sha) => store.getPayload(sha);
    // adoptions/reports since the last revision, accounted in this run's first revision
    const liveNow = new Map((await store.allLive()).map((x) => [x.id, x]));
    let usage = { adoptions: 0, reports: 0 };
    for (const [id, e] of Object.entries(state.items)) {
      const x = liveNow.get(id);
      if (!x) continue;
      usage.adoptions += Math.max(0, (x.adoptions || 0) - e.seenAdoptions);
      usage.reports += Math.max(0, (x.reports || 0) - e.seenReports);
      e.seenAdoptions = x.adoptions || 0; e.seenReports = x.reports || 0;
      e.meta = { ...e.meta, adoptions: x.adoptions || 0, reports: x.reports || 0 };
    }

    let github = null, head = null, remote = null;
    const out = [];
    for (const g of groups) {
      const rev = await applyChange(state, g, { getPayload, usage, at: g.at });
      if (!rev) continue;
      usage = null;
      if (review) {
        try { rev.ai = await review({ revision: rev, previousAi: state.ai, source: rev.source }); if (rev.ai) state.ai = rev.ai; } catch (e) { log(`AI review failed: ${e.message}`); }
      }
      if (!github) {
        github = typeof connect === 'function' ? await connect() : connect;
        head = await github.getHead(branch);
        if (head === 'empty') {
          log('initializing the empty repository');
          await github.initialize(branch, 'README.md', Buffer.from('# AI UI shared\n'), 'Initialize the mirror');
          head = await github.getHead(branch);
        }
        remote = new Map();
        if (head) {
          const tree = await github.getTree(await github.getCommitTree(head));
          if (tree.truncated) throw new Error('the branch tree is too large to read in one call');
          for (const e of tree.tree) if (e.type === 'blob') remote.set(e.path, e.sha);
        }
      }
      const files = buildTree(state, getPayload);
      const revBuf = revisionMd(rev);
      files.set(`revisions/r${rev.n}.md`, { sha: gitBlobSha(revBuf), load: async () => revBuf });
      const entries = [];
      for (const [path, f] of files) if (remote.get(path) !== f.sha) entries.push({ path, mode: '100644', type: 'blob', sha: f.sha });
      for (const path of remote.keys()) if (!files.has(path) && !path.startsWith('revisions/')) entries.push({ path, mode: '100644', type: 'blob', sha: null });
      const known = new Set(remote.values());
      for (const e of entries) {
        if (!e.sha || known.has(e.sha)) continue;
        const sha = await github.createBlob(await files.get(e.path).load());
        if (sha !== e.sha) throw new Error(`blob sha mismatch for ${e.path}`);
        known.add(sha);
      }
      const baseTree = head ? await github.getCommitTree(head) : undefined;
      const tree = await github.createTree(entries.sort((a, b) => (a.path < b.path ? -1 : 1)), baseTree);
      const commit = await github.createCommit(`${rev.message}\n\n${rev.change.type} ${label(rev.change.meta)} by ${rev.change.meta.authorName || rev.change.meta.author}\n` +
        `value ${sign(rev.value)}; maturity ${rev.before.index} -> ${rev.after.index}; coverage ${A.pct(rev.before.coverage.weighted)} -> ${A.pct(rev.after.coverage.weighted)}\n`, tree, head ? [head] : []);
      if (head) await github.updateRef(branch, commit); else await github.createRef(branch, commit);
      for (const e of entries) if (e.sha) remote.set(e.path, e.sha); else remote.delete(e.path);
      head = commit;
      await github.setTag(`r${rev.n}`, commit);
      await github.setTag(`v${rev.version}`, commit);
      state.commit = commit;
      await store.putState('collection', state);
      log(`${rev.message} -> ${commit}`);
      out.push({ n: rev.n, version: rev.version, value: rev.value, commit, message: rev.message });
    }
    state.seq = upTo;
    state.bootstrapped = true;
    await store.putState('collection', state);
    return { status: out.length ? 'committed' : 'nothing', revisions: out, version: state.version, maturity: A.maturityIndex(state.points) };
  } finally {
    await store.releaseLock('revisions', owner);
  }
}
