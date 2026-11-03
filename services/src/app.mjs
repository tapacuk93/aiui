// One request handler for both hosts. A request is
//   {method, host, path, query: URLSearchParams, headers: {lowercase: value}, body: Buffer, ip}
// and a response {status, headers, body: string|Buffer, binary?}.
// The service is picked by host: shared.* -> shared, users.* -> users. `path` is what was signed
// (`/v1/...`, no host, no query).
import { HttpError, json, iso } from './util.mjs';
import { authenticate } from './auth.mjs';
import { sharedRoutes } from './shared.mjs';
import { usersRoutes } from './users.mjs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-aiui-id, x-aiui-time, x-aiui-signature',
  'access-control-expose-headers': 'x-aiui-sha256',
  'access-control-max-age': '86400',
};

export function serviceForHost(host) {
  const h = String(host || '').toLowerCase();
  if (h.startsWith('shared.')) return 'shared';
  if (h.startsWith('users.')) return 'users';
  return null;
}

export function createApp({ store, now = Date.now, config = {} }) {
  const cfg = { writesPerHour: 60, readsPerHour: 600, cacheMs: 0, ...config };
  const ctx = { store, now, cfg, nowIso: () => iso(now()) };
  const hour = () => Math.floor(now() / 3600000);

  // Signed write: verify, then count against the signer's hourly write budget.
  ctx.signer = async (req) => {
    const id = await authenticate(req, ctx);
    if ((await store.hit(`w:${id}:${hour()}`, 7200)) > cfg.writesPerHour) throw new HttpError(429, 'too many writes, try again later');
    return id;
  };

  // Whole-set reads (search, find) are cached for cfg.cacheMs inside a warm Lambda.
  const cached = (load) => {
    let at = -Infinity, value = null;
    return async () => {
      if (cfg.cacheMs > 0 && now() - at < cfg.cacheMs) return value;
      value = await load(); at = now(); return value;
    };
  };
  ctx.liveItems = cached(() => store.allLive());
  ctx.findableProfiles = cached(() => store.findableProfiles());

  const routes = { shared: sharedRoutes(ctx), users: usersRoutes(ctx) };

  async function handle(req) {
    const service = req.service || serviceForHost(req.host);
    try {
      if (req.method === 'OPTIONS') return { status: 204, headers: {}, body: '' };
      if (!service) throw new HttpError(404, 'unknown host');
      let pathMatched = false;
      for (const [method, re, fn] of routes[service]) {
        const m = re.exec(req.path);
        if (!m) continue;
        pathMatched = true;
        if (method !== req.method) continue;
        if (req.method === 'GET' && (await store.hit(`r:${req.ip || '-'}:${hour()}`, 7200)) > cfg.readsPerHour) {
          throw new HttpError(429, 'too many requests, try again later');
        }
        let args;
        try { args = m.slice(1).map(decodeURIComponent); } catch { throw new HttpError(400, 'bad path'); }
        return await fn(req, args);
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method not allowed' : 'not found');
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: 'internal error' });
    }
  }

  return {
    ctx,
    async handle(req) {
      const res = await handle(req);
      res.headers = { ...CORS, ...res.headers };
      if (!res.headers['cache-control']) res.headers['cache-control'] = 'no-store';
      return res;
    },
  };
}
