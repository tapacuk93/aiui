#!/usr/bin/env node
// Serves shared.aiui.oeaio.com and users.aiui.oeaio.com on localhost with the same handlers as the
// Lambda. The service is picked by Host (shared.localhost:8787, users.localhost:8787) or by a path
// prefix (http://localhost:8787/shared/v1/index, /users/v1/find?q=...). Signatures cover the path
// without the prefix (/v1/...), exactly as in production.
//
//   node local-server.mjs [--port 8787] [--data ./.local-data] [--mirror]
//     --data    keep state in a directory (default: memory only)
//     --mirror  start a mock GitHub too: each item change makes a revision there once changes
//               settle (90 s; --settle <seconds> to change), POST /_local/mirror?force=1 runs it
//               now, GET /_local/mirror lists the mirrored files
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp, serviceForHost } from './src/app.mjs';
import { createMemoryStore } from './src/store/memory.mjs';
import { githubClient } from './src/github.mjs';
import { runRevisions } from './src/mirror.mjs';
import { startMockGitHub } from './mock-github.mjs';

export async function startLocalServer({ port = 8787, store, now = Date.now, config = {}, github = null, branch = 'main', settleMs = 90_000 } = {}) {
  store ??= createMemoryStore({ now });
  // The same flow as in AWS: a change asks for a run after the settle time (SQS there, a timer here).
  let timer = null;
  const run = (force = false) => runRevisions({ store, github, branch, now, force, debounceMs: settleMs, notify: (s) => schedule(s * 1000) });
  const schedule = (ms) => {
    if (!github) return;
    clearTimeout(timer);
    timer = setTimeout(() => run().catch((e) => console.error('revisions', e)), ms);
    timer.unref?.();
  };
  const app = createApp({ store, now, config: { ...config, onChange: () => schedule(settleMs) } });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname, service = serviceForHost(req.headers.host);
    const m = path.match(/^\/(shared|users)(\/.*)$/);
    if (!service && m) { service = m[1]; path = m[2]; }
    let out;
    if (path === '/_local/mirror' && github) {
      const r = req.method === 'POST'
        ? await run(url.searchParams.get('force') === '1').catch((e) => ({ status: 'error', error: e.message }))
        : { files: github.files ? [...github.files(branch).keys()] : [] };
      out = { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) };
    } else {
      out = await app.handle({
        method: req.method, host: req.headers.host, service, path, query: url.searchParams,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v])),
        body: Buffer.concat(chunks), ip: req.socket.remoteAddress,
      });
    }
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, server, store, app, close: () => { clearTimeout(timer); return new Promise((r) => server.close(r)); } };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
  const port = Number(arg('--port', 8787));
  const dir = arg('--data', null);
  let github = null, mock = null;
  if (process.argv.includes('--mirror')) {
    if (process.env.GITHUB_TOKEN && process.env.MIRROR_REPO) {
      github = githubClient({ token: process.env.GITHUB_TOKEN, repo: process.env.MIRROR_REPO });
    } else {
      mock = await startMockGitHub();
      const client = githubClient({ token: mock.token, repo: mock.repo, apiUrl: mock.url });
      github = Object.assign(client, { files: (b) => mock.files(b) });
    }
  }
  const s = await startLocalServer({ port, store: createMemoryStore({ dir }), github, branch: process.env.MIRROR_BRANCH || 'main', settleMs: Number(arg('--settle', 90)) * 1000 });
  console.log(`shared: ${s.url}/shared/v1/index   users: ${s.url}/users/v1/find?q=...` +
    (dir ? `   data: ${dir}` : '   (memory only)') + (mock ? `   mock GitHub: ${mock.url}` : github ? `   mirror: ${process.env.MIRROR_REPO}` : ''));
}
