// Test harness for the web client (web/*.js): every test gets a fresh headless Chromium page
// serving web/ at http://localhost:47231/ (intercepted, never really served), with
//   - a fake native backend (/api/<name>, as the Mac app serves it) when `native` is on,
//   - fake AI providers (Anthropic, OpenAI-compatible) for the browser backend (web/backend.js),
//   - fake timers (page.clock) so long waits are skipped, not slept,
//   - V8 JS coverage of web/*.js written to .out/v8/ for report.mjs.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB = path.resolve(HERE, '../../../web');
export const ORIGIN = 'http://localhost:47231'; // a secure context (crypto.subtle, clipboard); never really served
const OUT = path.join(HERE, '.out', 'v8');
export const FILES = ['app.js', 'backend.js', 'shared.js', 'qa.js', 'native.js'];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// The prompts file the Mac build exports (tools/export-prompts); a stand-in with every key.
export const PROMPTS = {
  system: 'SYSTEM', screenSchema: '{"type":"object"}', pageSchema: '{"type":"object"}', suggestSchema: '{"type":"object"}',
  consoleSchema: '{"type":"object"}', testsSchema: '{"type":"object"}', menusSchema: '{"type":"object"}', patchSchema: '{"type":"object"}',
  translateSchema: '{"type":"object"}', profileSchema: '{"type":"object"}', librarySchema: '{"type":"object"}', retroSchema: '{"type":"object"}',
  pager: ' PAGER', suggest: ' SUGGEST', console: ' CONSOLE', tester: ' TESTER', menus: ' MENUS', quick: ' QUICK', scout: ' SCOUT',
  refine: ' REFINE', translate: 'TRANSLATE', profiler: ' PROFILER', librarian: ' LIBRARIAN', retro: ' RETRO',
};

// A default native backend: enough for the app to start on the root with an AI connected.
export function defaultApi(name, body) {
  switch (name) {
    case 'engine': return { options: [{ id: 'claude', label: 'Claude Code', kind: 'cli' }], active: { id: 'claude', label: 'Claude Code' } };
    case 'info': return { language: 'en-US' };
    case 'profile': return body.op === 'tree' ? { branches: [], traits: [], total: 0 } : { baseline: {}, traits: [] };
    case 'cache': return body.op === 'likely' ? { label: null } : { results: [] };
    case 'system': return { cache: { entries: 1 }, libraries: { installed: 2, catalog: 9 }, hints: { hints: [] } };
    case 'usage': return body.op === 'applets' ? { applets: [] } : body.op === 'list' ? { scenes: [] } : {};
    case 'shared': return body.op === 'status' ? {} : { items: [] };
    case 'window': return { ok: true };
    default: return { ok: true };
  }
}

export class App {
  constructor(page) {
    this.page = page;
    this.calls = [];          // [{ name, body }] to the native backend (/api/*)
    this.provider = [];       // [{ url, body, headers }] to AI providers
    this.api = null;          // (name, body) => result | Promise; throw an Error for an error reply
    this.ai = null;           // (url, body, headers) => provider JSON response (or { status, json })
    this.files = {};          // extra static files: path → string
  }

  // Loads the app. native: served like the Mac app (fake /api/*); otherwise the web version.
  async open({ native = false, ios = false, storage = {}, api, ai, init, lang, clock = true, url = '/' } = {}) {
    if (api) this.api = api;
    if (ai) this.ai = ai;
    const page = this.page;
    if (clock) await page.clock.install();
    await page.addInitScript(({ native, ios, storage, lang }) => {
      if (window !== window.top) return; // the app's own frames (scenes) get nothing of this
      if (native) window.__AIUI_TEST_NATIVE__ = true;
      if (ios) window.webkit = { messageHandlers: { aiui: { postMessage: (m) => window.__iosBridge(m) } } };
      if (lang) Object.defineProperty(navigator, 'language', { get: () => lang });
      if (sessionStorage.getItem('__seeded') !== '1') {
        sessionStorage.setItem('__seeded', '1');
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }, { native, ios, storage, lang });
    if (init) await page.addInitScript(init);
    if (ios) {
      await page.exposeFunction('__iosBridge', async (m) => {
        this.calls.push({ name: m.name, body: m.body });
        try { return { status: 200, data: await this.answer(m.name, m.body) }; }
        catch (e) { return e.status ? { status: e.status, data: {} } : { status: 500, data: { error: e.message } }; }
      });
    }
    await page.route('**/*', (route) => this.route(route));
    await page.goto(ORIGIN + url);
    return this;
  }

  async answer(name, body) {
    const r = this.api ? await this.api(name, body, defaultApi) : undefined;
    return r === undefined ? defaultApi(name, body) : r;
  }

  async route(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === ORIGIN) {
      if (url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice(5);
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch {}
        this.calls.push({ name, body });
        try {
          const r = await this.answer(name, body);
          if (r && r.__raw) return route.fulfill({ status: r.status || 200, body: r.__raw });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r) });
        } catch (e) {
          return route.fulfill({ status: e.status || 500, contentType: 'application/json', body: JSON.stringify(e.status ? {} : { error: e.message }) });
        }
      }
      const p = url.pathname === '/' ? '/index.html' : url.pathname;
      if (p in this.files) {
        const f = this.files[p];
        if (f && f.status) return route.fulfill({ status: f.status, body: f.body || '' });
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(p)] || 'text/plain', body: f });
      }
      if (p === '/prompts.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROMPTS) });
      const file = path.join(WEB, p);
      if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(p)] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    }
    if (req.method() === 'POST' && this.ai) {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch {}
      const entry = { url: req.url(), body, headers: req.headers() };
      this.provider.push(entry);
      const r = await this.ai(entry.url, body, entry.headers);
      if (r && r.abort) return route.abort(r.abort);
      if (r && r.status) return route.fulfill({ status: r.status, contentType: 'application/json', body: r.raw ?? JSON.stringify(r.json || {}) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r) });
    }
    return route.abort('connectionrefused');
  }

  // Calls to the native backend named `name` (optionally with body.op === op).
  sent(name, op) { return this.calls.filter((c) => c.name === name && (op === undefined || c.body.op === op)); }

  ev(fn, arg) { return this.page.evaluate(fn, arg); }
  async tick(ms) { await this.page.clock.runFor(ms); }
  // Lets pending promises and fetches settle (real time; fake timers do not move).
  async settle(ms = 50) { await this.page.waitForTimeout(ms); }
}

export const test = base.extend({
  app: async ({ page }, use, testInfo) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
    const app = new App(page);
    app.errors = errors;
    await use(app);
    const cov = await page.coverage.stopJSCoverage();
    const keep = cov.filter((e) => FILES.some((f) => e.url === `${ORIGIN}/${f}`));
    fs.mkdirSync(OUT, { recursive: true });
    const id = crypto.createHash('sha1').update(testInfo.titlePath.join('/') + testInfo.retry).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify(keep.map((e) => ({ url: e.url, functions: e.functions }))));
  },
});

export { expect };
