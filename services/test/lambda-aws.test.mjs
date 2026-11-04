// The Lambda adapter and the DynamoDB marshalling (the AWS store itself needs AWS or DynamoDB Local).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestFromEvent, responseToResult, requestRun } from '../src/lambda.mjs';
import { marshall, unmarshall, marshallMap, unmarshallMap, withNames, createAwsStore } from '../src/store/aws.mjs';

test('API Gateway HTTP API events become requests; binary responses are base64', () => {
  const req = requestFromEvent({
    rawPath: '/v1/items', rawQueryString: 'q=a%20b&kind=util',
    headers: { Host: 'shared.aiui.oeaio.com', 'X-AIUI-Id': 'abc' },
    body: Buffer.from('{"a":1}').toString('base64'), isBase64Encoded: true,
    requestContext: { domainName: 'shared.aiui.oeaio.com', http: { method: 'post', sourceIp: '1.2.3.4' } },
  });
  assert.equal(req.method, 'POST');
  assert.equal(req.host, 'shared.aiui.oeaio.com');
  assert.equal(req.path, '/v1/items');
  assert.equal(req.query.get('q'), 'a b');
  assert.equal(req.headers['x-aiui-id'], 'abc');
  assert.equal(req.body.toString(), '{"a":1}');
  assert.equal(req.ip, '1.2.3.4');
  assert.deepEqual(responseToResult({ status: 200, headers: {}, body: Buffer.from('xy') }), { statusCode: 200, headers: {}, body: 'eHk=', isBase64Encoded: true });
  assert.equal(responseToResult({ status: 200, headers: {}, body: '{}' }).isBase64Encoded, false);
});

test('marshalling round-trips the shapes the store keeps', () => {
  const v = { s: 'x', e: '', n: 3, f: 1.5, b: true, z: null, l: ['a', 1, { m: [] }], m: { git: { payload: 'p', code: null } }, u: undefined };
  const m = marshallMap(v);
  assert.equal('u' in m, false);
  assert.deepEqual(m.n, { N: '3' });
  const { u, ...rest } = v;
  assert.deepEqual(unmarshallMap(m), rest);
  assert.deepEqual(unmarshall(marshall(['x'])), ['x']);
});

test('expression attribute names are generated, also inside transactions', () => {
  assert.deepEqual(withNames({ KeyConditionExpression: '#owner = :o AND #sk > :a', FilterExpression: '#expires > :t' }).ExpressionAttributeNames,
    { '#owner': 'owner', '#sk': 'sk', '#expires': 'expires' });
  assert.deepEqual(withNames({ UpdateExpression: 'ADD #f :one', ExpressionAttributeNames: { '#f': 'adoptions' } }).ExpressionAttributeNames, { '#f': 'adoptions' });
  const t = withNames({ TransactItems: [{ Put: { ConditionExpression: 'attribute_not_exists(#id)' } }, { Delete: { Key: {} } }] });
  assert.deepEqual(t.TransactItems[0].Put.ExpressionAttributeNames, { '#id': 'id' });
  assert.equal(t.TransactItems[1].Delete.ExpressionAttributeNames, undefined);
});

test('the AWS store sends the expected commands (fake clients)', async () => {
  const sent = [];
  const fake = (name) => class { constructor(input) { this.name = name; this.input = input; } };
  const commands = Object.fromEntries(['GetItem', 'PutItem', 'UpdateItem', 'DeleteItem', 'Query', 'TransactWriteItems', 'PutObject', 'GetObject'].map((n) => [`${n}Command`, fake(n)]));
  const replies = { UpdateItem: { Attributes: { n: { N: '2' } } }, Query: { Items: [] }, GetItem: {} };
  const client = { send: async (c) => { sent.push(c); if (c.name === 'PutItem' && c.input.TableName === 'control' && sent.filter((x) => x.name === 'PutItem').length > 1) { throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }); } return replies[c.name] || {}; } };
  const store = await createAwsStore({ tables: { items: 'items', control: 'control', marks: 'marks', profiles: 'profiles', handles: 'handles', contacts: 'contacts', events: 'events' }, bucket: 'b', clients: { ddb: client, s3: client, commands } });
  assert.equal(await store.seen('replay:x', 600), false);
  assert.equal(await store.seen('replay:x', 600), true);
  assert.equal(await store.hit('w:x:1', 7200), 2);
  await store.listLive({ since: '2026-01-01T00:00:00.000Z', after: { u: '2026-02-01T00:00:00.000Z', id: 'ID' }, limit: 10 });
  const q = sent.find((c) => c.name === 'Query').input;
  assert.equal(q.IndexName, 'live');
  assert.equal(q.ScanIndexForward, false);
  assert.deepEqual(q.ExclusiveStartKey, { id: { S: 'ID' }, live: { S: '1' }, liveKey: { S: '2026-02-01T00:00:00.000Z#ID' } });
  assert.deepEqual(q.ExpressionAttributeValues[':s'], { S: '2026-01-01T00:00:00.000Z#~' });
  await store.createItem({ id: 'I', status: 'live', updated: 'U', path: [] }, 'k');
  const tx = sent.find((c) => c.name === 'TransactWriteItems').input.TransactItems;
  assert.deepEqual(tx[0].Put.Item.liveKey, { S: 'U#I' });
  assert.deepEqual(tx[1].Put.Item.k, { S: 'key:k' });
});

test('the AWS store: change log, revision state in S3, run lock', async () => {
  const sent = [];
  const fake = (name) => class { constructor(input) { this.name = name; this.input = input; } };
  const commands = Object.fromEntries(['GetItem', 'PutItem', 'UpdateItem', 'DeleteItem', 'Query', 'TransactWriteItems', 'PutObject', 'GetObject'].map((n) => [`${n}Command`, fake(n)]));
  const client = { send: async (c) => {
    sent.push(c);
    if (c.name === 'UpdateItem') return { Attributes: { n: { N: '7' } } };
    if (c.name === 'Query') return { Items: [{ log: { S: 'items' }, seq: { N: '8' }, type: { S: 'added' }, id: { S: 'I' }, at: { S: 'T' }, item: { NULL: true } }] };
    if (c.name === 'GetObject') return { Body: { transformToByteArray: async () => Buffer.from('{"revision":3}') } };
    return {};
  } };
  const store = await createAwsStore({ tables: { items: 'items', control: 'control', changes: 'changes' }, bucket: 'b', clients: { ddb: client, s3: client, commands } });
  assert.equal(await store.appendChange({ type: 'added', id: 'I', at: 'T', item: null }), 7);
  const put = sent.find((c) => c.name === 'PutItem' && c.input.TableName === 'changes').input.Item;
  assert.deepEqual([put.log, put.seq], [{ S: 'items' }, { N: '7' }]);
  assert.deepEqual(await store.listChanges(7, 10), [{ seq: 8, type: 'added', id: 'I', at: 'T', item: null }]);
  const q = sent.find((c) => c.name === 'Query').input;
  assert.equal(q.KeyConditionExpression, '#log = :l AND #seq > :a');
  assert.deepEqual(q.ExpressionAttributeNames, { '#log': 'log', '#seq': 'seq' });
  assert.deepEqual(await store.getState('collection'), { revision: 3 });
  await store.putState('collection', { revision: 4 });
  assert.equal(sent.find((c) => c.name === 'PutObject').input.Key, 'state/collection.json');
  assert.equal(await store.acquireLock('revisions', 'me', 900), true);
  await store.releaseLock('revisions', 'me');
  const lock = sent.filter((c) => c.input.Key?.k?.S === 'lock:revisions' || c.input.Item?.k?.S === 'lock:revisions');
  assert.equal(lock.length, 2);
});

test('without a queue, asking for a run is a no-op (the schedule catches up)', async () => {
  await requestRun(90, {});
});
