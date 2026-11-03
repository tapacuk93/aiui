// shared.aiui.oeaio.com: what users explicitly shared (components, utilities, applets).
import { HttpError, bad, json, sha256hex, gitBlobSha, ulid, ULID_RE, encodeCursor, decodeCursor, parseJson, parseIso } from './util.mjs';

export const KINDS = ['component', 'util', 'applet'];
export const LIMITS = {
  payloadBytes: 512 * 1024, bodyBytes: 1024 * 1024, text: 80, longText: 4096, pathDepth: 8,
  libs: 32, uses: 64, reason: 1000, pageSize: 500, search: 50, reportsToHide: 3, removed: 5000,
};
const NAME_RE = /^[A-Za-z0-9_$-]{1,80}$/;     // no dots or slashes: it is a directory in the mirror
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LIB_RE = /^[A-Za-z0-9_.@/-]{1,64}$/;
const PUBLIC_FIELDS = ['id', 'kind', 'name', 'path', 'title', 'description', 'usage', 'version', 'author', 'authorName',
  'sha256', 'size', 'libs', 'uses', 'created', 'updated', 'adoptions', 'reports'];

export function publicItem(x) {
  const o = {};
  for (const k of PUBLIC_FIELDS) if (x[k] !== undefined) o[k] = x[k];
  return o;
}
export const itemKey = (author, kind, path, name) => `${author}|${kind}|${path.join('/')}|${name}`;

const bytes = (s) => Buffer.byteLength(s, 'utf8');
function text(v, what, max, { required = false, def = '' } = {}) {
  if (v === undefined || v === null) { if (required) throw bad(`${what} required`); return def; }
  if (typeof v !== 'string') throw bad(`${what} must be a string`);
  if (required && !v.trim()) throw bad(`${what} required`);
  if (max <= LIMITS.text ? [...v].length > max : bytes(v) > max) throw new HttpError(413, `${what} is longer than ${max}`);
  return v;
}
function list(v, what, max, re) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !re.test(x))) throw bad(`${what} must be a list of valid names`);
  if (v.length > max) throw bad(`${what}: at most ${max}`);
  return [...new Set(v)];
}

// Validates a POST /v1/items body; returns the clean fields and the payload bytes.
export function validateItem(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be an object');
  if (!KINDS.includes(b.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) throw bad('name: 1-80 of A-Z a-z 0-9 _ $ -');
  const path = list(b.path, 'path', LIMITS.pathDepth, SEGMENT_RE);
  if (Array.isArray(b.path) && path.length !== b.path.length) throw bad('path has a repeated segment');
  const p = b.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('payload must be a JSON object');
  if (b.kind === 'applet') {
    if (typeof p.kind !== 'string') throw bad('applet payload: the screen JSON (with its kind)');
  } else {
    if (typeof p.code !== 'string' || !p.code.trim()) throw bad('payload.code required');
    if (p.css !== undefined && typeof p.css !== 'string') throw bad('payload.css must be a string');
    if (Object.keys(p).some((k) => k !== 'code' && k !== 'css')) throw bad('payload: only code and css');
  }
  const payload = Buffer.from(JSON.stringify(p), 'utf8');
  if (payload.length > LIMITS.payloadBytes) throw new HttpError(413, 'payload is larger than 512 KB');
  const uses = list(b.uses, 'uses', LIMITS.uses, ULID_RE);
  return {
    fields: {
      kind: b.kind, name: b.name, path,
      title: text(b.title, 'title', LIMITS.text, { def: b.name }).trim() || b.name,
      description: text(b.description, 'description', LIMITS.longText),
      usage: text(b.usage, 'usage', LIMITS.longText),
      libs: list(b.libs, 'libs', LIMITS.libs, LIB_RE),
      uses,
    },
    payload,
    code: b.kind === 'applet' ? null : p.code,
  };
}

// Search ranking: every query word must match somewhere; name matches weigh most.
export function rank(items, q, kind) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const x of items) {
    if (kind && x.kind !== kind) continue;
    const name = x.name.toLowerCase(), title = x.title.toLowerCase(), desc = (x.description || '').toLowerCase();
    const path = x.path.map((s) => s.toLowerCase());
    let score = 0, all = true;
    for (const w of words) {
      let s = 0;
      if (name === w) s += 100; else if (name.startsWith(w)) s += 50; else if (name.includes(w)) s += 30;
      if (title.includes(w)) s += 20;
      if (path.includes(w)) s += 15; else if (path.some((p) => p.includes(w))) s += 8;
      if (desc.includes(w)) s += 5;
      if (!s) { all = false; break; }
      score += s;
    }
    if (all) out.push([score, x]);
  }
  out.sort((a, b) => b[0] - a[0] || (b[1].adoptions || 0) - (a[1].adoptions || 0) || (a[1].updated < b[1].updated ? 1 : -1));
  return out.slice(0, LIMITS.search).map(([, x]) => x);
}

export function sharedRoutes(ctx) {
  const { store } = ctx;
  const changed = () => store.setMeta('lastChange', ctx.nowIso());
  const liveItem = async (id) => {
    if (!ULID_RE.test(id)) throw new HttpError(404, 'no such item');
    const x = await store.getItem(id);
    if (!x || x.status !== 'live') throw new HttpError(404, 'no such item');
    return x;
  };
  const cache = { 'cache-control': 'public, max-age=60' };

  return [
    ['GET', /^\/v1\/index$/, async (req) => {
      const generated = ctx.nowIso();
      const q = req.query;
      const since = q.get('since') ? parseIso(q.get('since'), 'since') : null;
      const after = q.get('after') ? decodeCursor(q.get('after')) : null;
      if (after && (typeof after.u !== 'string' || typeof after.id !== 'string')) throw bad('bad cursor');
      let limit = LIMITS.pageSize;
      if (q.get('limit')) { limit = Number(q.get('limit')); if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) throw bad('limit: 1-500'); }
      const page = await store.listLive({ since, after, limit });
      let next = null;
      if (page.next) {
        const p = new URLSearchParams();
        if (since) p.set('since', since);
        if (q.get('limit')) p.set('limit', String(limit));
        p.set('after', encodeCursor(page.next));
        next = `/v1/index?${p}`;
      }
      const out = { items: page.items.map(publicItem), next, generated };
      if (since && !after) out.removed = (await store.listRemoved(since)).slice(0, LIMITS.removed);
      return json(200, out, cache);
    }],

    ['GET', /^\/v1\/items\/([^/]+)$/, async (req, [id]) => json(200, publicItem(await liveItem(id)), cache)],

    ['GET', /^\/v1\/items\/([^/]+)\/payload$/, async (req, [id]) => {
      const x = await liveItem(id);
      const buf = await store.getPayload(x.sha256);
      if (!buf) throw new HttpError(404, 'payload missing');
      return { status: 200, headers: { 'content-type': 'application/json', 'x-aiui-sha256': x.sha256, ...cache }, body: buf, binary: true };
    }],

    ['GET', /^\/v1\/search$/, async (req) => {
      const q = (req.query.get('q') || '').trim(), kind = req.query.get('kind') || null;
      if (!q) throw bad('q required');
      if (q.length > 200) throw bad('q is too long');
      if (kind && !KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
      return json(200, { items: rank(await ctx.liveItems(), q, kind).map(publicItem) }, cache);
    }],

    ['POST', /^\/v1\/items$/, async (req) => {
      const me = await ctx.signer(req);
      if (req.body.length > LIMITS.bodyBytes) throw new HttpError(413, 'body is too large');
      const { fields, payload, code } = validateItem(parseJson(req.body));
      const sha = sha256hex(payload), at = ctx.nowIso();
      const key = itemKey(me, fields.kind, fields.path, fields.name);
      const prev = await store.findItemByKey(key);
      if (prev && prev.sha256 === sha && ['title', 'description', 'usage', 'libs', 'uses'].every((k) => JSON.stringify(prev[k]) === JSON.stringify(fields[k]))) {
        return json(200, publicItem(prev));     // nothing new: no new version
      }
      const profile = await store.getProfile(me);
      await store.putPayload(sha, payload);
      const git = { payload: gitBlobSha(payload), code: code === null ? null : gitBlobSha(Buffer.from(code, 'utf8')) };
      const base = { ...fields, author: me, authorName: profile?.name || undefined, sha256: sha, size: payload.length, updated: at, git };
      let item;
      if (prev) {
        item = { ...prev, ...base, version: prev.version + 1 };
        if (!item.authorName) delete item.authorName;
        await store.saveVersion(item, prev.version);
      } else {
        item = { id: ulid(ctx.now()), ...base, version: 1, created: at, adoptions: 0, reports: 0, status: 'live' };
        if (!item.authorName) delete item.authorName;
        await store.createItem(item, key);
      }
      await changed();
      return json(prev ? 200 : 201, publicItem(item));
    }],

    ['DELETE', /^\/v1\/items\/([^/]+)$/, async (req, [id]) => {
      const me = await ctx.signer(req);
      const x = ULID_RE.test(id) ? await store.getItem(id) : null;
      if (!x || x.status === 'withdrawn') throw new HttpError(404, 'no such item');
      if (x.author !== me) throw new HttpError(403, 'not yours');
      const at = ctx.nowIso();
      await store.withdrawItem(id, itemKey(x.author, x.kind, x.path, x.name), at);
      await changed();
      return json(200, { id, withdrawn: at });
    }],

    ['POST', /^\/v1\/items\/([^/]+)\/adopted$/, async (req, [id]) => {
      const me = await ctx.signer(req);
      let x = await liveItem(id);
      if (await store.addMark(id, 'adopt', me)) { x = await store.bump(id, 'adoptions'); await changed(); }
      return json(200, publicItem(x));
    }],

    ['POST', /^\/v1\/items\/([^/]+)\/report$/, async (req, [id]) => {
      const me = await ctx.signer(req);
      const b = parseJson(req.body);
      const reason = text(b?.reason, 'reason', LIMITS.reason, { required: true });
      let x = await liveItem(id), hidden = false;
      if (await store.addMark(id, 'report', me, { reason })) {
        x = await store.bump(id, 'reports');
        if (x.reports >= LIMITS.reportsToHide) hidden = await store.hideItem(id, ctx.nowIso());
        await changed();
      }
      return json(200, { id, reports: x.reports, hidden: hidden || x.status === 'hidden' });
    }],
  ];
}
