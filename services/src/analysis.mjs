// Deterministic analysis of the shared collection: taxonomy mapping, coverage, similarity,
// the value of added source, maturity and versions, and the notes for the next revision.
// Everything here is a pure function of its inputs (no clock, no randomness), so a revision can
// be explained and recomputed.
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants as Z } from 'node:zlib';
import { createHash } from 'node:crypto';

export const TAXONOMY = JSON.parse(readFileSync(new URL('./taxonomy.json', import.meta.url), 'utf8'));
const CATS = new Map(TAXONOMY.categories.map((c) => [c.id, c]));
export const UNCATEGORIZED = 'uncategorized';

// The constants of the formula (documented in docs/shared-and-users.md and the generated README).
export const K = {
  sourceUnit: 512,        // compressed novel bytes for 10 points
  sourceScale: 10,        // S = 10 * log2(1 + novel / 512)
  newCategory: 15,        // first item in a category: 15 * weight
  deepenCategory: 3,      // second or third item in a category: 3 * weight
  usesEach: 2, usesMax: 5, // building on live shared items: 2 each, at most 5 counted
  adoption: 0.5, report: -2,
  hiddenPenalty: 5,       // a hidden (reported) item takes back its value and 5 more
  duplicate: 0.9,         // estimated similarity at which an item is a duplicate (value 0)
  near: 0.6,              // near-duplicates: notes suggest merging
  related: 0.3,           // related: notes suggest building on the other
  minor: 20,              // a revision worth >= 20 bumps MINOR, else PATCH
  halfMaturity: 1000,     // maturity index = 100 * P / (P + 1000)
};

// ---------------------------------------------------------------- words, categories

export function words(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// The category of an item: path/name/title/description/usage words against each category's
// id, aliases and keywords. Returns {id, score}; uncategorized when nothing scores 2 or more.
export function categorize(item) {
  const strong = new Set([...item.path.flatMap(words), ...words(item.name)]);
  const title = new Set(words(item.title));
  const body = new Set([...words(item.description), ...words(item.usage)]);
  const first = (item.path[0] || '').toLowerCase();
  let best = { id: UNCATEGORIZED, score: 0 };
  for (const c of TAXONOMY.categories) {
    let s = 0;
    if (first === c.id || c.aliases.includes(first)) s += 6;
    for (const k of c.keywords) {
      if (strong.has(k)) s += 3;
      if (title.has(k)) s += 2;
      if (body.has(k)) s += 1;
    }
    if (s > best.score) best = { id: c.id, score: s };
  }
  return best.score >= 2 ? best : { id: UNCATEGORIZED, score: best.score };
}

export const categoryTitle = (id) => CATS.get(id)?.title || 'Uncategorized';
export const categoryWeight = (id) => CATS.get(id)?.weight || 0;

// Coverage: {weighted (0..1), covered, total, counts: {category: n}}.
export function coverage(entries) {
  const counts = Object.fromEntries(TAXONOMY.categories.map((c) => [c.id, 0]));
  for (const e of entries) if (e.category in counts) counts[e.category]++;
  let w = 0, all = 0, covered = 0;
  for (const c of TAXONOMY.categories) { all += c.weight; if (counts[c.id]) { w += c.weight; covered++; } }
  return { weighted: w / all, covered, total: TAXONOMY.categories.length, counts };
}
export const pct = (x) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

// ---------------------------------------------------------------- source and similarity

// The source of an item: components/utils their code (+ css), applets their html (or the JSON).
export function sourceOf(kind, payloadBuf) {
  let p;
  try { p = JSON.parse(payloadBuf.toString('utf8')); } catch { return payloadBuf.toString('utf8'); }
  if (kind === 'applet') return typeof p.html === 'string' ? p.html : JSON.stringify(p);
  return `${p.code || ''}\n${p.css || ''}`;
}
export const normalize = (s) => String(s).replace(/\s+/g, ' ').trim();
export const normalizedSha = (s) => createHash('sha256').update(normalize(s)).digest('hex');

export function compressedSize(s) {
  return brotliCompressSync(Buffer.from(s, 'utf8'), {
    params: { [Z.BROTLI_PARAM_QUALITY]: 9, [Z.BROTLI_PARAM_LGWIN]: 24, [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT },
  }).length;
}

// Compressed bytes the source adds to what the references already hold:
// brotli(refs + source) - brotli(refs); with no references, brotli(source).
export function novelBytes(source, refs = []) {
  const s = normalize(source);
  if (!s) return 0;
  const ref = refs.map(normalize).filter(Boolean).join('\n');
  if (!ref) return compressedSize(s);
  return Math.max(0, compressedSize(`${ref}\n${s}`) - compressedSize(ref));
}

// MinHash over 5-token shingles (64 hashes): an estimate of Jaccard similarity.
const HASHES = 64;
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
const SEEDS = Array.from({ length: HASHES }, (_, i) => fmix((i + 1) * 0x9e3779b9));

export function signature(source) {
  const toks = normalize(source).match(/[A-Za-z_$][\w$]*|\d+|[^\s\w]/g) || [];
  const shingles = new Set();
  if (toks.length < 5) shingles.add(toks.join(' '));
  else for (let i = 0; i + 5 <= toks.length; i++) shingles.add(toks.slice(i, i + 5).join(' '));
  const sig = new Uint32Array(HASHES).fill(0xffffffff);
  for (const sh of shingles) {
    const h = fnv(sh);
    for (let i = 0; i < HASHES; i++) { const v = fmix(h ^ SEEDS[i]); if (v < sig[i]) sig[i] = v; }
  }
  return Buffer.from(sig.buffer).toString('base64');
}
export function similarity(a, b) {
  if (!a || !b) return 0;
  const words32 = (s) => { const buf = Buffer.from(s, 'base64'); return new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); };
  const x = words32(a), y = words32(b);
  let eq = 0;
  for (let i = 0; i < HASHES; i++) if (x[i] === y[i]) eq++;
  return eq / HASHES;
}

export const hasTests = (kind, source) => kind !== 'applet' && /\b(describe|test|assert|expect|selfTest)\s*\(/.test(source);
export const documented = (x) => ({ description: (x.description || '').trim().length >= 40, usage: (x.usage || '').trim().length >= 20 });

// ---------------------------------------------------------------- value

const r2 = (x) => Math.round(x * 100) / 100;

// The value of an added or updated item. Inputs:
//   item      the item (kind, path, name, description, usage, uses)
//   category  its category id
//   novel     novelBytes(source, [previous version, most similar items])
//   duplicateOf  id of a live item it duplicates (other than itself), or null
//   countsBefore category -> live items before this change (without this item)
//   liveIds   Set of live item ids (for `uses`)
//   tests     whether the source carries self-tests
// Returns {value, terms: [{term, value, why}]}.
export function itemValue({ item, category, novel, duplicateOf, countsBefore, liveIds, tests, previousCategory = null }) {
  if (duplicateOf) return { value: 0, terms: [{ term: 'duplicate', value: 0, why: `duplicates ${duplicateOf}: adds nothing` }] };
  const terms = [];
  const S = K.sourceScale * Math.log2(1 + novel / K.sourceUnit);
  const d = documented(item);
  const D = Math.min(1.1, 0.5 + (d.description ? 0.25 : 0) + (d.usage ? 0.25 : 0) + (tests ? 0.1 : 0));
  terms.push({ term: 'source', value: r2(S * D), why: `${novel} new compressed bytes: 10*log2(1+${novel}/512) = ${r2(S)}, ` +
    `x${D.toFixed(2)} (description ${d.description ? 'yes' : 'no'}, usage ${d.usage ? 'yes' : 'no'}, tests ${tests ? 'yes' : 'no'})` });
  // coverage counts only when the item enters a category (new, or moved by an update)
  const w = categoryWeight(category), n = countsBefore[category] || 0;
  if (w && category !== previousCategory) {
    if (n === 0) terms.push({ term: 'coverage', value: K.newCategory * w, why: `first item in ${categoryTitle(category)} (weight ${w}): 15*${w}` });
    else if (n <= 2) terms.push({ term: 'coverage', value: K.deepenCategory * w, why: `item ${n + 1} in ${categoryTitle(category)} (weight ${w}): 3*${w}` });
  }
  const uses = (item.uses || []).filter((id) => liveIds.has(id) && id !== item.id).length;
  if (uses) terms.push({ term: 'builds on', value: K.usesEach * Math.min(uses, K.usesMax), why: `uses ${uses} shared item${uses > 1 ? 's' : ''}: 2 each, at most 5` });
  return { value: r2(terms.reduce((a, t) => a + t.value, 0)), terms };
}

// ---------------------------------------------------------------- maturity and versions

export const maturityIndex = (points) => Math.round((1000 * points) / (points + K.halfMaturity)) / 10;

// The next version: MAJOR follows weighted coverage quarters (25%, 50%, 75%, 100%) and never goes
// back; otherwise a revision worth >= 20 bumps MINOR, anything else PATCH.
export function nextVersion(version, value, weightedCoverage) {
  let [M, m, p] = version.split('.').map(Number);
  const quarter = Math.floor(weightedCoverage * 4 + 1e-9);
  if (quarter > M) return { version: `${quarter}.0.0`, bump: 'major', why: `coverage reached ${quarter * 25}%` };
  if (value >= K.minor) return { version: `${M}.${m + 1}.0`, bump: 'minor', why: `value ${value} >= ${K.minor}` };
  return { version: `${M}.${m}.${p + 1}`, bump: 'patch', why: value < 0 ? 'value below 0' : `value ${value} < ${K.minor}` };
}

// ---------------------------------------------------------------- notes for the next revision

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export { pairKey };

// All open notes for a collection state; `shown` caps each kind for the revision text.
// state.items: id -> entry {meta, category, docs, tests, ...}; state.near: "a|b" -> similarity.
export function openNotes(state) {
  const items = state.items, all = [];
  const label = (id) => { const e = items[id]; return e ? `${e.meta.kind} \`${[...e.meta.path, e.meta.name].join('/')}\`` : id; };
  const cov = coverage(Object.values(items));
  const gaps = TAXONOMY.categories.filter((c) => !cov.counts[c.id]).sort((a, b) => b.weight - a.weight);
  for (const c of gaps) all.push({ id: `gap:${c.id}`, kind: 'gap', text: `${c.title} has nothing yet (weight ${c.weight}) - e.g. ${c.examples.join(', ')}.` });
  const pairs = Object.entries(state.near || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [k, j] of pairs) {
    const [a, b] = k.split('|');
    if (!items[a] || !items[b]) continue;
    const [older, newer] = items[a].meta.created <= items[b].meta.created ? [a, b] : [b, a];
    const linked = items[newer].meta.uses?.includes(older) || items[older].meta.uses?.includes(newer);
    if (linked) continue;   // one already builds on the other
    if (j >= K.near) all.push({ id: `dup:${k}`, kind: 'duplicate', text: `${label(a)} and ${label(b)} are ${Math.round(j * 100)}% alike - merge them into one.` });
    else if (j >= K.related) {
      all.push({ id: `buildon:${newer}:${older}`, kind: 'build-on', text: `${label(newer)} overlaps ${Math.round(j * 100)}% with ${label(older)} - build on it (\`uses\`) instead of repeating it.` });
    }
  }
  const byUse = Object.keys(items).sort((a, b) => (items[b].meta.adoptions || 0) - (items[a].meta.adoptions || 0) || (a < b ? -1 : 1));
  for (const id of byUse) {
    const e = items[id];
    if (!e.docs.description || !e.docs.usage) {
      const miss = [!e.docs.description && 'a description (40+ characters)', !e.docs.usage && 'usage (20+ characters)'].filter(Boolean).join(' and ');
      all.push({ id: `docs:${id}`, kind: 'docs', text: `${label(id)} needs ${miss}.` });
    }
    if (e.meta.kind !== 'applet' && !e.tests) all.push({ id: `tests:${id}`, kind: 'tests', text: `${label(id)} has no self-tests.` });
    if (e.category === UNCATEGORIZED) all.push({ id: `category:${id}`, kind: 'category', text: `${label(id)} fits no taxonomy category - give it a path or words that place it.` });
  }
  if (gaps.length) {
    const g = gaps[0];
    all.push({ id: `next:${g.id}`, kind: 'next', text: `Most value next: a first ${g.title.toLowerCase()} item (e.g. ${g.examples[0]}) - it earns ${K.newCategory * g.weight} coverage points plus its source value.` });
  } else {
    const thin = TAXONOMY.categories.filter((c) => cov.counts[c.id] < 3).sort((a, b) => b.weight - a.weight)[0];
    if (thin) all.push({ id: `next:${thin.id}`, kind: 'next', text: `Most value next: deepen ${thin.title.toLowerCase()} (${cov.counts[thin.id]} item${cov.counts[thin.id] === 1 ? '' : 's'}).` });
  }
  return all;
}

export const NOTE_LIMITS = { gap: 5, duplicate: 5, 'build-on': 5, docs: 8, tests: 8, category: 5, next: 1 };
export const NOTE_TITLES = {
  next: 'Most valuable next contribution', gap: 'Gaps in the taxonomy', duplicate: 'Duplicates to merge',
  'build-on': 'Should build on each other', docs: 'Missing usage docs', tests: 'Missing tests', category: 'Not placed in the taxonomy',
};

// The notes to show, and how the previous revision's notes fared.
export function carryNotes(previous, open, revision) {
  const openIds = new Set(open.map((n) => n.id));
  const prevById = new Map((previous || []).map((n) => [n.id, n]));
  const addressed = (previous || []).filter((n) => !openIds.has(n.id));
  const stillOpen = (previous || []).filter((n) => openIds.has(n.id));
  const shown = [], per = {};
  for (const n of open) {
    per[n.kind] = (per[n.kind] || 0) + 1;
    if (per[n.kind] > (NOTE_LIMITS[n.kind] ?? 5)) continue;
    shown.push({ ...n, since: prevById.get(n.id)?.since ?? revision });
  }
  return { shown, addressed, stillOpen, totals: per };
}
