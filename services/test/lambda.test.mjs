// The Lambda handlers end to end, with the AWS SDK clients' send() replaced by fakes (no AWS) and
// the mock GitHub standing in for api.github.com.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { api, mirror, runMirror, apiConfig, requestRun, requestFromEvent } from '../src/lambda.mjs';
import { startMockGitHub } from '../mock-github.mjs';
import { world, newKey, signHeaders, item } from './helpers.mjs';

// One fake AWS for the whole file (the handlers keep their clients between invocations, as in
// Lambda). Each test sets `aws.<service>` to answer commands; every command is recorded.
const aws = { calls: [], ddb: () => ({}), s3: () => ({}), sqs: () => ({}), secrets: () => ({}) };
for (const [Client, name] of [[DynamoDBClient, 'ddb'], [S3Client, 's3'], [SQSClient, 'sqs'], [SecretsManagerClient, 'secrets']]) {
  mock.method(Client.prototype, 'send', async (c) => {
    const command = c.constructor.name.replace(/Command$/, '');
    aws.calls.push({ service: name, command, input: c.input });
    return (await aws[name](command, c.input)) ?? {};
  });
}
const sent = (service, command) => aws.calls.filter((c) => c.service === service && (!command || c.command === command)).map((c) => c.input);
const logs = [];
mock.method(console, 'log', (...a) => logs.push(a.join(' ')));

const QUEUE = 'https://sqs.eu-central-1.amazonaws.com/1/revisions';
Object.assign(process.env, {
  AWS_REGION: 'eu-central-1', PAYLOAD_BUCKET: 'payloads', ITEMS_TABLE: 'items', MARKS_TABLE: 'marks', PROFILES_TABLE: 'profiles',
  HANDLES_TABLE: 'handles', CONTACTS_TABLE: 'contacts', EVENTS_TABLE: 'events', CONTROL_TABLE: 'control', CHANGES_TABLE: 'changes',
  REVISIONS_QUEUE_URL: QUEUE, WRITES_PER_HOUR: '30',
});
for (const k of ['READS_PER_HOUR', 'MIRROR_SECRET', 'MIRROR_REPO', 'MIRROR_BRANCH', 'GITHUB_API_URL', 'REVIEW_SECRET']) delete process.env[k];

test('API Gateway events: missing headers, body and query; plain text bodies; Host when there is no domain name', () => {
  const bare = requestFromEvent({ rawPath: '/v1/index', requestContext: { domainName: 'shared.aiui.oeaio.com', http: { method: 'get', sourceIp: '1.1.1.1' } } });
  assert.deepEqual([bare.method, bare.host, bare.path, [...bare.query], bare.headers, bare.body.length], ['GET', 'shared.aiui.oeaio.com', '/v1/index', [], {}, 0]);
  const text = requestFromEvent({ rawPath: '/v1/profile', headers: { Host: 'users.aiui.oeaio.com' }, body: '{"name":"Ann"}', isBase64Encoded: false, requestContext: { http: { method: 'PUT' } } });
  assert.equal(text.host, 'users.aiui.oeaio.com');
  assert.equal(text.body.toString(), '{"name":"Ann"}');
});

test('the API configuration comes from the environment', async () => {
  assert.deepEqual({ ...apiConfig({}), onChange: null }, { cacheMs: 60_000, writesPerHour: 60, readsPerHour: 600, onChange: null });
  const cfg = apiConfig({ WRITES_PER_HOUR: '5', READS_PER_HOUR: '7', REVISIONS_QUEUE_URL: 'q' });
  assert.deepEqual([cfg.writesPerHour, cfg.readsPerHour], [5, 7]);
  aws.calls = [];
  await cfg.onChange();   // a change asks for a revisions run once changes settle (90 s)
  assert.deepEqual(sent('sqs', 'SendMessage'), [{ QueueUrl: 'q', MessageBody: '{"run":"revisions"}', DelaySeconds: 90 }]);
});

test('asking for a revisions run: the delay is whole seconds within SQS limits (0-900)', async () => {
  aws.calls = [];
  const env = { REVISIONS_QUEUE_URL: QUEUE };
  for (const s of [1.6, -5, 3600]) await requestRun(s, env);
  assert.deepEqual(sent('sqs').map((x) => x.DelaySeconds), [2, 0, 900]);
  await requestRun(undefined, env);
  assert.equal(sent('sqs')[3].DelaySeconds, 90, 'the settle time by default');
});

test('api: a signed share through API Gateway is stored in DynamoDB and S3 and asks for a revision', async () => {
  aws.calls = [];
  const items = new Map();
  aws.ddb = (command, input) => {
    if (command === 'UpdateItem') return { Attributes: { n: { N: '1' } } };
    if (command === 'TransactWriteItems') { const put = input.TransactItems[0].Put; items.set(put.Item.id.S, put.Item); }
    if (command === 'GetItem' && input.TableName === 'items') return { Item: items.get(input.Key.id.S) };
    return {};
  };
  const payloads = new Map();
  aws.s3 = (command, input) => {
    if (command === 'PutObject') payloads.set(input.Key, input.Body);
    if (command === 'GetObject') return { Body: { transformToByteArray: async () => new Uint8Array(payloads.get(input.Key)) } };
  };
  const key = newKey(), body = Buffer.from(JSON.stringify(item()));
  const res = await api({
    rawPath: '/v1/items', headers: { 'Content-Type': 'application/json', ...signHeaders(key, 'POST', '/v1/items', body, Date.now()) },
    body: body.toString('base64'), isBase64Encoded: true,
    requestContext: { domainName: 'shared.aiui.oeaio.com', http: { method: 'POST', sourceIp: '1.2.3.4' } },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.isBase64Encoded, false);
  const shared = JSON.parse(res.body);
  assert.equal(shared.author, key.id);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  // the write budget comes from WRITES_PER_HOUR (30): the counter is checked against it
  assert.ok(sent('ddb', 'UpdateItem').some((u) => u.Key.k.S.startsWith(`w:${key.id}:`)));
  assert.equal(sent('ddb', 'TransactWriteItems')[0].TransactItems[0].Put.TableName, 'items');
  assert.deepEqual(sent('s3', 'PutObject')[0].Key, `payloads/${shared.sha256}.json`);
  assert.equal(sent('ddb', 'PutItem').find((p) => p.TableName === 'changes').Item.type.S, 'added');
  assert.deepEqual(sent('sqs', 'SendMessage'), [{ QueueUrl: QUEUE, MessageBody: '{"run":"revisions"}', DelaySeconds: 90 }]);

  // the same (warm) handler serves the payload bytes, base64-encoded for API Gateway
  const payload = await api({ rawPath: `/v1/items/${shared.id}/payload`, requestContext: { domainName: 'shared.aiui.oeaio.com', http: { method: 'GET', sourceIp: '1.2.3.4' } } });
  assert.equal(payload.statusCode, 200);
  assert.equal(payload.isBase64Encoded, true);
  assert.deepEqual(JSON.parse(Buffer.from(payload.body, 'base64')), item().payload);
  assert.equal(payload.headers['x-aiui-sha256'], shared.sha256);
});

test('the mirror: token from Secrets Manager, revisions on GitHub, AI review off when its secret fails', async (t) => {
  const gh = await startMockGitHub({ token: 'gh-token' });
  t.after(() => gh.close());
  const w = world();
  w.clock.t = Date.now() - 3600_000;   // the changes settled long ago
  const key = newKey();
  assert.equal((await w.shared('POST', '/v1/items', { key, body: item() })).status, 201);

  aws.calls = [];
  aws.secrets = (command, input) => {
    if (input.SecretId === 'aiui/github-mirror') return {};   // the default secret, still empty
    if (input.SecretId === 'aiui/mirror-json') return { SecretString: ' {"token": "gh-token"} ' };
    if (input.SecretId === 'aiui/review') throw Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' });
  };
  await assert.rejects(runMirror({}, { store: w.store, env: {} }), /the mirror secret holds no token/);
  assert.equal(await w.store.acquireLock('revisions', 'probe', 1), true, 'a failed run releases the lock');
  await w.store.releaseLock('revisions', 'probe');

  const env = { MIRROR_SECRET: 'aiui/mirror-json', MIRROR_REPO: gh.repo, GITHUB_API_URL: gh.url, MIRROR_BRANCH: 'main', REVIEW_SECRET: 'aiui/review', REVISIONS_QUEUE_URL: QUEUE };
  logs.length = 0;
  const r = await runMirror({ force: true }, { store: w.store, env });
  assert.equal(r.status, 'committed');
  assert.deepEqual(r.revisions.map((x) => x.n), [1]);
  assert.ok(gh.files().has('revisions/r1.md'));
  assert.ok(gh.files().has('component/games/core/gameKit/payload.json'));
  assert.deepEqual(sent('secrets').map((x) => x.SecretId), ['aiui/github-mirror', 'aiui/review', 'aiui/mirror-json']);
  assert.ok(logs.includes('AI review off: AccessDeniedException'));
  assert.ok(logs.some((l) => l === JSON.stringify({ status: 'committed', revisions: [r.revisions[0].message] })));

  // the defaults: the token is kept from the previous run; repository and API are GitHub's
  const realFetch = globalThis.fetch;
  const urls = [];
  t.mock.method(globalThis, 'fetch', (url, init) => { urls.push(url); return realFetch(url.replace('https://api.github.com', gh.url), init); });
  aws.calls = [];
  w.advance(1000);
  assert.equal((await w.shared('POST', '/v1/items', { key, body: item({ name: 'second', payload: { code: 'export const second = 2;' } }) })).status, 201);
  const again = await runMirror({}, { store: w.store, env: {} });
  assert.equal(again.status, 'committed');
  assert.deepEqual(sent('secrets'), [], 'the token is fetched once per warm Lambda');
  assert.ok(urls.length && urls.every((u) => u.startsWith('https://api.github.com/repos/tapacuk93/aiui-shared/')));
  assert.ok(gh.files('main').has('revisions/r2.md'));
});

test('the mirror handler uses the AWS store; a busy run asks for another one in a minute', async () => {
  aws.calls = [];
  aws.ddb = (command) => { if (command === 'PutItem') throw Object.assign(new Error('held'), { name: 'ConditionalCheckFailedException' }); };
  const r = await mirror({ force: true });
  assert.deepEqual(r, { status: 'busy', revisions: [] });
  const lock = sent('ddb', 'PutItem')[0];
  assert.equal(lock.TableName, 'control');
  assert.equal(lock.Item.k.S, 'lock:revisions');
  assert.deepEqual(sent('sqs', 'SendMessage'), [{ QueueUrl: QUEUE, MessageBody: '{"run":"revisions"}', DelaySeconds: 60 }]);
});
