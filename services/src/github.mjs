// Minimal GitHub REST client for the mirror: the Git Data API (refs, commits, trees, blobs), plus
// the contents API once, to give an empty repository its first commit.
export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function githubClient({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error(`bad repo "${repo}"`);
  const base = `${apiUrl.replace(/\/$/, '')}/repos/${repo}`;
  async function call(method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: {
        accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'aiui-shared-mirror',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${data?.message || ''}`);
    return data;
  }
  const ref = (branch) => `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  return {
    repo,
    // The branch head commit sha; null when the branch does not exist; 'empty' when the
    // repository has no commits at all (GitHub answers 409 then).
    async getHead(branch) {
      try { return (await call('GET', `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`)).object.sha; } catch (e) {
        if (e.status === 404) return null;
        if (e.status === 409) return 'empty';
        throw e;
      }
    },
    async getCommitTree(sha) { return (await call('GET', `/git/commits/${sha}`)).tree.sha; },
    async getTree(sha) { return call('GET', `/git/trees/${sha}?recursive=1`); },
    async createBlob(buf) { return (await call('POST', '/git/blobs', { content: Buffer.from(buf).toString('base64'), encoding: 'base64' })).sha; },
    async createTree(entries) { return (await call('POST', '/git/trees', { tree: entries })).sha; },
    async createCommit(message, tree, parents) { return (await call('POST', '/git/commits', { message, tree, parents })).sha; },
    async updateRef(branch, sha) { return call('PATCH', ref(branch), { sha, force: false }); },
    async createRef(branch, sha) { return call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha }); },
    // First commit of an empty repository (the Git Data API refuses to work on one).
    async initialize(branch, path, buf, message) {
      return call('PUT', `/contents/${path}`, { message, content: Buffer.from(buf).toString('base64'), branch });
    },
  };
}
