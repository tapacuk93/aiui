# AI UI services: shared.aiui.oeaio.com and users.aiui.oeaio.com

The backend for [docs/shared-and-users.md](../docs/shared-and-users.md) (the contract, including the
"Implementation decisions" at its end). Node.js 20 or later, no framework; the only dependencies
are the AWS SDK v3 clients, which the Lambda runtime already provides (they are devDependencies here,
for checking). Ed25519 is `node:crypto`.

```
src/app.mjs           one handler for both hosts: routing by host, CORS, rate limits, errors
src/auth.mjs          signature verification (message format, 5-minute window, replay)
src/shared.mjs        shared.aiui.oeaio.com: items, index, search, versions, adoptions, reports
src/users.mjs         users.aiui.oeaio.com: profiles, find, contacts, router inbox
src/mirror.mjs        the GitHub revisions: one commit + tags per changed item, revision files
src/analysis.mjs      taxonomy mapping, coverage, similarity, value, maturity, version, notes
src/taxonomy.json     the target: categories of software a complete personal OS needs
src/review.mjs        optional AI notes for each revision (Anthropic API or AICoin)
src/github.mjs        GitHub Git Data API client (fetch)
src/store/memory.mjs  in-memory store, optionally persisted to a directory
src/store/aws.mjs     DynamoDB + S3 store (same interface)
src/lambda.mjs        Lambda entry points: api (HTTP API 2.0 events), mirror (schedule)
local-server.mjs      both hosts on localhost with the same handlers
mock-github.mjs       an in-memory GitHub for the mirror (tests and the local server)
test/                 node --test
```

## Run locally

```sh
cd services
node local-server.mjs                       # memory only, http://127.0.0.1:8787
node local-server.mjs --data .local-data    # keep state in a directory
node local-server.mjs --mirror              # plus a mock GitHub: a revision per change once it settles
node local-server.mjs --mirror --settle 5   #   (90 s by default); POST /_local/mirror?force=1 runs it now
```

The service is chosen by the Host header (`shared.localhost:8787`, `users.localhost:8787`) or by a
path prefix: `http://127.0.0.1:8787/shared/v1/index`, `http://127.0.0.1:8787/users/v1/find?q=ann`.
Signatures always cover the path without the prefix (`/v1/...`), as in production. With
`GITHUB_TOKEN` and `MIRROR_REPO` set, `--mirror` talks to the real GitHub instead of the mock.

A signed request from Node (any Ed25519 implementation works the same way):

```js
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const id = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
const body = JSON.stringify({ name: 'Me', findable: true }), time = String(Date.now());
const msg = `aiui/v1\nPUT\n/v1/profile\n${time}\n${createHash('sha256').update(body).digest('hex')}`;
const sig = sign(null, Buffer.from(msg), privateKey).toString('base64url');
await fetch('http://127.0.0.1:8787/users/v1/profile', { method: 'PUT', body,
  headers: { 'X-AIUI-Id': id, 'X-AIUI-Time': time, 'X-AIUI-Signature': sig } });
```

## Test

```sh
cd services && npm test        # node --test test/*.test.mjs
```

The tests sign with real Ed25519 keys and cover every endpoint, bad/expired/replayed signatures,
limits, versions, withdrawal, report-hiding, find and handle uniqueness, the mutual flow and inbox
events, index `since`/`removed`/paging, rate limits, the local server, and the mirror against the
mock GitHub: one revision (commit, tags `r<N>`/`v<version>`, revision files) per added item, bursts
settling first and coalescing per item, notes carried over and marked addressed, the value and
maturity math (duplicates ~0, a new category beats the same category, trivial changes are a PATCH,
withdrawal and reports move maturity back), coverage tracking, bootstrap, recovery after a failed
run, the run lock, the optional AI review (fake client), and the CloudFormation template
(`cfn-lint` when installed: on PATH or `CFN_LINT=...`).
The DynamoDB/S3 store is checked for the commands it builds (fake clients); it has not run against
real AWS before the first deploy.

## Deploy

Nothing here is deployed automatically. Region us-east-1 (as the web stack). Stack `aiui-services`
from `deploy/services.yaml`: an HTTP API with the custom domains `shared.aiui.oeaio.com` and
`users.aiui.oeaio.com` (A aliases in the `oeaio.com` zone), two arm64 Lambdas (`aiui-services-api`,
`aiui-services-mirror`), seven on-demand DynamoDB tables (TTL on events and on replay/rate marks;
point-in-time recovery and `Retain` on the durable ones), a private, TLS-only S3 bucket for payloads
(`aiui-shared-payloads-<account>`), the change log table, an SQS queue that starts the mirror 90 s after a write
and an EventBridge rule every 15 minutes as its safety net (both off until `MirrorEnabled=true`),
one IAM role per function with only what it uses (the mirror can read the
live index, its own meta values, payloads and the `aiui/github-mirror` secret).

1. Certificate (once): `deploy/deploy-services.sh --cert` - requests one ACM certificate for both
   names and writes the DNS validation records; run again until it prints `ISSUED`.
2. Stack: `deploy/deploy-services.sh` - runs the tests, uploads the code to
   `aiui-services-artifacts-<account>` (created if missing), deploys, and checks both hosts.
3. Mirror (when wanted): create the GitHub repository (default `tapacuk93/aiui-shared`, may be
   empty) and a fine-grained token limited to it with *Contents: read and write*, then
   ```sh
   aws secretsmanager create-secret --region us-east-1 --name aiui/github-mirror --secret-string '<token>'
   MIRROR_ENABLED=true deploy/deploy-services.sh
   deploy/deploy-services.sh --mirror-now          # optional: first run right away
   ```
   `MIRROR_REPO` / `MIRROR_BRANCH` change the target. The first run turns the items already live into
   revisions r1..rN; from then on each change is a revision.
4. AI review of revisions (optional, off by default):
   ```sh
   aws secretsmanager create-secret --region us-east-1 --name aiui/revision-review \
     --secret-string '{"provider":"anthropic","apiKey":"<key>"}'   # or {"provider":"aicoin","token":"<token>"}
   REVIEW_ENABLED=true deploy/deploy-services.sh                    # bundles @anthropic-ai/sdk
   ```
   Model `claude-opus-5-5` (override with `"model"` in the secret); about one short request per
   revision.

## Cost notes

At small scale this is close to free; everything is pay-per-use except the secret.

- API Gateway HTTP API: $1.00 per million requests. Lambda: arm64, 512 MB, typically tens of ms
  per request; within the free tier for a long time.
- DynamoDB on demand: about $1.25 per million writes and $0.25 per million reads. Every GET also
  writes one rate counter, every signed request one replay mark and one counter, so a write costs
  about 4-6 write units. Storage is tiny (metadata only).
- S3: payloads up to 512 KB, content-addressed (old versions stay; nothing is listed); cents.
- The mirror Lambda runs once per burst of changes (SQS: a message per write, $0.40 per million)
  plus 96 safety-net wakes a day that read the change log; it reads the GitHub secret only when
  there is a revision to commit ($0.40/month per secret). The revision state is one S3 object.
- The value computation compresses each new item against up to 5 sources (brotli): milliseconds to
  a second per revision; similarity is compared with every live item (64-number signatures).
- CloudWatch Logs kept 30 days.
- Search and find scan the live index / findable profiles (cached 60 s per warm Lambda). That is
  right for thousands of items or users; beyond that, an index service (or OpenSearch) would be
  the next step.
