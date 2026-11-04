// In-memory store, optionally persisted to a directory (state.json + payloads/<sha256>.json).
// Same interface and semantics as store/aws.mjs; used by the local server and the tests.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../util.mjs';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const newestFirst = (a, b) => (a.updated === b.updated ? (a.id < b.id ? 1 : -1) : a.updated < b.updated ? 1 : -1);

export function createMemoryStore({ dir, now = Date.now } = {}) {
  let s = { items: {}, keys: {}, marks: {}, profiles: {}, handles: {}, contacts: {}, events: {}, control: {}, meta: {}, changes: [], changeSeq: 0, states: {}, locks: {} };
  if (dir) {
    mkdirSync(join(dir, 'payloads'), { recursive: true });
    if (existsSync(join(dir, 'state.json'))) s = { ...s, ...JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) };
  }
  const payloads = new Map();
  const save = () => {
    if (!dir) return;
    writeFileSync(join(dir, 'state.json.tmp'), JSON.stringify(s));
    renameSync(join(dir, 'state.json.tmp'), join(dir, 'state.json'));
  };
  const nowSec = () => Math.floor(now() / 1000);
  const live = (x) => x.status === 'live';

  return {
    kind: 'memory',

    // ---- items
    async getItem(id) { return clone(s.items[id]) ?? null; },
    async findItemByKey(key) { const id = s.keys[key]; return id ? clone(s.items[id]) ?? null : null; },
    async createItem(item, key) {
      if (s.items[item.id] || s.keys[key]) throw new HttpError(409, 'conflict, try again');
      s.items[item.id] = clone(item); s.keys[key] = item.id; save();
    },
    async saveVersion(item, prevVersion) {
      const cur = s.items[item.id];
      if (!cur || cur.version !== prevVersion || cur.status === 'withdrawn') throw new HttpError(409, 'conflict, try again');
      s.items[item.id] = clone(item); save();
    },
    async withdrawItem(id, key, at) {
      const cur = s.items[id];
      if (!cur || cur.status === 'withdrawn') return false;
      cur.status = 'withdrawn'; cur.removedAt = at;
      if (s.keys[key] === id) delete s.keys[key];
      save(); return true;
    },
    async hideItem(id, at) {
      const cur = s.items[id];
      if (!cur || cur.status !== 'live') return false;
      cur.status = 'hidden'; cur.removedAt = at; save(); return true;
    },
    async bump(id, field) {
      const cur = s.items[id];
      if (!cur) return null;
      cur[field] = (cur[field] || 0) + 1; save(); return clone(cur);
    },
    async addMark(itemId, type, appId, data = {}) {
      const k = `${itemId}|${type}|${appId}`;
      if (s.marks[k]) return false;
      s.marks[k] = { ...data, at: new Date(now()).toISOString() }; save(); return true;
    },
    // Live items newest first (by updated, then id), optionally only updated after `since`,
    // starting after the cursor {u, id}. Returns {items, next: cursor|null}.
    async listLive({ since, after, limit }) {
      let all = Object.values(s.items).filter(live).sort(newestFirst);
      if (since) all = all.filter((x) => x.updated > since);
      if (after) all = all.filter((x) => x.updated < after.u || (x.updated === after.u && x.id < after.id));
      const items = all.slice(0, limit);
      const last = items[items.length - 1];
      return { items: clone(items), next: all.length > limit ? { u: last.updated, id: last.id } : null };
    },
    async allLive() { return clone(Object.values(s.items).filter(live).sort(newestFirst)); },
    async listRemoved(since) {
      return Object.values(s.items).filter((x) => x.status !== 'live' && x.removedAt > since)
        .sort((a, b) => (a.removedAt < b.removedAt ? 1 : -1)).map((x) => x.id);
    },
    async putPayload(sha, buf) {
      payloads.set(sha, Buffer.from(buf));
      if (dir) writeFileSync(join(dir, 'payloads', `${sha}.json`), buf);
    },
    async getPayload(sha) {
      if (payloads.has(sha)) return payloads.get(sha);
      if (dir && existsSync(join(dir, 'payloads', `${sha}.json`))) return readFileSync(join(dir, 'payloads', `${sha}.json`));
      return null;
    },

    // ---- profiles
    async getProfile(id) { return clone(s.profiles[id]) ?? null; },
    async putProfile(p, prevHandle) {
      if (p.handle && s.handles[p.handle] && s.handles[p.handle] !== p.id) throw new HttpError(409, 'handle taken');
      if (prevHandle && prevHandle !== p.handle && s.handles[prevHandle] === p.id) delete s.handles[prevHandle];
      if (p.handle) s.handles[p.handle] = p.id;
      s.profiles[p.id] = clone(p); save();
    },
    async deleteProfile(id, handle) {
      if (handle && s.handles[handle] === id) delete s.handles[handle];
      delete s.profiles[id]; save();
    },
    async findableProfiles() { return clone(Object.values(s.profiles).filter((p) => p.findable)); },

    // ---- contacts: s.contacts[owner][id] = {owner, id, note, added}
    async getContact(owner, id) { return clone(s.contacts[owner]?.[id]) ?? null; },
    async putContact(c) { (s.contacts[c.owner] ??= {})[c.id] = clone(c); save(); },
    async deleteContact(owner, id) {
      const had = !!s.contacts[owner]?.[id];
      if (had) { delete s.contacts[owner][id]; save(); }
      return had;
    },
    async listContacts(owner) { return clone(Object.values(s.contacts[owner] ?? {})); },
    async listIncoming(id) {
      return clone(Object.values(s.contacts).map((m) => m[id]).filter(Boolean));
    },

    // ---- router events: {sk, type, id, note?, at, expires}
    async addEvent(owner, ev) { (s.events[owner] ??= []).push(clone(ev)); save(); },
    async listEvents(owner, afterSk, limit) {
      const t = nowSec();
      return clone((s.events[owner] ?? []).filter((e) => e.expires > t && (!afterSk || e.sk > afterSk))
        .sort((a, b) => (a.sk < b.sk ? -1 : 1)).slice(0, limit));
    },

    // ---- control: replay marks, rate counters, small meta values
    async seen(key, ttlSec) {
      const t = nowSec(), c = s.control[key];
      if (c && c.expires > t) return true;
      s.control[key] = { n: 1, expires: t + ttlSec };
      return false;
    },
    async hit(key, ttlSec) {
      const t = nowSec(), c = s.control[key];
      if (c && c.expires > t) { c.n++; return c.n; }
      s.control[key] = { n: 1, expires: t + ttlSec };
      return 1;
    },
    // ---- the change log of the collection (revisions): {seq, at, type, id, item}
    async appendChange(c) {
      const seq = ++s.changeSeq;
      s.changes.push(clone({ ...c, seq })); save(); return seq;
    },
    async latestChangeSeq() { return s.changeSeq; },
    async listChanges(after, limit) { return clone(s.changes.filter((c) => c.seq > after).slice(0, limit)); },

    // ---- larger state documents (the revision state), and a lock for single runs
    async getState(name) { return clone(s.states[name]) ?? null; },
    async putState(name, v) { s.states[name] = clone(v); save(); },
    async acquireLock(name, owner, ttlSec) {
      const t = nowSec(), l = s.locks[name];
      if (l && l.expires > t && l.owner !== owner) return false;
      s.locks[name] = { owner, expires: t + ttlSec }; return true;
    },
    async releaseLock(name, owner) { if (s.locks[name]?.owner === owner) delete s.locks[name]; },

    async getMeta(k) { return clone(s.meta[k]) ?? null; },
    async setMeta(k, v) { s.meta[k] = clone(v); save(); },
  };
}
