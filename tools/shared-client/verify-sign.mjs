// Checks the app's request signing independently: node:crypto Ed25519, the contract's message
// rebuilt here from the request (not taken from the app), and the id derived from the same seed.
//   <harness> sign | node tools/shared-client/verify-sign.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fromB64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ✓ ' : '  ✗ ') + what); if (!ok) failures++; };

// The id: the raw public key of the seed, as node derives it.
const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(input.seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
const pub = crypto.createPublicKey(priv);
const pubRaw = pub.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
check(pubRaw === input.id, `id = hex of the raw public key (${input.id.slice(0, 12)}…)`);

for (const c of input.cases) {
  const h = c.headers;
  const path = c.path.split('?')[0];
  const message = `aiui/v1\n${c.method}\n${path}\n${h['X-AIUI-Time']}\n${sha(Buffer.from(c.body, 'utf8'))}`;
  check(message === c.message, `${c.method} ${c.path}: message matches the contract`);
  check(h['X-AIUI-Id'] === input.id, `${c.method} ${c.path}: X-AIUI-Id`);
  check(/^\d{13}$/.test(h['X-AIUI-Time']), `${c.method} ${c.path}: X-AIUI-Time in ms`);
  check(!/[+/=]/.test(h['X-AIUI-Signature']) && fromB64u(h['X-AIUI-Signature']).length === 64, `${c.method} ${c.path}: base64url signature, no padding, 64 bytes`);
  check(crypto.verify(null, Buffer.from(message, 'utf8'), pub, fromB64u(h['X-AIUI-Signature'])), `${c.method} ${c.path}: Ed25519 signature verifies`);
  const tampered = message.replace(c.method, c.method === 'GET' ? 'PUT' : 'GET');
  check(!crypto.verify(null, Buffer.from(tampered, 'utf8'), pub, fromB64u(h['X-AIUI-Signature'])), `${c.method} ${c.path}: a changed message does not verify`);
}
const empty = input.cases.find((c) => c.body === '');
check(empty.message.endsWith('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), 'empty body → sha256 of empty');
console.log(failures ? `${failures} FAILED` : 'SIGNING OK');
process.exit(failures ? 1 : 0);
