// The GitHub mirror of shared.aiui.oeaio.com (docs/shared-and-users.md, "Mirror to GitHub").
// Runs on a 15-minute schedule; does the work when a burst of changes has settled for 15 minutes,
// or every 6 hours, or when forced. Builds the whole tree of live items, and - only when it
// differs from the branch - writes it as one commit through the Git Data API.
import { sha256hex, gitBlobSha } from './util.mjs';
import { publicItem } from './shared.mjs';

export const SETTLE_MS = 15 * 60 * 1000;
export const EVERY_MS = 6 * 60 * 60 * 1000;
const json2 = (v) => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8');

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

function readme(items) {
  const count = (k) => items.filter((x) => x.kind === k).length;
  const lines = [
    '# AI UI - shared components, utilities and applets', '',
    'This repository is a read-only mirror of `https://shared.aiui.oeaio.com`, the global registry of',
    'what AI UI users explicitly shared. It is generated: changes made here are overwritten and never',
    'read back.', '',
    `Live items: ${items.length} (components ${count('component')}, utilities ${count('util')}, applets ${count('applet')}).`, '',
    '## Layout', '',
    '- `index.json` - every live item (metadata, no payloads), newest first, as `GET /v1/index`.',
    '- `<kind>/<path...>/<name>/meta.json` - the item as the API returns it.',
    '- `<kind>/<path...>/<name>/payload.json` - the exact payload bytes; their sha256 is `meta.sha256`.',
    '- `<kind>/<path...>/<name>/code.js` - components and utilities: the code alone, for reading.', '',
    'When two authors share the same kind, path and name, the later one\'s directory ends in',
    '`.<first 12 hex of the author id>`. Authors appear by app id (and display name when set).', '',
    '## Adopting in AI UI', '',
    'Open the shared library in AI UI (global level), pick an item and choose Adopt: the app downloads',
    'the payload, checks its sha256, has the AI review it, shows the review, and only on your',
    'confirmation copies it into your local library. Global code is never run directly.', '',
    '## Items', '',
  ];
  for (const k of ['component', 'util', 'applet']) {
    const xs = items.filter((x) => x.kind === k).sort((a, b) => (a.kind + a.path.join('/') + a.name < b.kind + b.path.join('/') + b.name ? -1 : 1));
    if (!xs.length) continue;
    lines.push(`### ${k === 'util' ? 'Utilities' : k === 'component' ? 'Components' : 'Applets'}`, '');
    for (const x of xs) {
      const by = x.authorName ? `${x.authorName} (${x.author.slice(0, 12)})` : x.author.slice(0, 12);
      lines.push(`- \`${[...x.path, x.name].join('/')}\` v${x.version} - ${x.title.replace(/\s+/g, ' ')} - by ${by}`);
    }
    lines.push('');
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

// The desired tree: Map path -> {sha, load(): Promise<Buffer>}.
export function buildTree(items, getPayload) {
  const files = new Map();
  const put = (path, buf) => files.set(path, { sha: gitBlobSha(buf), load: async () => buf });
  const generated = items.reduce((m, x) => (x.updated > m ? x.updated : m), '1970-01-01T00:00:00.000Z');
  put('README.md', readme(items));
  put('index.json', json2({ items: items.map(publicItem), next: null, generated }));
  const dirs = itemDirs(items);
  for (const x of items) {
    const d = dirs.get(x.id);
    put(`${d}/meta.json`, json2(publicItem(x)));
    const payload = async () => {
      const buf = await getPayload(x.sha256);
      if (!buf || sha256hex(buf) !== x.sha256) throw new Error(`payload of ${x.id} is missing or does not match its sha256`);
      return buf;
    };
    files.set(`${d}/payload.json`, { sha: x.git.payload, load: payload });
    if (x.kind !== 'applet') {
      files.set(`${d}/code.js`, { sha: x.git.code, load: async () => Buffer.from(JSON.parse((await payload()).toString('utf8')).code, 'utf8') });
    }
  }
  return files;
}

const dirOf = (path) => path.slice(0, path.lastIndexOf('/'));

// Counts by item directory (a directory holding meta.json): added, updated, removed.
export function diffCounts(desired, remote) {
  const itemDirsOf = (m) => new Set([...m.keys()].filter((p) => p.endsWith('/meta.json')).map(dirOf));
  const want = itemDirsOf(desired), have = itemDirsOf(remote);
  const touched = new Set();
  for (const [p, f] of desired) if (remote.get(p) !== f.sha) touched.add(dirOf(p));
  for (const p of remote.keys()) if (!desired.has(p)) touched.add(dirOf(p));
  let added = 0, updated = 0, removed = 0;
  for (const d of want) if (!have.has(d)) added++; else if (touched.has(d)) updated++;
  for (const d of have) if (!want.has(d)) removed++;
  return { added, updated, removed };
}

// `github` is a client (github.mjs) or an async function returning one, called only when the run
// has something to compare (so a run that is not due reads no secret).
export async function runMirror({ store, github: connect, repo, branch = 'main', now = Date.now, force = false, log = () => {} }) {
  let client = typeof connect === 'function' ? null : connect;
  repo ??= client?.repo;
  const state = (await store.getMeta('mirror')) || {};
  const lastChange = await store.getMeta('lastChange');
  const t = now(), lastRun = state.lastRun ? Date.parse(state.lastRun) : 0;
  const settled = lastChange && Date.parse(lastChange) > lastRun && t - Date.parse(lastChange) >= SETTLE_MS;
  if (!force && lastRun && !settled && t - lastRun < EVERY_MS) return { status: 'not-due' };

  const items = await store.allLive();
  const files = buildTree(items, (sha) => store.getPayload(sha));
  const target = `${repo}#${branch}`;
  const fingerprint = sha256hex([...files].map(([p, f]) => `${p} ${f.sha}`).sort().join('\n') + `\n${target}`);
  const done = async (extra) => store.setMeta('mirror', { ...state, lastRun: new Date(t).toISOString(), fingerprint, target, ...extra });
  if (state.fingerprint === fingerprint) { await done({}); return { status: 'unchanged', items: items.length }; }

  const github = client ?? (client = await connect());
  let head = await github.getHead(branch);
  if (head === 'empty') {
    log('initializing the empty repository');
    await github.initialize(branch, 'README.md', await files.get('README.md').load(), 'Initialize the mirror');
    head = await github.getHead(branch);
  }
  const remote = new Map();
  if (head) {
    const tree = await github.getTree(await github.getCommitTree(head));
    if (tree.truncated) throw new Error('the branch tree is too large to read in one call');
    for (const e of tree.tree) if (e.type === 'blob') remote.set(e.path, e.sha);
  }
  const counts = diffCounts(files, remote);
  const same = remote.size === files.size && [...files].every(([p, f]) => remote.get(p) === f.sha);
  if (head && same) { await done({ commit: head }); return { status: 'unchanged', items: items.length }; }

  const known = new Set(remote.values());
  for (const [path, f] of files) {
    if (known.has(f.sha)) continue;
    const sha = await github.createBlob(await f.load());
    if (sha !== f.sha) throw new Error(`blob sha mismatch for ${path}`);
    known.add(sha);
  }
  const tree = await github.createTree([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, f]) => ({ path, mode: '100644', type: 'blob', sha: f.sha })));
  const message = `Shared: +${counts.added} updated ${counts.updated} removed ${counts.removed}`;
  const commit = await github.createCommit(message, tree, head ? [head] : []);
  if (head) await github.updateRef(branch, commit); else await github.createRef(branch, commit);
  await done({ commit });
  log(`${message} -> ${commit}`);
  return { status: 'committed', commit, message, ...counts, items: items.length };
}
