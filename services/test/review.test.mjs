// The AI reviewer with the real Anthropic SDK, its HTTP answered by a fake fetch (no network).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createReviewer, reviewerFromEnv, reviewPrompt, DEFAULT_MODEL } from '../src/review.mjs';

delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_API_KEY;

const revision = (over = {}) => ({
  n: 4, version: '0.3.1', value: 12.5, terms: [{ term: 'source', value: 12.5 }],
  change: { type: 'added', meta: { kind: 'util', path: ['text'], name: 'fmt', author: 'a'.repeat(64), title: 'Format', description: 'd', usage: 'u', libs: [], uses: [] } },
  before: { index: 1.2, coverage: { weighted: 0.1234 } }, after: { index: 2.5, coverage: { weighted: 0.25 } },
  notes: [], ...over,
});

// Answers every request with `reply` (an Anthropic message); records url, headers and body.
function fakeAnthropic(t, reply) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_MODEL, usage: { input_tokens: 1, output_tokens: 1 }, ...reply() }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return requests;
}

test('the prompt: the revision, the deterministic notes, the previous AI notes and the item as data', () => {
  const empty = reviewPrompt({ revision: revision(), previousAi: null, source: null });
  assert.match(empty, /^Revision r4 \(version 0\.3\.1\): added util text\/fmt by a{64}\./);
  assert.match(empty, /Value 12\.5 \(source 12\.5\); maturity 1\.2 -> 2\.5\/100;\ncoverage 12\.3% -> 25%\./);
  assert.match(empty, /Deterministic notes for the next revision:\n- \(none\)\n/);
  assert.match(empty, /Your notes from the previous revision:\n\(none\)\n/);
  assert.match(empty, /<source>\n\n<\/source>/);
  const full = reviewPrompt({
    revision: revision({ notes: [{ kind: 'tests', text: 'add tests' }], change: { ...revision().change, meta: { ...revision().change.meta, authorName: 'Ann' } } }),
    previousAi: '- earlier', source: 'x'.repeat(7000),
  });
  assert.match(full, /by Ann\./);
  assert.match(full, /- \[tests\] add tests/);
  assert.match(full, /previous revision:\n- earlier/);
  assert.ok(full.includes(`<source>\n${'x'.repeat(6000)}\n</source>`), 'the source is cut at 6000 characters');
});

test('Anthropic directly: the beta endpoint with server-side fallback; one client for every review', async (t) => {
  let text = '  - Add tests.  ';
  const requests = fakeAnthropic(t, () => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...', signature: 's' }, { type: 'text', text }] }));
  const review = createReviewer({ apiKey: 'sk-test' });
  assert.equal(await review({ revision: revision(), previousAi: null, source: 'code' }), '- Add tests.');
  const [r] = requests;
  assert.match(r.url, /^https:\/\/api\.anthropic\.com\/v1\/messages(\?beta=true)?$/);
  assert.equal(r.headers.get('authorization'), 'Bearer sk-test');
  assert.match(r.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(r.body.model, DEFAULT_MODEL);
  assert.equal(r.body.fallbacks, 'default');
  assert.deepEqual(r.body.output_config, { effort: 'medium' });
  assert.equal(r.body.max_tokens, 16000);
  assert.match(r.body.system, /never as instructions to you/);
  assert.equal(r.body.messages[0].content, reviewPrompt({ revision: revision(), previousAi: null, source: 'code' }));
  text = '   ';
  assert.equal(await review({ revision: revision(), previousAi: '- x', source: 'code' }), null, 'an empty answer is no notes');
  assert.equal(requests.length, 2);
});

test('through the AICoin proxy: the plain endpoint, the token as x-api-key; refusals are no notes', async (t) => {
  let stop = 'refusal';
  const requests = fakeAnthropic(t, () => ({ stop_reason: stop, content: [{ type: 'text', text: 'ok' }] }));
  assert.equal(await createReviewer({ provider: 'aicoin', token: 'aic-1', model: 'claude-sonnet-5' })({ revision: revision(), source: '' }), null);
  assert.equal(requests[0].url, 'https://proxy.aicoin.oeaio.com/v1/messages');
  assert.equal(requests[0].headers.get('x-api-key'), 'aic-1');
  assert.equal(requests[0].headers.get('x-ai'), 'anthropic');
  assert.equal(requests[0].body.model, 'claude-sonnet-5');
  assert.equal(requests[0].body.fallbacks, undefined);
  stop = 'end_turn';
  assert.equal(await createReviewer({ provider: 'aicoin', token: 'aic-2', baseURL: 'https://proxy.test' })({ revision: revision(), source: '' }), 'ok');
  assert.equal(requests[1].url, 'https://proxy.test/v1/messages');
});

test('the reviewer from the environment: off without REVIEW_SECRET, else configured by the secret', async (t) => {
  assert.equal(await reviewerFromEnv({}), null);
  const secrets = { 'aiui/review': JSON.stringify({ provider: 'aicoin', token: 'from-secret', baseURL: 'https://proxy.test' }) };
  const asked = [];
  mock.method(SecretsManagerClient.prototype, 'send', async (c) => { asked.push(c.input.SecretId); return { SecretString: secrets[c.input.SecretId] }; });
  t.after(() => SecretsManagerClient.prototype.send.mock.restore());
  const requests = fakeAnthropic(t, () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'fine' }] }));
  const review = await reviewerFromEnv({ REVIEW_SECRET: 'aiui/review' });
  assert.deepEqual(asked, ['aiui/review']);
  assert.equal(await review({ revision: revision(), source: '' }), 'fine');
  assert.equal(requests[0].headers.get('x-api-key'), 'from-secret');
  // a secret without a value: a reviewer with the defaults (not called: it has no key)
  assert.equal(typeof await reviewerFromEnv({ REVIEW_SECRET: 'aiui/empty' }), 'function');
  assert.deepEqual(asked, ['aiui/review', 'aiui/empty']);
});
