// Small shared helpers: errors, responses, ids, hashes.
import { createHash, randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (m) => new HttpError(400, m);

export function json(status, value, headers = {}) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

export const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// The git object id of a blob with these bytes (what GitHub reports in trees).
export function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const iso = (ms) => new Date(ms).toISOString();

// ULID: 48-bit ms time + 80 random bits, Crockford base32, 26 chars.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Monotonic within a process: ids made in the same millisecond still sort in creation order.
let lastMs = -1, lastRand = 0n;
export function ulid(ms = Date.now()) {
  if (ms === lastMs) { lastRand = (lastRand + 1n) & ((1n << 80n) - 1n); }
  else { lastMs = ms; lastRand = 0n; for (const x of randomBytes(10)) lastRand = (lastRand << 8n) | BigInt(x); lastRand >>= 1n; }
  let t = ms, time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  let bits = lastRand, rand = '';
  for (let i = 0; i < 16; i++) { rand = CROCKFORD[Number(bits & 31n)] + rand; bits >>= 5n; }
  return time + rand;
}

export const APP_ID_RE = /^[0-9a-f]{64}$/;

// Opaque paging cursors.
export const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function decodeCursor(s) {
  try { const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); if (o && typeof o === 'object') return o; } catch {}
  throw bad('bad cursor');
}

export function parseJson(body) {
  if (!body || body.length === 0) throw bad('body required');
  try { return JSON.parse(Buffer.from(body).toString('utf8')); } catch { throw bad('body is not JSON'); }
}

export function parseIso(s, what) {
  const t = Date.parse(s);
  if (!s || Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(s)) throw bad(`${what} must be an ISO-8601 time`);
  return new Date(t).toISOString();
}
