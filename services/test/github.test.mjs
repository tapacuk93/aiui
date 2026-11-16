// The GitHub client against a scripted fetch: requests, answers and errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubClient, GitHubError } from '../src/github.mjs';

// fetch that answers from `reply(method, path, body)` -> [status, text]; records every request.
function fakeFetch(reply) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://gh.test/repos/me/shared', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method, headers: init.headers, path, body });
    const [status, text] = reply(init.method, path, body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetchImpl, requests };
}
const client = (reply, token = 'tok') => {
  const f = fakeFetch(reply);
  return { gh: githubClient({ token, repo: 'me/shared', apiUrl: 'https://gh.test/', fetchImpl: f.fetchImpl }), requests: f.requests };
};

test('the repository must be owner/name', () => {
  for (const repo of [undefined, '', 'shared', 'me/shared/x', 'me/sh ared']) assert.throws(() => githubClient({ repo }), /bad repo/);
  assert.equal(githubClient({ repo: 'me/shared.js' }).repo, 'me/shared.js');
});

test('requests: headers, token only when given, JSON bodies', async () => {
  let { gh, requests } = client(() => [201, '{"sha":"b1"}']);
  assert.equal(await gh.createBlob(Buffer.from('hi')), 'b1');
  const r = requests[0];
  assert.equal(r.url, 'https://gh.test/repos/me/shared/git/blobs');
  assert.deepEqual(r.body, { content: Buffer.from('hi').toString('base64'), encoding: 'base64' });
  assert.equal(r.headers.authorization, 'Bearer tok');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['x-github-api-version'], '2022-11-28');

  ({ gh, requests } = client(() => [200, '{"tree":{"sha":"t1"}}'], null));
  assert.equal(await gh.getCommitTree('c1'), 't1');
  assert.equal(requests[0].headers.authorization, undefined, 'no token: anonymous');
  assert.equal(requests[0].headers['content-type'], undefined, 'no body: no content type');
});

test('trees, commits and refs', async () => {
  const { gh, requests } = client((method, path) => (method === 'GET' ? [200, '{"tree":[],"truncated":false}'] : path === '/git/refs' ? [201, ''] : [201, '{"sha":"s"}']));
  assert.deepEqual(await gh.getTree('t0'), { tree: [], truncated: false });
  assert.equal(await gh.createTree([{ path: 'a' }]), 's');
  assert.equal(await gh.createTree([{ path: 'b' }], 'base'), 's');
  assert.equal(await gh.createCommit('msg', 'tree', ['p']), 's');
  assert.equal(await gh.createRef('feature/x', 'c'), null, 'an empty answer is null');
  await gh.updateRef('feature/x y', 'c2');
  await gh.initialize('main', 'README.md', Buffer.from('# x'), 'init');
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
    'GET /git/trees/t0?recursive=1', 'POST /git/trees', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs',
    'PATCH /git/refs/heads/feature/x%20y', 'PUT /contents/README.md',
  ]);
  assert.deepEqual(requests[1].body, { tree: [{ path: 'a' }] });
  assert.deepEqual(requests[2].body, { base_tree: 'base', tree: [{ path: 'b' }] });
  assert.deepEqual(requests[3].body, { message: 'msg', tree: 'tree', parents: ['p'] });
  assert.deepEqual(requests[4].body, { ref: 'refs/heads/feature/x', sha: 'c' });
  assert.deepEqual(requests[5].body, { sha: 'c2', force: false });
  assert.deepEqual(requests[6].body, { message: 'init', content: Buffer.from('# x').toString('base64'), branch: 'main' });
});

test('the branch head: a sha, null for a missing branch, "empty" for an empty repository; other errors throw', async () => {
  const answers = { 'a/b': [200, '{"object":{"sha":"h1"}}'], missing: [404, '{"message":"Not Found"}'], empty: [409, '{"message":"Git Repository is empty."}'], down: [502, '<html>Bad gateway</html>'], blank: [500, ''] };
  const { gh, requests } = client((method, path) => answers[decodeURIComponent(path.replace('/git/ref/heads/', ''))]);
  assert.equal(await gh.getHead('a/b'), 'h1');
  assert.equal(requests[0].path, '/git/ref/heads/a/b');
  assert.equal(await gh.getHead('missing'), null);
  assert.equal(await gh.getHead('empty'), 'empty');
  await assert.rejects(gh.getHead('down'), (e) => e instanceof GitHubError && e.status === 502 && e.message === 'GitHub GET /git/ref/heads/down: 502 <html>Bad gateway</html>');
  await assert.rejects(gh.getHead('blank'), (e) => e.status === 500 && e.message === 'GitHub GET /git/ref/heads/blank: 500 ');
});

test('tags: created, or moved when they exist; other errors throw', async () => {
  const tags = new Set(['r1']);
  const { gh, requests } = client((method, path, body) => {
    if (method === 'POST' && body.ref === 'refs/tags/bad') return [403, '{"message":"Resource not accessible"}'];
    if (method === 'POST') return tags.has(body.ref.slice(10)) ? [422, '{"message":"Reference already exists"}'] : [201, '{"ref":"x"}'];
    return [200, '{"ref":"moved"}'];
  });
  assert.deepEqual(await gh.setTag('r2', 'c'), { ref: 'x' });
  assert.deepEqual(await gh.setTag('r1', 'c'), { ref: 'moved' });
  assert.deepEqual(requests.at(-1), { url: 'https://gh.test/repos/me/shared/git/refs/tags/r1', method: 'PATCH', headers: requests.at(-1).headers, path: '/git/refs/tags/r1', body: { sha: 'c', force: true } });
  await assert.rejects(gh.setTag('bad', 'c'), (e) => e.status === 403);
  assert.equal(requests.length, 4, 'no move after a refusal');
});
