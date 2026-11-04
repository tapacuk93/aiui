import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { newKey, signHeaders, item } from './helpers.mjs';
import { startLocalServer } from '../local-server.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { startMockGitHub } from '../mock-github.mjs';
import { githubClient } from '../src/github.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function raw(url, { method = 'GET', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, ...(host ? { host } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('the local server serves both hosts by Host header and by path prefix', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiui-services-'));
  const gh = await startMockGitHub();
  const github = Object.assign(githubClient({ token: gh.token, repo: gh.repo, apiUrl: gh.url }), { files: (b) => gh.files(b) });
  const s = await startLocalServer({ port: 0, store: createMemoryStore({ dir }), github });
  t.after(async () => { await s.close(); await gh.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = new URL(s.url).port;
  const k = newKey();

  const body = Buffer.from(JSON.stringify(item()));
  const post = await raw(`${s.url}/shared/v1/items`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signHeaders(k, 'POST', '/v1/items', body, Date.now()) } });
  assert.equal(post.status, 201, post.body.toString());
  const byHost = await raw(`${s.url}/v1/items/${post.json.id}`, { host: `shared.localhost:${port}` });
  assert.equal(byHost.status, 200);
  assert.equal(byHost.json.id, post.json.id);
  assert.equal(byHost.headers['access-control-allow-origin'], '*');
  const payload = await raw(`${s.url}/shared/v1/items/${post.json.id}/payload`);
  assert.deepEqual(payload.body, Buffer.from(JSON.stringify(item().payload)));

  const pb = Buffer.from(JSON.stringify({ name: 'Local', handle: 'local', findable: true }));
  const put = await raw(`${s.url}/v1/profile`, { method: 'PUT', host: `users.localhost:${port}`, body: pb, headers: signHeaders(k, 'PUT', '/v1/profile', pb, Date.now()) });
  assert.equal(put.status, 200);
  assert.equal((await raw(`${s.url}/users/v1/find?q=local`)).json.profiles[0].id, k.id);
  assert.equal((await raw(`${s.url}/v1/index`)).status, 404, 'no host, no prefix');

  // state survives a restart from the same directory
  const again = createMemoryStore({ dir });
  assert.equal((await again.getItem(post.json.id)).name, 'gameKit');
  assert.ok(await again.getPayload(post.json.sha256));

  const m = await raw(`${s.url}/_local/mirror?force=1`, { method: 'POST' });
  assert.equal(m.json.status, 'committed');
  assert.ok((await raw(`${s.url}/_local/mirror`)).json.files.includes('component/games/core/gameKit/payload.json'));
});

test('the local server makes a revision by itself once changes settle', async (t) => {
  const gh = await startMockGitHub();
  const github = githubClient({ token: gh.token, repo: gh.repo, apiUrl: gh.url });
  const s = await startLocalServer({ port: 0, github, settleMs: 50 });
  t.after(async () => { await s.close(); await gh.close(); });
  const k = newKey(), body = Buffer.from(JSON.stringify(item()));
  const post = await raw(`${s.url}/shared/v1/items`, { method: 'POST', body, headers: signHeaders(k, 'POST', '/v1/items', body, Date.now()) });
  assert.equal(post.status, 201);
  for (let i = 0; i < 50 && !gh.files().has('revisions/r1.md'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(gh.files().has('revisions/r1.md'));
  assert.equal(gh.tags.has('r1'), true);
});
