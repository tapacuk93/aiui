// A small in-memory GitHub (the Git Data API endpoints the mirror uses, plus PUT contents for an
// empty repository), served over HTTP so the mirror's real client is exercised.
//   const gh = await startMockGitHub({ token: 't', repo: 'me/shared' });  gh.url, gh.files('main'), gh.close()
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gitBlobSha } from './src/util.mjs';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export async function startMockGitHub({ token = 'test-token', repo = 'tapacuk93/aiui-shared', port = 0 } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = new Map(), tags = new Map();
  const calls = [];

  function putTree(entries) {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const e of sorted) if (!blobs.has(e.sha)) throw Object.assign(new Error(`unknown blob ${e.sha} for ${e.path}`), { status: 422 });
    const sha = sha1('tree ' + JSON.stringify(sorted));
    trees.set(sha, sorted);
    return sha;
  }
  function putCommit(message, tree, parents) {
    if (!trees.has(tree)) throw Object.assign(new Error('unknown tree'), { status: 422 });
    const sha = sha1(`commit ${tree} ${parents.join(',')} ${message} ${commits.size}`);
    commits.set(sha, { sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })), message });
    return sha;
  }

  async function route(method, path, body) {
    const base = `/repos/${repo}`;
    if (!path.startsWith(base + '/')) return [404, { message: 'Not Found' }];
    const p = path.slice(base.length);
    let m;
    if (method === 'GET' && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) {
      if (!refs.size) return [409, { message: 'Git Repository is empty.' }];
      const sha = refs.get(decodeURIComponent(m[1]));
      return sha ? [200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }] : [404, { message: 'Not Found' }];
    }
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = commits.get(m[1]);
      return c ? [200, c] : [404, { message: 'Not Found' }];
    }
    if (method === 'GET' && (m = p.match(/^\/git\/trees\/([0-9a-f]{40})\?recursive=1$/))) {
      const t = trees.get(m[1]);
      return t ? [200, { sha: m[1], tree: t.map((e) => ({ ...e, type: 'blob' })), truncated: false }] : [404, { message: 'Not Found' }];
    }
    if (!refs.size && method !== 'PUT') return [409, { message: 'Git Repository is empty.' }];
    if (method === 'POST' && p === '/git/blobs') {
      const buf = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const sha = gitBlobSha(buf);
      blobs.set(sha, buf);
      return [201, { sha }];
    }
    if (method === 'POST' && p === '/git/trees') {
      const files = new Map();
      if (body.base_tree) {
        const base = trees.get(body.base_tree);
        if (!base) return [422, { message: 'unknown base_tree' }];
        for (const e of base) files.set(e.path, e);
      }
      for (const { path, mode, sha } of body.tree) {
        if (sha === null) {   // deleting a path (or a whole directory)
          for (const k of [...files.keys()]) if (k === path || k.startsWith(path + '/')) files.delete(k);
        } else files.set(path, { path, mode, sha });
      }
      return [201, { sha: putTree([...files.values()]) }];
    }
    if (method === 'POST' && p === '/git/commits') return [201, { sha: putCommit(body.message, body.tree, body.parents || []) }];
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(m[1]), old = refs.get(branch);
      if (!old) return [422, { message: 'Reference does not exist' }];
      const c = commits.get(body.sha);
      if (!c) return [422, { message: 'Object does not exist' }];
      if (!body.force && !c.parents.some((x) => x.sha === old)) return [422, { message: 'Update is not a fast forward' }];
      refs.set(branch, body.sha);
      return [200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } }];
    }
    if (method === 'POST' && p === '/git/refs' && body.ref.startsWith('refs/tags/')) {
      const name = body.ref.slice('refs/tags/'.length);
      if (tags.has(name)) return [422, { message: 'Reference already exists' }];
      if (!commits.has(body.sha)) return [422, { message: 'Object does not exist' }];
      tags.set(name, body.sha);
      return [201, { ref: body.ref, object: { sha: body.sha } }];
    }
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/tags\/(.+)$/))) {
      tags.set(decodeURIComponent(m[1]), body.sha);
      return [200, { ref: `refs/tags/${m[1]}`, object: { sha: body.sha } }];
    }
    if (method === 'POST' && p === '/git/refs') {
      const branch = body.ref.replace(/^refs\/heads\//, '');
      if (refs.has(branch)) return [422, { message: 'Reference already exists' }];
      refs.set(branch, body.sha);
      return [201, { ref: body.ref, object: { sha: body.sha } }];
    }
    if (method === 'PUT' && (m = p.match(/^\/contents\/(.+)$/))) {
      if (refs.size) return [422, { message: 'the mock only creates the first commit' }];
      const buf = Buffer.from(body.content, 'base64'), sha = gitBlobSha(buf);
      blobs.set(sha, buf);
      const commit = putCommit(body.message, putTree([{ path: decodeURIComponent(m[1]), mode: '100644', sha }]), []);
      refs.set(body.branch || 'main', commit);
      return [201, { commit: { sha: commit } }];
    }
    return [404, { message: 'Not Found' }];
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: req.method, path: req.url });
    let status, data;
    if (req.headers.authorization !== `Bearer ${token}`) [status, data] = [401, { message: 'Bad credentials' }];
    else {
      try { [status, data] = await route(req.method, req.url, raw ? JSON.parse(raw) : null); } catch (e) { [status, data] = [e.status || 500, { message: e.message }]; }
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, token, repo, calls, refs, commits, tags,
    // The files at a commit: Map path -> Buffer.
    filesAt(commit) { return new Map(trees.get(commits.get(commit).tree.sha).map((e) => [e.path, blobs.get(e.sha)])); },
    // The files on a branch: Map path -> Buffer.
    files(branch = 'main') {
      const head = refs.get(branch);
      if (!head) return new Map();
      return new Map(trees.get(commits.get(head).tree.sha).map((e) => [e.path, blobs.get(e.sha)]));
    },
    // Commit messages on a branch, newest first.
    log(branch = 'main') {
      const out = [];
      for (let c = commits.get(refs.get(branch)); c; c = commits.get(c.parents[0]?.sha)) out.push(c.message);
      return out;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
