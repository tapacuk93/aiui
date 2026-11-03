// DynamoDB + S3 store: the same interface and semantics as store/memory.mjs.
// Uses only the AWS SDK v3 clients (part of the Lambda Node.js runtime); attribute marshalling is
// done here, so no lib-dynamodb.
//
// Tables (deploy/services.yaml):
//   items     id                     GSI live (live, liveKey=updated#id), GSI gone (gone, goneKey=removedAt#id)
//   marks     item, mark             mark = adopt#<app id> | report#<app id>
//   profiles  id                     GSI findable (findableKey)
//   handles   handle                 -> id
//   contacts  owner, id              GSI byOther (id, owner)
//   events    owner, sk              TTL expires
//   control   k                      TTL expires: replay marks, rate counters; key:<item key> -> id; meta:<name>
import { HttpError } from '../util.mjs';

export function marshall(v) {
  if (v === null) return { NULL: true };
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { B: v };
  if (Array.isArray(v)) return { L: v.filter((x) => x !== undefined).map(marshall) };
  if (typeof v === 'object') return { M: marshallMap(v) };
  throw new Error(`cannot store ${typeof v}`);
}
export function marshallMap(o) {
  const m = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) m[k] = marshall(v);
  return m;
}
export function unmarshall(a) {
  if ('S' in a) return a.S;
  if ('N' in a) return Number(a.N);
  if ('BOOL' in a) return a.BOOL;
  if ('NULL' in a) return null;
  if ('B' in a) return Buffer.from(a.B);
  if ('L' in a) return a.L.map(unmarshall);
  if ('M' in a) return unmarshallMap(a.M);
  if ('SS' in a) return [...a.SS];
  throw new Error('unknown attribute type');
}
export function unmarshallMap(m) {
  const o = {};
  for (const [k, v] of Object.entries(m || {})) o[k] = unmarshall(v);
  return o;
}

const INDEX_ATTRS = ['live', 'liveKey', 'gone', 'goneKey', 'findableKey', 'owner_', 'expires_'];
function itemToDb(x) {
  const o = { ...x };
  for (const k of INDEX_ATTRS) delete o[k];
  if (x.status === 'live') { o.live = '1'; o.liveKey = `${x.updated}#${x.id}`; }
  else if (x.removedAt) { o.gone = '1'; o.goneKey = `${x.removedAt}#${x.id}`; }
  return o;
}
function fromDb(m) {
  if (!m) return null;
  const o = unmarshallMap(m);
  for (const k of INDEX_ATTRS) delete o[k];
  return o;
}
// Every attribute in an expression is written as #name (DynamoDB has many reserved words);
// the ExpressionAttributeNames map is generated from them.
const EXPRS = ['KeyConditionExpression', 'ConditionExpression', 'UpdateExpression', 'FilterExpression'];
export function withNames(input) {
  if (Array.isArray(input.TransactItems)) {
    return { ...input, TransactItems: input.TransactItems.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, withNames(v)]))) };
  }
  const names = { ...(input.ExpressionAttributeNames || {}) };
  for (const e of EXPRS) for (const [, n] of (input[e] || '').matchAll(/#(\w+)/g)) names[`#${n}`] ??= n;
  return Object.keys(names).length ? { ...input, ExpressionAttributeNames: names } : input;
}
const isCond = (e) => e?.name === 'ConditionalCheckFailedException';
const isCanceled = (e) => e?.name === 'TransactionCanceledException';

export async function createAwsStore({ tables, bucket, region, now = Date.now, clients } = {}) {
  let ddb, s3, C;
  if (clients) ({ ddb, s3, commands: C } = clients);
  else {
    const D = await import('@aws-sdk/client-dynamodb');
    const S = await import('@aws-sdk/client-s3');
    ddb = new D.DynamoDBClient({ region });
    s3 = new S.S3Client({ region });
    C = { ...D, ...S };
  }
  const T = tables;
  const send = (name, input) => (name.endsWith('Object') ? s3 : ddb).send(new C[`${name}Command`](withNames(input)));
  const nowSec = () => Math.floor(now() / 1000);
  const S = (s) => ({ S: s });

  async function queryAll(input, max = Infinity) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const r = await send('Query', { ...input, ExclusiveStartKey });
      out.push(...(r.Items || []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey && out.length < max);
    return out;
  }
  const getItem = async (id) => fromDb((await send('GetItem', { TableName: T.items, Key: { id: S(id) }, ConsistentRead: true })).Item);

  return {
    kind: 'aws',

    // ---- items
    getItem,
    async findItemByKey(key) {
      const r = await send('GetItem', { TableName: T.control, Key: { k: S(`key:${key}`) }, ConsistentRead: true });
      return r.Item ? getItem(r.Item.id.S) : null;
    },
    async createItem(item, key) {
      try {
        await send('TransactWriteItems', { TransactItems: [
          { Put: { TableName: T.items, Item: marshallMap(itemToDb(item)), ConditionExpression: 'attribute_not_exists(#id)' } },
          { Put: { TableName: T.control, Item: marshallMap({ k: `key:${key}`, id: item.id }), ConditionExpression: 'attribute_not_exists(#k)' } },
        ] });
      } catch (e) { if (isCanceled(e)) throw new HttpError(409, 'conflict, try again'); throw e; }
    },
    async saveVersion(item, prevVersion) {
      try {
        await send('PutItem', {
          TableName: T.items, Item: marshallMap(itemToDb(item)),
          ConditionExpression: '#version = :v AND #status <> :w',
          ExpressionAttributeValues: { ':v': { N: String(prevVersion) }, ':w': S('withdrawn') },
        });
      } catch (e) { if (isCond(e)) throw new HttpError(409, 'conflict, try again'); throw e; }
    },
    async withdrawItem(id, key, at) {
      try {
        await send('TransactWriteItems', { TransactItems: [
          { Update: {
            TableName: T.items, Key: { id: S(id) },
            UpdateExpression: 'SET #status = :w, #removedAt = :at, #gone = :one, #goneKey = :gk REMOVE #live, #liveKey',
            ConditionExpression: 'attribute_exists(#id) AND #status <> :w',
            ExpressionAttributeValues: { ':w': S('withdrawn'), ':at': S(at), ':one': S('1'), ':gk': S(`${at}#${id}`) },
          } },
          { Delete: { TableName: T.control, Key: { k: S(`key:${key}`) } } },
        ] });
        return true;
      } catch (e) { if (isCanceled(e)) return false; throw e; }
    },
    async hideItem(id, at) {
      try {
        await send('UpdateItem', {
          TableName: T.items, Key: { id: S(id) },
          UpdateExpression: 'SET #status = :h, #removedAt = :at, #gone = :one, #goneKey = :gk REMOVE #live, #liveKey',
          ConditionExpression: '#status = :live',
          ExpressionAttributeValues: { ':h': S('hidden'), ':live': S('live'), ':at': S(at), ':one': S('1'), ':gk': S(`${at}#${id}`) },
        });
        return true;
      } catch (e) { if (isCond(e)) return false; throw e; }
    },
    async bump(id, field) {
      try {
        const r = await send('UpdateItem', {
          TableName: T.items, Key: { id: S(id) }, UpdateExpression: 'ADD #f :one', ConditionExpression: 'attribute_exists(#id)', ExpressionAttributeNames: { '#f': field }, ExpressionAttributeValues: { ':one': { N: '1' } }, ReturnValues: 'ALL_NEW',
        });
        return fromDb(r.Attributes);
      } catch (e) { if (isCond(e)) return null; throw e; }
    },
    async addMark(itemId, type, appId, data = {}) {
      try {
        await send('PutItem', {
          TableName: T.marks, Item: marshallMap({ ...data, item: itemId, mark: `${type}#${appId}`, at: new Date(now()).toISOString() }),
          ConditionExpression: 'attribute_not_exists(#mark)',
        });
        return true;
      } catch (e) { if (isCond(e)) return false; throw e; }
    },
    async listLive({ since, after, limit }) {
      const input = {
        TableName: T.items, IndexName: 'live', ScanIndexForward: false,
        KeyConditionExpression: since ? '#live = :one AND #liveKey > :s' : '#live = :one',
        ExpressionAttributeValues: { ':one': S('1'), ...(since ? { ':s': S(`${since}#~`) } : {}) },
      };
      const items = [];
      let ExclusiveStartKey = after ? { id: S(after.id), live: S('1'), liveKey: S(`${after.u}#${after.id}`) } : undefined;
      do {
        const r = await send('Query', { ...input, Limit: limit + 1 - items.length, ExclusiveStartKey });
        items.push(...(r.Items || []).map(fromDb));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey && items.length <= limit);
      const page = items.slice(0, limit), last = page[page.length - 1];
      return { items: page, next: items.length > limit ? { u: last.updated, id: last.id } : null };
    },
    async allLive() {
      return (await queryAll({
        TableName: T.items, IndexName: 'live', ScanIndexForward: false,
        KeyConditionExpression: '#live = :one', ExpressionAttributeValues: { ':one': S('1') },
      })).map(fromDb);
    },
    async listRemoved(since) {
      return (await queryAll({
        TableName: T.items, IndexName: 'gone', ScanIndexForward: false,
        KeyConditionExpression: '#gone = :one AND #goneKey > :s', ExpressionAttributeValues: { ':one': S('1'), ':s': S(`${since}#~`) },
      }, 5000)).map((m) => m.id.S);
    },
    async putPayload(sha, buf) {
      await send('PutObject', { Bucket: bucket, Key: `payloads/${sha}.json`, Body: buf, ContentType: 'application/json' });
    },
    async getPayload(sha) {
      try {
        const r = await send('GetObject', { Bucket: bucket, Key: `payloads/${sha}.json` });
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) { if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null; throw e; }
    },

    // ---- profiles
    async getProfile(id) { return fromDb((await send('GetItem', { TableName: T.profiles, Key: { id: S(id) }, ConsistentRead: true })).Item); },
    async putProfile(p, prevHandle) {
      const tx = [{ Put: { TableName: T.profiles, Item: marshallMap({ ...p, findableKey: p.findable ? '1' : undefined }) } }];
      if (p.handle && p.handle !== prevHandle) {
        tx.push({ Put: {
          TableName: T.handles, Item: marshallMap({ handle: p.handle, id: p.id }),
          ConditionExpression: 'attribute_not_exists(#handle) OR #id = :me', ExpressionAttributeValues: { ':me': S(p.id) },
        } });
      }
      if (prevHandle && prevHandle !== p.handle) tx.push({ Delete: { TableName: T.handles, Key: { handle: S(prevHandle) } } });
      try { await send('TransactWriteItems', { TransactItems: tx }); } catch (e) {
        if (isCanceled(e)) throw new HttpError(409, 'handle taken');
        throw e;
      }
    },
    async deleteProfile(id, handle) {
      const tx = [{ Delete: { TableName: T.profiles, Key: { id: S(id) } } }];
      if (handle) tx.push({ Delete: { TableName: T.handles, Key: { handle: S(handle) } } });
      await send('TransactWriteItems', { TransactItems: tx });
    },
    async findableProfiles() {
      return (await queryAll({
        TableName: T.profiles, IndexName: 'findable', KeyConditionExpression: '#findableKey = :one', ExpressionAttributeValues: { ':one': S('1') },
      })).map(fromDb);
    },

    // ---- contacts
    async getContact(owner, id) {
      return fromDb((await send('GetItem', { TableName: T.contacts, Key: { owner: S(owner), id: S(id) }, ConsistentRead: true })).Item);
    },
    async putContact(c) { await send('PutItem', { TableName: T.contacts, Item: marshallMap(c) }); },
    async deleteContact(owner, id) {
      const r = await send('DeleteItem', { TableName: T.contacts, Key: { owner: S(owner), id: S(id) }, ReturnValues: 'ALL_OLD' });
      return !!r.Attributes;
    },
    async listContacts(owner) {
      return (await queryAll({ TableName: T.contacts, KeyConditionExpression: '#owner = :o', ExpressionAttributeValues: { ':o': S(owner) } })).map(fromDb);
    },
    async listIncoming(id) {
      return (await queryAll({ TableName: T.contacts, IndexName: 'byOther', KeyConditionExpression: '#id = :i', ExpressionAttributeValues: { ':i': S(id) } })).map(fromDb);
    },

    // ---- router events
    async addEvent(owner, ev) { await send('PutItem', { TableName: T.events, Item: marshallMap({ ...ev, owner }) }); },
    async listEvents(owner, afterSk, limit) {
      const out = [];
      let ExclusiveStartKey;
      do {
        const r = await send('Query', {
          TableName: T.events, Limit: limit, ExclusiveStartKey,
          KeyConditionExpression: afterSk ? '#owner = :o AND #sk > :a' : '#owner = :o',
          FilterExpression: '#expires > :t',
          ExpressionAttributeValues: { ':o': S(owner), ':t': { N: String(nowSec()) }, ...(afterSk ? { ':a': S(afterSk) } : {}) },
        });
        out.push(...(r.Items || []).map(fromDb));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey && out.length < limit);
      return out.slice(0, limit).map(({ owner: _, ...e }) => e);
    },

    // ---- control
    async seen(key, ttlSec) {
      const t = nowSec();
      try {
        await send('PutItem', {
          TableName: T.control, Item: marshallMap({ k: key, expires: t + ttlSec }),
          ConditionExpression: 'attribute_not_exists(#k) OR #expires < :t', ExpressionAttributeValues: { ':t': { N: String(t) } },
        });
        return false;
      } catch (e) { if (isCond(e)) return true; throw e; }
    },
    async hit(key, ttlSec) {
      const r = await send('UpdateItem', {
        TableName: T.control, Key: { k: S(key) }, UpdateExpression: 'SET #expires = if_not_exists(#expires, :e) ADD #n :one',
        ExpressionAttributeValues: { ':e': { N: String(nowSec() + ttlSec) }, ':one': { N: '1' } }, ReturnValues: 'UPDATED_NEW',
      });
      return Number(r.Attributes.n.N);
    },
    async getMeta(k) {
      const r = await send('GetItem', { TableName: T.control, Key: { k: S(`meta:${k}`) }, ConsistentRead: true });
      return r.Item?.v ? unmarshall(r.Item.v) : null;
    },
    async setMeta(k, v) { await send('PutItem', { TableName: T.control, Item: marshallMap({ k: `meta:${k}`, v }) }); },
  };
}

export function awsStoreFromEnv(env = process.env) {
  return createAwsStore({
    region: env.AWS_REGION,
    bucket: env.PAYLOAD_BUCKET,
    tables: {
      items: env.ITEMS_TABLE, marks: env.MARKS_TABLE, profiles: env.PROFILES_TABLE, handles: env.HANDLES_TABLE,
      contacts: env.CONTACTS_TABLE, events: env.EVENTS_TABLE, control: env.CONTROL_TABLE,
    },
  });
}
