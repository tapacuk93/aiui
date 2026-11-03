// Request signatures (docs/shared-and-users.md, "App identity").
//   message = "aiui/v1\n<METHOD>\n<path>\n<X-AIUI-Time>\n<sha256 hex of the raw body>"
//   X-AIUI-Signature = base64url (no padding) Ed25519 signature by the key whose raw public bytes
//   are X-AIUI-Id (64 lowercase hex). Time within 5 minutes; the same (id, time, signature) is
//   accepted once in 10 minutes.
import { createPublicKey, verify } from 'node:crypto';
import { HttpError, sha256hex, APP_ID_RE } from './util.mjs';

export const SKEW_MS = 5 * 60 * 1000;
export const REPLAY_SECONDS = 10 * 60;

export function signedMessage(method, path, time, body) {
  return `aiui/v1\n${method.toUpperCase()}\n${path}\n${time}\n${sha256hex(body && body.length ? body : Buffer.alloc(0))}`;
}

export function hasSignature(headers) {
  return !!(headers['x-aiui-id'] || headers['x-aiui-signature'] || headers['x-aiui-time']);
}

function publicKey(id) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(id, 'hex').toString('base64url') }, format: 'jwk' });
}

// Returns the verified app id or throws 401 / 409.
export async function authenticate(req, { store, now }) {
  const h = req.headers;
  const id = h['x-aiui-id'], time = h['x-aiui-time'], sig = h['x-aiui-signature'];
  if (!id || !time || !sig) throw new HttpError(401, 'signature required');
  if (!APP_ID_RE.test(id)) throw new HttpError(401, 'bad X-AIUI-Id');
  if (!/^\d{1,16}$/.test(time)) throw new HttpError(401, 'bad X-AIUI-Time');
  if (Math.abs(now() - Number(time)) > SKEW_MS) throw new HttpError(401, 'X-AIUI-Time is more than 5 minutes off');
  if (!/^[A-Za-z0-9_-]{86}$/.test(sig)) throw new HttpError(401, 'bad X-AIUI-Signature');
  let ok = false;
  try {
    ok = verify(null, Buffer.from(signedMessage(req.method, req.path, time, req.body)), publicKey(id), Buffer.from(sig, 'base64url'));
  } catch { ok = false; }
  if (!ok) throw new HttpError(401, 'bad signature');
  if (await store.seen(`replay:${id}:${time}:${sig}`, REPLAY_SECONDS)) throw new HttpError(409, 'replayed request');
  return id;
}
