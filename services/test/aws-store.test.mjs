// The DynamoDB + S3 store against fake AWS SDK clients: every method's commands, its answers and
// how it maps AWS errors (never real AWS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createAwsStore, awsStoreFromEnv, marshall, marshallMap, unmarshall } from '../src/store/aws.mjs';
import { HttpError } from '../src/util.mjs';

const TABLES = { items: 'items', marks: 'marks', profiles: 'profiles', handles: 'handles', contacts: 'contacts', events: 'events', control: 'control', changes: 'changes' };
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const awsError = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });

// A store on fake clients. `reply(name, input, n)` answers each command (n: how many of that name
// came before); a thrown error is the AWS error. Returns the store and the commands sent.
async function fake(reply = () => ({})) {
  const sent = [];
  const commands = new Proxy({}, { get: (_, k) => class { constructor(input) { this.name = String(k).replace(/Command$/, ''); this.input = input; } } });
  const client = {
    send: async (c) => {
      const n = sent.filter((x) => x.name === c.name).length;
      sent.push(c);
      return (await reply(c.name, c.input, n)) ?? {};
    },
  };
  const store = await createAwsStore({ tables: TABLES, bucket: 'bucket', now: () => NOW, clients: { ddb: client, s3: client, commands } });
  return { store, sent, inputs: (name) => sent.filter((c) => c.name === name).map((c) => c.input) };
}
const failing = (name, error) => (n) => { if (n === name) throw error; };
const body = (s) => ({ Body: { transformToByteArray: async () => new Uint8Array(Buffer.from(s)) } });

test('marshalling: binary, string sets, and what cannot be stored', () => {
  assert.deepEqual(marshall(new Uint8Array([1, 2])), { B: new Uint8Array([1, 2]) });
  assert.deepEqual(unmarshall({ B: new Uint8Array([1, 2]) }), Buffer.from([1, 2]));
  assert.deepEqual(unmarshall(marshall(Buffer.from('ab'))), Buffer.from('ab'));
  assert.deepEqual(unmarshall({ SS: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(marshall([1, undefined, 'x']), { L: [{ N: '1' }, { S: 'x' }] });
  assert.throws(() => marshall(() => 1), /cannot store function/);
  assert.throws(() => marshall(10n), /cannot store bigint/);
  assert.throws(() => unmarshall({ NS: ['1'] }), /unknown attribute type/);
});

test('without injected clients the store uses the AWS SDK clients, configured from the environment', async (t) => {
  const ddb = [], s3 = [];
  t.mock.method(DynamoDBClient.prototype, 'send', async function (c) { ddb.push([this, c]); return { Item: marshallMap({ id: 'I', name: 'n', live: '1', liveKey: 'U#I' }) }; });
  t.mock.method(S3Client.prototype, 'send', async function (c) { s3.push([this, c]); return {}; });
  const store = await awsStoreFromEnv({
    AWS_REGION: 'eu-central-1', PAYLOAD_BUCKET: 'pb', ITEMS_TABLE: 'it', MARKS_TABLE: 'mt', PROFILES_TABLE: 'pt', HANDLES_TABLE: 'ht',
    CONTACTS_TABLE: 'ct', EVENTS_TABLE: 'et', CONTROL_TABLE: 'xt', CHANGES_TABLE: 'cht',
  });
  assert.equal(store.kind, 'aws');
  assert.deepEqual(await store.getItem('I'), { id: 'I', name: 'n' });
  const [client, cmd] = ddb[0];
  assert.ok(client instanceof DynamoDBClient);
  assert.equal(await client.config.region(), 'eu-central-1');
  assert.ok(cmd instanceof GetItemCommand);
  assert.deepEqual(cmd.input, { TableName: 'it', Key: { id: { S: 'I' } }, ConsistentRead: true });
  await store.putPayload('abc', Buffer.from('{}'));
  assert.ok(s3[0][0] instanceof S3Client);
  assert.ok(s3[0][1] instanceof PutObjectCommand);
  assert.deepEqual(s3[0][1].input, { Bucket: 'pb', Key: 'payloads/abc.json', Body: Buffer.from('{}'), ContentType: 'application/json' });
  await store.listContacts('o');
  assert.ok(ddb[1][1] instanceof QueryCommand);
  assert.equal(ddb[1][1].input.TableName, 'ct');
});

test('items: get, find by key, create, new versions', async () => {
  const stored = marshallMap({ id: 'I', status: 'live', updated: 'U', live: '1', liveKey: 'U#I', gone: 'x', goneKey: 'y', findableKey: '1', owner_: 'o', expires_: 1 });
  const { store, inputs } = await fake((name, input) => {
    if (name === 'GetItem' && input.TableName === 'control') return input.Key.k.S === 'key:k' ? { Item: { k: { S: 'key:k' }, id: { S: 'I' } } } : {};
    if (name === 'GetItem') return input.Key.id.S === 'I' ? { Item: stored } : {};
  });
  assert.deepEqual(await store.getItem('I'), { id: 'I', status: 'live', updated: 'U' }, 'index attributes are not part of the item');
  assert.equal(await store.getItem('nope'), null);
  assert.deepEqual(await store.findItemByKey('k'), { id: 'I', status: 'live', updated: 'U' });
  assert.equal(await store.findItemByKey('other'), null);
  assert.deepEqual(inputs('GetItem')[2], { TableName: 'control', Key: { k: { S: 'key:k' } }, ConsistentRead: true });

  await store.createItem({ id: 'N', status: 'live', updated: 'U2', path: ['a'] }, 'me|component|a|n');
  const tx = inputs('TransactWriteItems')[0].TransactItems;
  assert.deepEqual(tx[0].Put.Item, marshallMap({ id: 'N', status: 'live', updated: 'U2', path: ['a'], live: '1', liveKey: 'U2#N' }));
  assert.equal(tx[0].Put.ConditionExpression, 'attribute_not_exists(#id)');
  assert.deepEqual(tx[0].Put.ExpressionAttributeNames, { '#id': 'id' });
  assert.deepEqual(tx[1].Put.Item, { k: { S: 'key:me|component|a|n' }, id: { S: 'N' } });

  // a new version of an item that was hidden keeps it in the "gone" index, not the live one
  await store.saveVersion({ id: 'H', status: 'hidden', removedAt: 'R', updated: 'U3', version: 3, live: '1' }, 2);
  const put = inputs('PutItem')[0];
  assert.deepEqual(put.Item, marshallMap({ id: 'H', status: 'hidden', removedAt: 'R', updated: 'U3', version: 3, gone: '1', goneKey: 'R#H' }));
  assert.equal(put.ConditionExpression, '#version = :v AND #status <> :w');
  assert.deepEqual(put.ExpressionAttributeValues, { ':v': { N: '2' }, ':w': { S: 'withdrawn' } });
  // an item that is neither live nor removed is in no index
  await store.saveVersion({ id: 'W', status: 'draft', version: 1 }, 0);
  assert.deepEqual(inputs('PutItem')[1].Item, marshallMap({ id: 'W', status: 'draft', version: 1 }));
});

test('items: conflicts become 409, other AWS errors pass through', async () => {
  const boom = awsError('ProvisionedThroughputExceededException');
  let r = await fake(failing('TransactWriteItems', awsError('TransactionCanceledException')));
  await assert.rejects(r.store.createItem({ id: 'N', status: 'live', updated: 'U' }, 'k'), (e) => e instanceof HttpError && e.status === 409);
  r = await fake(failing('TransactWriteItems', boom));
  await assert.rejects(r.store.createItem({ id: 'N', status: 'live', updated: 'U' }, 'k'), boom);
  r = await fake(failing('PutItem', awsError('ConditionalCheckFailedException')));
  await assert.rejects(r.store.saveVersion({ id: 'N', version: 2 }, 1), (e) => e instanceof HttpError && e.status === 409 && /conflict/.test(e.message));
  r = await fake(failing('PutItem', boom));
  await assert.rejects(r.store.saveVersion({ id: 'N', version: 2 }, 1), boom);
});

test('items: withdraw, hide, counters and marks', async () => {
  const { store, inputs } = await fake((name) => (name === 'UpdateItem' ? { Attributes: marshallMap({ id: 'I', adoptions: 2, live: '1', liveKey: 'x' }) } : {}));
  assert.equal(await store.withdrawItem('I', 'k', 'AT'), true);
  const [upd, del] = inputs('TransactWriteItems')[0].TransactItems;
  assert.match(upd.Update.UpdateExpression, /SET #status = :w, #removedAt = :at, #gone = :one, #goneKey = :gk REMOVE #live, #liveKey/);
  assert.deepEqual(upd.Update.ExpressionAttributeValues[':gk'], { S: 'AT#I' });
  assert.deepEqual(del.Delete, { TableName: 'control', Key: { k: { S: 'key:k' } } });
  assert.equal(await store.hideItem('I', 'AT'), true);
  assert.deepEqual(inputs('UpdateItem')[0].ExpressionAttributeValues, { ':h': { S: 'hidden' }, ':live': { S: 'live' }, ':at': { S: 'AT' }, ':one': { S: '1' }, ':gk': { S: 'AT#I' } });
  assert.deepEqual(await store.bump('I', 'adoptions'), { id: 'I', adoptions: 2 });
  assert.deepEqual(inputs('UpdateItem')[1].ExpressionAttributeNames, { '#f': 'adoptions', '#id': 'id' });
  assert.equal(await store.addMark('I', 'report', 'APP', { reason: 'bad' }), true);
  assert.deepEqual(inputs('PutItem')[0].Item, marshallMap({ reason: 'bad', item: 'I', mark: 'report#APP', at: '2026-11-03T12:00:00.000Z' }));
  assert.equal(await store.addMark('I', 'adopt', 'APP'), true);
  assert.deepEqual(inputs('PutItem')[1].Item.mark, { S: 'adopt#APP' });

  const cond = awsError('ConditionalCheckFailedException'), boom = awsError('InternalServerError');
  let r = await fake(failing('TransactWriteItems', awsError('TransactionCanceledException')));
  assert.equal(await r.store.withdrawItem('I', 'k', 'AT'), false);
  r = await fake(failing('TransactWriteItems', boom));
  await assert.rejects(r.store.withdrawItem('I', 'k', 'AT'), boom);
  r = await fake(failing('UpdateItem', cond));
  assert.equal(await r.store.hideItem('I', 'AT'), false);
  assert.equal(await r.store.bump('I', 'reports'), null);
  r = await fake(failing('UpdateItem', boom));
  await assert.rejects(r.store.hideItem('I', 'AT'), boom);
  await assert.rejects(r.store.bump('I', 'reports'), boom);
  r = await fake(failing('PutItem', cond));
  assert.equal(await r.store.addMark('I', 'adopt', 'APP'), false);
  r = await fake(failing('PutItem', boom));
  await assert.rejects(r.store.addMark('I', 'adopt', 'APP'), boom);
});

const liveRow = (n) => marshallMap({ id: `I${n}`, updated: `U${n}`, status: 'live', live: '1', liveKey: `U${n}#I${n}` });

test('listLive pages through the live index, newest first, and returns the next cursor', async () => {
  // the index answers in pages of 2
  const { store, inputs } = await fake((name, input, n) => (n === 0 ? { Items: [liveRow(1), liveRow(2)], LastEvaluatedKey: { id: { S: 'I2' } } } : { Items: [liveRow(3), liveRow(4)], LastEvaluatedKey: { id: { S: 'I4' } } }));
  const page = await store.listLive({ limit: 3 });
  assert.deepEqual(page.items.map((x) => x.id), ['I1', 'I2', 'I3']);
  assert.deepEqual(page.items[0], { id: 'I1', updated: 'U1', status: 'live' });
  assert.deepEqual(page.next, { u: 'U3', id: 'I3' });
  const [q1, q2] = inputs('Query');
  assert.equal(q1.KeyConditionExpression, '#live = :one');
  assert.deepEqual(q1.ExpressionAttributeValues, { ':one': { S: '1' } });
  assert.equal(q1.ExclusiveStartKey, undefined);
  assert.equal(q1.Limit, 4, 'one more than the page, to know there is a next one');
  assert.deepEqual(q2.ExclusiveStartKey, { id: { S: 'I2' } });
  assert.equal(q2.Limit, 2);

  // the last page: nothing more
  const last = await fake(() => ({ Items: [liveRow(1)] }));
  assert.deepEqual(await last.store.listLive({ limit: 5 }), { items: [{ id: 'I1', updated: 'U1', status: 'live' }], next: null });
  // the index ends right after a full page (DynamoDB may still answer with a key)
  const empty = await fake((name, input, n) => (n === 0 ? { LastEvaluatedKey: { id: { S: 'x' } } } : {}));
  assert.deepEqual(await empty.store.listLive({ limit: 5 }), { items: [], next: null });
  assert.equal(empty.inputs('Query').length, 2);
});

test('whole-index reads: all live items, removed ids (at most 5000), findable profiles', async () => {
  let r = await fake((name, input, n) => (n === 0 ? { Items: [liveRow(1)], LastEvaluatedKey: { id: { S: 'I1' } } } : { Items: [liveRow(2)] }));
  assert.deepEqual((await r.store.allLive()).map((x) => x.id), ['I1', 'I2']);
  assert.equal(r.inputs('Query')[1].ExclusiveStartKey.id.S, 'I1');

  const many = Array.from({ length: 5000 }, (_, i) => ({ id: { S: `G${i}` } }));
  r = await fake(() => ({ Items: many, LastEvaluatedKey: { id: { S: 'more' } } }));
  const removed = await r.store.listRemoved('2026-01-01T00:00:00.000Z');
  assert.equal(removed.length, 5000);
  assert.equal(removed[0], 'G0');
  assert.equal(r.inputs('Query').length, 1, 'stops at 5000');
  assert.equal(r.inputs('Query')[0].IndexName, 'gone');
  assert.deepEqual(r.inputs('Query')[0].ExpressionAttributeValues[':s'], { S: '2026-01-01T00:00:00.000Z#~' });

  r = await fake(() => ({ Items: [marshallMap({ id: 'P', name: 'p', findable: true, findableKey: '1' })] }));
  assert.deepEqual(await r.store.findableProfiles(), [{ id: 'P', name: 'p', findable: true }]);
  assert.equal(r.inputs('Query')[0].IndexName, 'findable');
});

test('payloads in S3: missing ones are null, other errors pass through', async () => {
  let r = await fake((name, input) => (input.Key === 'payloads/s1.json' ? body('{"code":1}') : undefined));
  assert.deepEqual(await r.store.getPayload('s1'), Buffer.from('{"code":1}'));
  r = await fake(failing('GetObject', awsError('NoSuchKey')));
  assert.equal(await r.store.getPayload('s1'), null);
  r = await fake(failing('GetObject', awsError('NotFound', { $metadata: { httpStatusCode: 404 } })));
  assert.equal(await r.store.getPayload('s1'), null);
  const denied = awsError('AccessDenied', { $metadata: { httpStatusCode: 403 } });
  r = await fake(failing('GetObject', denied));
  await assert.rejects(r.store.getPayload('s1'), denied);
});

test('profiles and handles: one transaction; a taken handle is 409', async () => {
  const { store, inputs } = await fake((name) => (name === 'GetItem' ? { Item: marshallMap({ id: 'P', name: 'n', findableKey: '1' }) } : undefined));
  assert.deepEqual(await store.getProfile('P'), { id: 'P', name: 'n' });
  await store.putProfile({ id: 'P', name: 'n', handle: 'new', findable: true }, 'old');
  let tx = inputs('TransactWriteItems')[0].TransactItems;
  assert.deepEqual(tx[0].Put.Item, marshallMap({ id: 'P', name: 'n', handle: 'new', findable: true, findableKey: '1' }));
  assert.deepEqual(tx[1].Put.Item, marshallMap({ handle: 'new', id: 'P' }));
  assert.equal(tx[1].Put.ConditionExpression, 'attribute_not_exists(#handle) OR #id = :me');
  assert.deepEqual(tx[2].Delete, { TableName: 'handles', Key: { handle: { S: 'old' } } });
  await store.putProfile({ id: 'P', name: 'n', handle: 'same', findable: false }, 'same');
  tx = inputs('TransactWriteItems')[1].TransactItems;
  assert.equal(tx.length, 1, 'an unchanged handle is not rewritten');
  assert.equal('findableKey' in tx[0].Put.Item, false, 'not findable: not in the findable index');
  await store.putProfile({ id: 'P', name: 'n', findable: false }, null);
  assert.equal(inputs('TransactWriteItems')[2].TransactItems.length, 1);
  await store.deleteProfile('P', 'h');
  assert.deepEqual(inputs('TransactWriteItems')[3].TransactItems.map((x) => Object.values(x)[0].TableName), ['profiles', 'handles']);
  await store.deleteProfile('P', null);
  assert.equal(inputs('TransactWriteItems')[4].TransactItems.length, 1);

  let r = await fake(failing('TransactWriteItems', awsError('TransactionCanceledException')));
  await assert.rejects(r.store.putProfile({ id: 'P', name: 'n', handle: 'h' }, null), (e) => e.status === 409 && e.message === 'handle taken');
  const boom = awsError('ValidationException');
  r = await fake(failing('TransactWriteItems', boom));
  await assert.rejects(r.store.putProfile({ id: 'P', name: 'n', handle: 'h' }, null), boom);
});

test('contacts: get, put, delete, mine and incoming', async () => {
  const c = marshallMap({ owner: 'A', id: 'B', added: 'T' });
  const { store, inputs } = await fake((name, input) => {
    if (name === 'GetItem') return { Item: c };
    if (name === 'DeleteItem') return input.Key.id.S === 'B' ? { Attributes: c } : {};
    if (name === 'Query') return { Items: [c] };
  });
  assert.deepEqual(await store.getContact('A', 'B'), { owner: 'A', id: 'B', added: 'T' });
  await store.putContact({ owner: 'A', id: 'B', added: 'T', note: 'hi' });
  assert.deepEqual(inputs('PutItem')[0], { TableName: 'contacts', Item: marshallMap({ owner: 'A', id: 'B', added: 'T', note: 'hi' }) });
  assert.equal(await store.deleteContact('A', 'B'), true);
  assert.equal(await store.deleteContact('A', 'C'), false);
  assert.equal(inputs('DeleteItem')[0].ReturnValues, 'ALL_OLD');
  assert.deepEqual(await store.listContacts('A'), [{ owner: 'A', id: 'B', added: 'T' }]);
  assert.deepEqual(await store.listIncoming('B'), [{ owner: 'A', id: 'B', added: 'T' }]);
  const [mine, incoming] = inputs('Query');
  assert.deepEqual([mine.KeyConditionExpression, mine.IndexName], ['#owner = :o', undefined]);
  assert.deepEqual([incoming.KeyConditionExpression, incoming.IndexName], ['#id = :i', 'byOther']);
});

test('router events: unexpired only, after a cursor, paged up to the limit', async () => {
  const ev = (n) => marshallMap({ owner: 'O', sk: `S${n}`, type: 'incoming', id: 'X', at: 'T', expires: 2 });
  const { store, inputs } = await fake((name, input, n) => (name !== 'Query' ? undefined
    : n === 0 ? { Items: [ev(1)], LastEvaluatedKey: { sk: { S: 'S1' } } }
      : n === 1 ? { Items: [ev(2), ev(3)], LastEvaluatedKey: { sk: { S: 'S3' } } } : {}));
  await store.addEvent('O', { sk: 'S1', type: 'incoming', id: 'X' });
  assert.deepEqual(inputs('PutItem')[0].Item, marshallMap({ sk: 'S1', type: 'incoming', id: 'X', owner: 'O' }));
  const evs = await store.listEvents('O', null, 2);
  assert.deepEqual(evs, [{ sk: 'S1', type: 'incoming', id: 'X', at: 'T', expires: 2 }, { sk: 'S2', type: 'incoming', id: 'X', at: 'T', expires: 2 }]);
  const [q1, q2] = inputs('Query');
  assert.equal(q1.KeyConditionExpression, '#owner = :o');
  assert.equal(q1.FilterExpression, '#expires > :t');
  assert.deepEqual(q1.ExpressionAttributeValues, { ':o': { S: 'O' }, ':t': { N: String(NOW / 1000) } });
  assert.deepEqual(q2.ExclusiveStartKey, { sk: { S: 'S1' } });
  assert.deepEqual(await store.listEvents('O', 'S3', 2), []);
  const q3 = inputs('Query')[2];
  assert.equal(q3.KeyConditionExpression, '#owner = :o AND #sk > :a');
  assert.deepEqual(q3.ExpressionAttributeValues[':a'], { S: 'S3' });
});

test('control: replay marks, counters, meta values; errors pass through', async () => {
  const { store, inputs } = await fake((name, input) => {
    if (name === 'UpdateItem') return { Attributes: { n: { N: '5' } } };
    if (name === 'GetItem') return input.Key.k.S === 'meta:inbox:A' ? { Item: { k: input.Key.k, v: { S: 'S9' } } } : input.Key.k.S === 'meta:changeSeq' ? { Item: { n: { N: '12' } } } : {};
  });
  assert.equal(await store.seen('replay:x', 600), false);
  assert.deepEqual(inputs('PutItem')[0].Item, { k: { S: 'replay:x' }, expires: { N: String(NOW / 1000 + 600) } });
  assert.equal(await store.hit('w:x', 7200), 5);
  assert.equal(inputs('UpdateItem')[0].ReturnValues, 'UPDATED_NEW');
  assert.equal(await store.getMeta('inbox:A'), 'S9');
  assert.equal(await store.getMeta('none'), null);
  await store.setMeta('lastChange', 'T');
  assert.deepEqual(inputs('PutItem')[1].Item, { k: { S: 'meta:lastChange' }, v: { S: 'T' } });
  assert.equal(await store.latestChangeSeq(), 12);
  const none = await fake();
  assert.equal(await none.store.latestChangeSeq(), 0, 'no change yet');

  const boom = awsError('InternalServerError');
  const r = await fake(failing('PutItem', boom));
  await assert.rejects(r.store.seen('replay:x', 600), boom);
  await assert.rejects(r.store.acquireLock('revisions', 'me', 900), boom);
});

test('the change log and the revision state; the run lock', async () => {
  const { store, inputs } = await fake((name, input, n) => (name === 'Query'
    ? (n === 0 ? { Items: [marshallMap({ log: 'items', seq: 3, type: 'added', id: 'A' }), marshallMap({ log: 'items', seq: 4, type: 'hidden', id: 'B' })], LastEvaluatedKey: { seq: { N: '4' } } } : {})
    : undefined));
  assert.deepEqual(await store.listChanges(2, 1), [{ seq: 3, type: 'added', id: 'A' }], 'at most the limit');
  assert.equal(inputs('Query').length, 1);
  assert.equal(inputs('Query')[0].ConsistentRead, true);

  let r = await fake(failing('GetObject', awsError('NoSuchKey')));
  assert.equal(await r.store.getState('collection'), null);
  r = await fake(failing('GetObject', awsError('AccessDenied')));
  assert.equal(await r.store.getState('collection'), null, 'S3 says AccessDenied for a missing key without ListBucket');
  r = await fake(failing('GetObject', awsError('Unknown', { $metadata: { httpStatusCode: 404 } })));
  assert.equal(await r.store.getState('collection'), null);
  const boom = awsError('SlowDown', { $metadata: { httpStatusCode: 503 } });
  r = await fake(failing('GetObject', boom));
  await assert.rejects(r.store.getState('collection'), boom);
  r = await fake(() => body('{"revision":7}'));
  assert.deepEqual(await r.store.getState('collection'), { revision: 7 });
  await r.store.putState('collection', { revision: 8 });
  assert.deepEqual(r.inputs('PutObject')[0], { Bucket: 'bucket', Key: 'state/collection.json', Body: '{"revision":8}', ContentType: 'application/json' });

  r = await fake();
  assert.equal(await r.store.acquireLock('revisions', 'me', 900), true);
  const lock = r.inputs('PutItem')[0];
  assert.deepEqual(lock.Item, { k: { S: 'lock:revisions' }, owner: { S: 'me' }, expires: { N: String(NOW / 1000 + 900) } });
  assert.equal(lock.ConditionExpression, 'attribute_not_exists(#k) OR #expires < :t OR #owner = :o');
  await r.store.releaseLock('revisions', 'me');
  assert.deepEqual(r.inputs('DeleteItem')[0].ExpressionAttributeValues, { ':o': { S: 'me' } });
  r = await fake(failing('PutItem', awsError('ConditionalCheckFailedException')));
  assert.equal(await r.store.acquireLock('revisions', 'me', 900), false, 'held by another run');
  r = await fake(failing('DeleteItem', awsError('ConditionalCheckFailedException')));
  await r.store.releaseLock('revisions', 'me');   // taken over meanwhile: nothing to release
  r = await fake(failing('DeleteItem', boom));
  await assert.rejects(r.store.releaseLock('revisions', 'me'), boom);
});
