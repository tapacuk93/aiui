// users.aiui.oeaio.com: opt-in profiles, finding users, contacts and the router (mutual identification).
import { HttpError, bad, json, ulid, APP_ID_RE, parseJson } from './util.mjs';
import { hasSignature, authenticate } from './auth.mjs';

export const USER_LIMITS = { name: 60, about: 280, note: 280, find: 20, contacts: 1000, inboxPage: 100, eventDays: 30 };
const HANDLE_RE = /^[a-z0-9_-]{3,30}$/;
const chars = (s) => [...s].length;

export function publicProfile(p) {
  const o = { id: p.id, name: p.name };
  if (p.handle) o.handle = p.handle;
  if (p.about) o.about = p.about;
  o.findable = p.findable; o.updated = p.updated;
  return o;
}

export function usersRoutes(ctx) {
  const { store } = ctx;
  const appId = (id) => { if (!APP_ID_RE.test(id)) throw bad('id must be 64 lowercase hex'); return id; };

  async function event(owner, type, id, extra = {}) {
    const ms = ctx.now(), at = new Date(ms).toISOString();
    await store.addEvent(owner, { sk: `${at}#${ulid(ms)}`, type, id, ...extra, at, expires: Math.floor(ms / 1000) + USER_LIMITS.eventDays * 86400 });
  }
  async function removeContact(me, id) {
    if (!(await store.deleteContact(me, id))) return false;
    await event(id, 'removed', me);
    return true;
  }
  const mutual = async (a, b) => !!(await store.getContact(a, b)) && !!(await store.getContact(b, a));

  async function entry(me, id, mine, theirs) {
    const p = await store.getProfile(id);
    let e;
    if (mine && theirs) e = { id, state: 'mutual', since: mine.added > theirs.added ? mine.added : theirs.added };
    else if (mine) e = { id, state: 'pending', added: mine.added };
    else e = { id, state: 'incoming', added: theirs.added };
    if (p && (p.findable || e.state === 'mutual')) e.name = p.name;
    if (mine?.note) e.note = mine.note;
    if (!mine && theirs?.note) e.note = theirs.note;
    return e;
  }

  return [
    ['PUT', /^\/v1\/profile$/, async (req) => {
      const me = await ctx.signer(req);
      const b = parseJson(req.body);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be an object');
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || chars(name) > USER_LIMITS.name) throw bad('name: 1-60 characters');
      let handle = b.handle ?? null;
      if (handle === '') handle = null;
      if (handle !== null && (typeof handle !== 'string' || !HANDLE_RE.test(handle))) throw bad('handle: 3-30 of a-z 0-9 _ -');
      const about = b.about ?? '';
      if (typeof about !== 'string' || chars(about) > USER_LIMITS.about) throw bad('about: at most 280 characters');
      if (b.findable !== undefined && typeof b.findable !== 'boolean') throw bad('findable must be true or false');
      const prev = await store.getProfile(me);
      const p = { id: me, name, findable: b.findable ?? prev?.findable ?? false, updated: ctx.nowIso() };
      if (handle) p.handle = handle;
      if (about) p.about = about;
      await store.putProfile(p, prev?.handle || null);
      return json(200, publicProfile(p));
    }],

    ['DELETE', /^\/v1\/profile$/, async (req) => {
      const me = await ctx.signer(req);
      const prev = await store.getProfile(me);
      if (prev) await store.deleteProfile(me, prev.handle || null);
      let contacts = 0;
      for (const c of await store.listContacts(me)) if (await removeContact(me, c.id)) contacts++;
      return json(200, { id: me, deleted: !!prev, contactsRemoved: contacts });
    }],

    ['GET', /^\/v1\/profiles\/([^/]+)$/, async (req, [id]) => {
      appId(id);
      const viewer = hasSignature(req.headers) ? await authenticate(req, ctx) : null;
      const p = await store.getProfile(id);
      if (!p) throw new HttpError(404, 'no such profile');
      if (p.findable) return json(200, publicProfile(p));
      if (!viewer || (viewer !== id && !(await mutual(viewer, id)))) throw new HttpError(404, 'no such profile');
      return json(200, publicProfile(p), { 'cache-control': 'private, no-store' });
    }],

    ['GET', /^\/v1\/find$/, async (req) => {
      let q = (req.query.get('q') || '').trim().toLowerCase();
      if (!q) throw bad('q required');
      if (q.length > 100) throw bad('q is too long');
      if (APP_ID_RE.test(q)) {
        const p = await store.getProfile(q);
        if (!p || !p.findable) throw new HttpError(404, 'no such profile');
        return json(200, { profiles: [publicProfile(p)] });
      }
      if (q.startsWith('@')) q = q.slice(1);
      const scored = [];
      for (const p of await ctx.findableProfiles()) {
        const h = p.handle || '', n = p.name.toLowerCase();
        let s = 0;
        if (h && h === q) s = 1000;
        else if (h && h.startsWith(q)) s = 500;
        else if (n === q) s = 300;
        else if (n.startsWith(q)) s = 200;
        else if (n.split(/\s+/).some((w) => w.startsWith(q))) s = 150;
        else if (n.includes(q) || (h && h.includes(q))) s = 100;
        if (s) scored.push([s, p]);
      }
      scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
      return json(200, { profiles: scored.slice(0, USER_LIMITS.find).map(([, p]) => publicProfile(p)) }, { 'cache-control': 'public, max-age=60' });
    }],

    ['POST', /^\/v1\/contacts$/, async (req) => {
      const me = await ctx.signer(req);
      const b = parseJson(req.body);
      const id = appId(typeof b?.id === 'string' ? b.id : '');
      if (id === me) throw bad('that is your own id');
      const note = b.note ?? '';
      if (typeof note !== 'string' || chars(note) > USER_LIMITS.note) throw bad('note: at most 280 characters');
      const prev = await store.getContact(me, id);
      const c = { owner: me, id, added: prev?.added || ctx.nowIso() };
      if (note) c.note = note;
      if (!prev && (await store.listContacts(me)).length >= USER_LIMITS.contacts) throw bad('too many contacts');
      await store.putContact(c);
      const theirs = await store.getContact(id, me);
      if (!prev) {
        if (theirs) { await event(me, 'mutual', id); await event(id, 'mutual', me); }
        else await event(id, 'incoming', me, note ? { note } : {});
      }
      return json(prev ? 200 : 201, await entry(me, id, c, theirs));
    }],

    ['DELETE', /^\/v1\/contacts\/([^/]+)$/, async (req, [id]) => {
      const me = await ctx.signer(req);
      appId(id);
      if (!(await removeContact(me, id))) throw new HttpError(404, 'not a contact');
      return json(200, { id, removed: true });
    }],

    ['GET', /^\/v1\/contacts$/, async (req) => {
      const me = await authenticate(req, ctx);
      const mine = new Map((await store.listContacts(me)).map((c) => [c.id, c]));
      const theirs = new Map((await store.listIncoming(me)).map((c) => [c.owner, c]));
      const ids = new Set([...mine.keys(), ...theirs.keys()]);
      const out = [];
      for (const id of ids) out.push(await entry(me, id, mine.get(id), theirs.get(id)));
      const t = (e) => e.since || e.added;
      out.sort((a, b) => (t(a) < t(b) ? 1 : t(a) > t(b) ? -1 : 0));
      return json(200, { contacts: out }, { 'cache-control': 'private, no-store' });
    }],

    ['GET', /^\/v1\/router\/inbox$/, async (req) => {
      const me = await authenticate(req, ctx);
      const cursorKey = `inbox:${me}`;
      const after = await store.getMeta(cursorKey);
      const evs = await store.listEvents(me, after, USER_LIMITS.inboxPage);
      if (evs.length) await store.setMeta(cursorKey, evs[evs.length - 1].sk);
      const events = evs.map(({ type, id, note, at }) => (type === 'incoming' ? { type, id, note: note || '', at } : { type, id, at }));
      return json(200, { events, more: evs.length === USER_LIMITS.inboxPage }, { 'cache-control': 'private, no-store' });
    }],
  ];
}
