import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { newKey, signHeaders, item } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startLocalServer, main } from '../local-server.mjs';
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
  // the tags come last in a revision: once r1 is tagged, the revision is complete
  for (let i = 0; i < 200 && !gh.tags.has('r1'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(gh.tags.has('r1'), true);
  assert.ok(gh.files().has('revisions/r1.md'));
});

const until = async (cond, ms = 10_000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); };

test('changes that have not settled when the timer fires are retried once they have', async (t) => {
  const gh = await startMockGitHub();
  const github = githubClient({ token: gh.token, repo: gh.repo, apiUrl: gh.url });
  const clock = { t: Date.now() };
  const s = await startLocalServer({ port: 0, github, settleMs: 30, now: () => clock.t });
  t.after(async () => { await s.close(); await gh.close(); });
  assert.deepEqual((await raw(`${s.url}/_local/mirror`, { method: 'POST' })).json, { status: 'nothing', revisions: [], pending: 0 }, 'bootstrapped, empty');
  const k = newKey(), body = Buffer.from(JSON.stringify(item()));
  const post = await raw(`${s.url}/shared/v1/items`, { method: 'POST', body, headers: signHeaders(k, 'POST', '/v1/items', body, clock.t) });
  assert.equal(post.status, 201);
  // by this server's clock no time passes: the first run finds the change unsettled and asks again in 1 s
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(gh.files().size, 0);
  clock.t += 60_000;
  await until(() => gh.tags.has('r1'));
  assert.ok(gh.files().has('revisions/r1.md'));
});

test('without a mirror, writes schedule nothing and /_local/mirror is not served', async (t) => {
  const s = await startLocalServer({ port: 0 });
  t.after(() => s.close());
  const k = newKey(), body = Buffer.from(JSON.stringify(item()));
  assert.equal((await raw(`${s.url}/shared/v1/items`, { method: 'POST', body, headers: signHeaders(k, 'POST', '/v1/items', body, Date.now()) })).status, 201);
  assert.equal((await raw(`${s.url}/_local/mirror`, { method: 'POST' })).status, 404);
  // repeated headers that Node keeps as a list are joined (the app sees one string per header)
  const r = await raw(`${s.url}/shared/v1/index`, { headers: { 'set-cookie': ['a=1', 'b=2'] } });
  assert.equal(r.status, 200);
});

test('mirror failures: logged for timed runs, reported for runs by hand; a client without a file listing', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a));
  const github = { getHead: async () => { throw new Error('GitHub is unreachable'); } };
  const s = await startLocalServer({ port: 0, github, settleMs: 10 });
  t.after(() => s.close());
  const k = newKey(), body = Buffer.from(JSON.stringify(item()));
  assert.equal((await raw(`${s.url}/shared/v1/items`, { method: 'POST', body, headers: signHeaders(k, 'POST', '/v1/items', body, Date.now() - 60_000) })).status, 201);
  await until(() => errors.length > 0);
  assert.equal(errors[0][0], 'revisions');
  assert.equal(errors[0][1].message, 'GitHub is unreachable');
  assert.deepEqual((await raw(`${s.url}/_local/mirror?force=1`, { method: 'POST' })).json, { status: 'error', error: 'GitHub is unreachable' });
  assert.deepEqual((await raw(`${s.url}/_local/mirror`)).json, { files: [] });
});

test('the command line: memory or a data directory; a mock GitHub, or a real repository from the environment', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiui-cli-'));
  const lines = [], log = (l) => lines.push(l);
  const started = [];
  t.after(async () => { for (const x of started) { await x.server.close(); await x.mock?.close(); } rmSync(dir, { recursive: true, force: true }); });

  const a = await main(['node', 'local-server.mjs', '--port', '0', '--data', dir, '--mirror', '--settle', '1'], {}, log);
  started.push(a);
  assert.match(lines[0], new RegExp(`^shared: ${a.server.url}/shared/v1/index   users: ${a.server.url}/users/v1/find\\?q=\\.\\.\\.   data: ${dir}   mock GitHub: ${a.mock.url}$`));
  const k = newKey(), body = Buffer.from(JSON.stringify(item()));
  assert.equal((await raw(`${a.server.url}/shared/v1/items`, { method: 'POST', body, headers: signHeaders(k, 'POST', '/v1/items', body, Date.now()) })).status, 201);
  assert.equal((await raw(`${a.server.url}/_local/mirror?force=1`, { method: 'POST' })).json.status, 'committed');
  assert.ok((await raw(`${a.server.url}/_local/mirror`)).json.files.includes('revisions/r1.md'), 'the mock lists its files');
  assert.equal((await createMemoryStore({ dir }).allLive()).length, 1, 'kept in the data directory');

  const b = await main(['node', 'local-server.mjs', '--port', '0'], {}, log);
  started.push(b);
  assert.match(lines[1], /\(memory only\)$/);
  assert.equal(b.mock, null);

  const c = await main(['node', 'local-server.mjs', '--port', '0', '--mirror'], { GITHUB_TOKEN: 't', MIRROR_REPO: 'me/shared', MIRROR_BRANCH: 'dev' }, log);
  started.push(c);
  assert.match(lines[2], /\(memory only\)   mirror: me\/shared$/);
  assert.equal(c.mock, null);
});

test('run as a program it serves until stopped', async () => {
  const exitOnTerm = `data:text/javascript,process.on('SIGTERM', () => process.exit(0))`;
  const child = spawn(process.execPath, ['--import', exitOnTerm, fileURLToPath(new URL('../local-server.mjs', import.meta.url)), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.split('\n')[0]); });
    child.on('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  const url = line.match(/^shared: (http:\/\/127\.0\.0\.1:\d+)\/shared\/v1\/index/)[1];
  assert.equal((await raw(`${url}/shared/v1/index`)).status, 200);
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});
