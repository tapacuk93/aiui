import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, newKey, signHeaders, item } from './helpers.mjs';
import { signedMessage } from '../src/auth.mjs';

test('the signed message format', () => {
  assert.equal(signedMessage('post', '/v1/items', '1700000000000', Buffer.alloc(0)),
    'aiui/v1\nPOST\n/v1/items\n1700000000000\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(signedMessage('PUT', '/v1/profile', '1', Buffer.from('{}')).split('\n')[4],
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
});

test('a valid signature is accepted', async () => {
  const w = world(), k = newKey();
  const r = await w.shared('POST', '/v1/items', { key: k, body: item() });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.author, k.id);
});

test('missing, malformed and wrong signatures are 401', async () => {
  const w = world(), k = newKey(), other = newKey();
  const body = Buffer.from(JSON.stringify(item()));
  assert.equal((await w.shared('POST', '/v1/items', { body })).status, 401);
  const good = signHeaders(k, 'POST', '/v1/items', body, w.now());
  const cases = [
    { ...good, 'x-aiui-id': good['x-aiui-id'].toUpperCase() },                       // not lowercase hex
    { ...good, 'x-aiui-id': other.id },                                                // someone else's key
    { ...good, 'x-aiui-signature': good['x-aiui-signature'] + '=' },                  // padding
    { ...good, 'x-aiui-time': String(w.now() + 1) },                                   // time not what was signed
    { ...good, 'x-aiui-time': 'soon' },
    signHeaders(k, 'PUT', '/v1/items', body, w.now()),                                 // other method
    signHeaders(k, 'POST', '/v1/items/x', body, w.now()),                              // other path
    signHeaders(k, 'POST', '/v1/items', Buffer.from('{}'), w.now()),                   // other body
    signHeaders(other, 'POST', '/v1/items', body, w.now()),                            // other key, my id below
  ];
  cases[cases.length - 1]['x-aiui-id'] = k.id;
  for (const h of cases) {
    const r = await w.shared('POST', '/v1/items', { body, sigHeaders: h });
    assert.equal(r.status, 401, JSON.stringify(h));
    assert.ok(r.json.error);
  }
});

test('the 5-minute window', async () => {
  const w = world(), k = newKey();
  const at = (dt, name) => w.shared('POST', '/v1/items', { key: k, body: item({ name }), time: w.now() + dt });
  assert.equal((await at(-6 * 60_000, 'a')).status, 401);
  assert.equal((await at(6 * 60_000, 'b')).status, 401);
  assert.equal((await at(-4 * 60_000, 'c')).status, 201);
  assert.equal((await at(4 * 60_000, 'd')).status, 201);
});

test('a replayed request is 409', async () => {
  const w = world(), k = newKey();
  const body = Buffer.from(JSON.stringify(item()));
  const h = signHeaders(k, 'POST', '/v1/items', body, w.now());
  assert.equal((await w.shared('POST', '/v1/items', { body, sigHeaders: h })).status, 201);
  const again = await w.shared('POST', '/v1/items', { body, sigHeaders: h });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /replay/);
  // a fresh signature of the same request is fine
  w.advance(1);
  assert.equal((await w.shared('POST', '/v1/items', { key: k, body })).status, 200);
});

test('signed GETs are verified too (empty body)', async () => {
  const w = world(), k = newKey();
  assert.equal((await w.users('GET', '/v1/contacts')).status, 401);
  assert.equal((await w.users('GET', '/v1/contacts', { key: k })).status, 200);
  const h = signHeaders(k, 'GET', '/v1/contacts', Buffer.from('x'), w.now());
  assert.equal((await w.users('GET', '/v1/contacts', { sigHeaders: h })).status, 401);
});
