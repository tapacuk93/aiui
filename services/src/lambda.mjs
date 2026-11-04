// Lambda entry points (deploy/services.yaml).
//   api    - API Gateway HTTP API (payload 2.0) for shared.aiui.oeaio.com and users.aiui.oeaio.com
//   mirror - the GitHub revisions: SQS messages (sent, delayed, after each item change), the
//            safety-net schedule (every 15 min), or {"force": true} by hand
import { createApp } from './app.mjs';
import { awsStoreFromEnv } from './store/aws.mjs';
import { githubClient } from './github.mjs';
import { runRevisions } from './mirror.mjs';
import { reviewerFromEnv } from './review.mjs';

// Asks for a revisions run in `seconds` (SQS delay, at most 15 minutes). No queue: nothing (the
// schedule picks the change up).
let sqs;
export async function requestRun(seconds = 90, env = process.env) {
  if (!env.REVISIONS_QUEUE_URL) return;
  if (!sqs) {
    const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
    const client = new SQSClient({});
    sqs = (input) => client.send(new SendMessageCommand(input));
  }
  await sqs({ QueueUrl: env.REVISIONS_QUEUE_URL, MessageBody: '{"run":"revisions"}', DelaySeconds: Math.max(0, Math.min(900, Math.round(seconds))) });
}

let app;
async function getApp() {
  app ??= createApp({
    store: await awsStoreFromEnv(),
    config: {
      cacheMs: 60_000, writesPerHour: Number(process.env.WRITES_PER_HOUR || 60), readsPerHour: Number(process.env.READS_PER_HOUR || 600),
      onChange: () => requestRun(90),
    },
  });
  return app;
}

export function requestFromEvent(event) {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  const body = event.body == null ? Buffer.alloc(0) : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  return {
    method: event.requestContext.http.method.toUpperCase(),
    host: event.requestContext.domainName || headers.host,
    path: event.rawPath,
    query: new URLSearchParams(event.rawQueryString || ''),
    headers, body,
    ip: event.requestContext.http.sourceIp,
  };
}

export function responseToResult(res) {
  const binary = Buffer.isBuffer(res.body);
  return {
    statusCode: res.status, headers: res.headers,
    body: binary ? res.body.toString('base64') : res.body, isBase64Encoded: binary,
  };
}

export async function api(event) {
  const a = await getApp();
  return responseToResult(await a.handle(requestFromEvent(event)));
}

let token;
async function githubToken() {
  if (token) return token;
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.MIRROR_SECRET || 'aiui/github-mirror' }));
  const s = (r.SecretString || '').trim();
  token = s.startsWith('{') ? JSON.parse(s).token : s;   // the token itself, or {"token": "..."}
  if (!token) throw new Error('the mirror secret holds no token');
  return token;
}

export async function mirror(event = {}) {
  const store = await awsStoreFromEnv();
  const repo = process.env.MIRROR_REPO || 'tapacuk93/aiui-shared';
  const github = async () => githubClient({ token: await githubToken(), repo, apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com' });
  const review = await reviewerFromEnv().catch((e) => { console.log(`AI review off: ${e.message}`); return null; });
  const result = await runRevisions({
    store, github, branch: process.env.MIRROR_BRANCH || 'main', force: !!event.force,
    notify: (s) => requestRun(s), review, log: console.log,
  });
  console.log(JSON.stringify({ status: result.status, revisions: result.revisions.map((r) => r.message) }));
  return { status: result.status, revisions: result.revisions };
}
