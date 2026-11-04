// Test helpers: real Ed25519 keys, signed requests against the handlers, a controllable clock.
import { generateKeyPairSync, sign } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { signedMessage } from '../src/auth.mjs';

export function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  return { id, privateKey };
}

export function signHeaders(key, method, path, body, time) {
  const sig = sign(null, Buffer.from(signedMessage(method, path, String(time), body)), key.privateKey).toString('base64url');
  return { 'x-aiui-id': key.id, 'x-aiui-time': String(time), 'x-aiui-signature': sig };
}

// A world: clock, store, app and a call() helper that signs when given a key. Ed25519 signatures
// are deterministic, so each call signs a slightly different past time (else repeats are replays).
export function world(config = {}) {
  const clock = { t: Date.parse('2026-11-03T12:00:00.000Z') };
  const now = () => clock.t;
  const store = createMemoryStore({ now });
  const app = createApp({ store, now, config: { writesPerHour: 10_000, readsPerHour: 100_000, ...config } });
  let ip = 0, seq = 0;
  async function call(host, method, target, { key, body, time, headers = {}, ip: from, sigHeaders } = {}) {
    const url = new URL(target, 'http://x');
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...(key ? signHeaders(key, method, url.pathname, raw, time ?? now() - 7 * (++seq % 30_000)) : {}), ...(sigHeaders || {}), ...headers };
    const res = await app.handle({ method, host: `${host}.aiui.oeaio.com`, path: url.pathname, query: url.searchParams, headers: h, body: raw, ip: from ?? `10.0.0.${++ip % 250}` });
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.body;
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, body: res.body, text, json };
  }
  return {
    clock, now, store, app, call,
    advance(ms) { clock.t += ms; },
    shared: (m, p, o) => call('shared', m, p, o),
    users: (m, p, o) => call('users', m, p, o),
  };
}

export const item = (over = {}) => ({
  kind: 'component', name: 'gameKit', path: ['games', 'core'], title: 'Game kit', description: 'sprites and loops',
  usage: 'lib.gameKit(el, opts)', libs: ['three'], uses: [], payload: { code: 'export default function gameKit() { return 1 }', css: '.g{}' },
  ...over,
});

// Distinct, realistic-looking source of about n lines: identifiers, constants and statement shapes
// all depend on the seed, so different seeds share little.
export function code(seed, n = 40) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) + 0x6d2b79f5 >>> 0) % 100000);
  const v = ['count', 'total', 'label', 'items', 'cursor', 'width', 'height', 'score', 'speed', 'angle', 'color', 'buffer'];
  const id = () => `${seed}${v[rnd() % v.length][0].toUpperCase()}${v[rnd() % v.length].slice(1)}${rnd() % 97}`;
  const shapes = [
    () => `export function ${id()}(${id()}, ${id()}) { return ${id()} * ${rnd()} + ${id()}.${v[rnd() % v.length]}; }`,
    () => `const ${id()} = [${rnd()}, ${rnd()}, ${rnd()}].map((${id()}) => ${id()} % ${rnd() % 50 + 2});`,
    () => `if (${id()} > ${rnd()}) { ${id()}.push("${seed}:${rnd()}"); } else { ${id()} = Math.max(${id()}, ${rnd()}); }`,
    () => `for (let ${id()} = 0; ${id()} < ${rnd() % 64}; ${id()}++) ${id()}[${id()}] ^= ${rnd()};`,
    () => `export const ${id()} = { ${v[rnd() % v.length]}: ${rnd()}, ${v[rnd() % v.length]}: "${seed}-${rnd()}", step: (${id()}) => ${id()} / ${rnd() % 9 + 1} };`,
  ];
  const out = [];
  for (let i = 0; i < n; i++) out.push(shapes[rnd() % shapes.length]());
  return out.join('\n');
}
