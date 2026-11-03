# Shared and Users services — contract

Two small services next to the app, both under `aiui.oeaio.com`:

- **`shared.aiui.oeaio.com`** — what users explicitly shared (components, utilities, applets).
  The app keeps two levels of shared code: **local** (its own library, as today) and **global**
  (this registry). The app syncs the global *index* now and then; it never runs global code
  directly.
- **`users.aiui.oeaio.com`** — an opt-in gateway where users find each other by their **app id**,
  and a router that, once two users have each added the other, passes each one the other's id
  (mutual identification).

Both are JSON over HTTPS. Everything is versioned under `/v1`.

## App identity (the "app env id")

Each installation of AI UI (each app environment: a Mac, a phone, a web browser profile, later
AI UI OS) has its own **Ed25519 keypair**, created on first use and kept in the Keychain (web:
IndexedDB, non-extractable where possible). Its **id** is the lowercase hex of the 32-byte raw
public key (64 hex chars) — the same shape as an AICoin wallet address, but a separate key.

Writes are signed. Each signed request carries:

| header | value |
|---|---|
| `X-AIUI-Id` | the app id (64 hex) |
| `X-AIUI-Time` | Unix time in ms; the server rejects anything more than 5 minutes off |
| `X-AIUI-Signature` | base64url (no padding) Ed25519 signature over the message below |

The signed message is the UTF-8 string

```
aiui/v1\n<METHOD>\n<path>\n<X-AIUI-Time>\n<sha256 hex of the raw request body ("" → sha256 of empty)>
```

`<path>` is the request path without host or query (`/v1/items`). The server verifies the
signature with the public key in `X-AIUI-Id`; nothing else authenticates a write. A replayed
request (same id, time and signature seen in the last 10 minutes) is rejected (`409`).

Errors: `{"error": "<message>"}` with 400 (bad input), 401 (bad/missing signature), 403 (not
yours), 404, 409 (replay / conflict), 413 (too large), 429 (rate limited).

## shared.aiui.oeaio.com

### Items

An item is one thing a user shared:

```json
{
  "id": "<server id, 26-char ULID>",
  "kind": "component" | "util" | "applet",
  "name": "gameKit",
  "path": ["games", "core"],
  "title": "Game kit",
  "description": "what it does",
  "usage": "how to use it (lib.<name>(...) signature for components/utils)",
  "version": 3,
  "author": "<app id>",
  "authorName": "<display name, optional>",
  "sha256": "<hex sha256 of the payload bytes>",
  "size": 12345,
  "libs": ["three"],
  "uses": ["<other shared item ids it builds on>"],
  "created": "<ISO-8601>",
  "updated": "<ISO-8601>",
  "adoptions": 12,
  "reports": 0
}
```

The **payload** is stored separately (S3), byte-exact, and addressed by its hash:
- component/util: `{"code": "...", "css": "..."}` (the same shape as the local library module)
- applet: the screen JSON (`kind: "html"`, `html`, `uses`, `libs`, `improve`, …) without
  user state.

Limits: payload ≤ 512 KB; name/title ≤ 80 chars; description/usage ≤ 4 KB.

### Endpoints

- `GET /v1/index?since=<ISO>` — public. The index: every live item's metadata (no payloads),
  newest first, with `"next"` for paging (≤ 500 per page) and `"generated"` (ISO). `since` gives
  only items updated after it, plus `"removed": [ids]` withdrawn since then. Cacheable (60 s).
- `GET /v1/items/<id>` — public: the item's metadata.
- `GET /v1/items/<id>/payload` — public: the payload bytes (`application/json`); the client
  checks them against `sha256` before use.
- `GET /v1/search?q=<text>&kind=<kind>` — public: matching items (name, title, description,
  path), ranked; ≤ 50.
- `POST /v1/items` — signed. Body `{kind, name, path, title, description, usage, libs, uses,
  payload}` (payload as a JSON object). Creates an item with `version: 1`, or — when the signer
  already shared an item with the same `kind` + `path` + `name` — a new version of it. Returns the
  item. Only explicit user action shares anything.
- `DELETE /v1/items/<id>` — signed, author only: withdraws it (it leaves the index; listed in
  `removed`).
- `POST /v1/items/<id>/adopted` — signed: counts an adoption (once per app id).
- `POST /v1/items/<id>/report` — signed `{reason}`: a user flags it (malicious, broken). Items
  with reports from 3 different app ids are hidden from the index pending review.

### Two levels in the app

- **Local** — the device's library (`Sources/App/Utilities.swift`), as today.
- **Global** — the synced index (refreshed on launch when older than 6 h, then every 6 h, and on
  demand), browsable and searchable in the app, shown to the AI as "shared by others" next to the
  local library.
- Global code is **never executed directly**. Using a global item = **adopting** it: the app
  downloads the payload, verifies `sha256`, has the AI review it (what it does, network/system
  access, anything suspicious), shows the review, and only on the user's confirmation copies it
  into the local library (marked with its origin id and version). From then on it is local code.
- Updates of adopted items: the index sync notices a newer `version`; the app offers it (same
  review + confirmation), never auto-applies.
- Sharing: on a local module or an applet, an explicit "Share globally" action shows exactly what
  will be published (and strips state), then signs and posts it.

### Mirror to GitHub

The registry periodically (every 6 hours, and after a burst of changes settles for 15 minutes)
pushes the whole tree of live shared items to a GitHub repository (default
`tapacuk93/aiui-shared`, branch `main`), as one commit per run, only when something changed:

```
README.md                         generated: what this is, counts, how to adopt in AI UI
index.json                        the same as GET /v1/index (all live items, no payloads)
<kind>/<path...>/<name>/meta.json  the item's metadata (as in the API)
<kind>/<path...>/<name>/payload.json  the exact payload bytes (sha256 matches meta.sha256)
<kind>/<path...>/<name>/code.js   components/utils: the code alone, for reading and diffs
```

Withdrawn and hidden (reported) items are removed from the tree. Authors appear by app id
(and display name if they set one). Commits are made through the GitHub API by a bot token kept in
AWS Secrets Manager (`aiui/github-mirror`), with the message `Shared: +N updated M removed K`.
The mirror is read-only output: nothing is ever read back from GitHub.

## users.aiui.oeaio.com

### Profiles (opt-in)

Nobody is listed unless they opt in. A profile:

```json
{ "id": "<app id>", "name": "display name", "handle": "optional-unique-handle",
  "about": "optional short text", "findable": true, "updated": "<ISO>" }
```

- `PUT /v1/profile` — signed: create/update the signer's profile (`name` 1–60 chars, `handle`
  3–30 `[a-z0-9_-]`, unique, optional; `about` ≤ 280; `findable` true/false).
- `DELETE /v1/profile` — signed: remove it (and all the signer's contact requests).
- `GET /v1/profiles/<id>` — public: a findable profile (404 otherwise).
- `GET /v1/find?q=<text>` — public: findable profiles matching handle (exact first) or name;
  ≤ 20. Also matches an exact 64-hex id even when not findable? **No** — an exact id returns the
  profile only if `findable`; otherwise 404 (adding by id still works, below).

### Contacts and the router

- `POST /v1/contacts` — signed `{ "id": "<other app id>", "note": "optional" }`: the signer adds
  another app id (found, or typed/scanned). Works whether or not the other is findable.
- `DELETE /v1/contacts/<id>` — signed: removes it.
- `GET /v1/contacts` — signed (GET with an empty body): the signer's contacts, each with
  `state`: `"pending"` (I added them), `"incoming"` (they added me, I didn't yet), or `"mutual"`.
- **Router — mutual identification:** when both sides have added each other, the router passes
  each the other's id: `GET /v1/contacts` returns `mutual` entries with `{id, name?, since}`,
  and `GET /v1/router/inbox` (signed) returns events `{type: "mutual", id, at}` /
  `{type: "incoming", id, note, at}` / `{type: "removed", id, at}` since the last call (kept 30
  days). Only mutual contacts see each other's profile even when not findable. Nothing else
  (messages, sharing between two users) is part of v1; the router is where it will go.
- `GET /v1/id/<id>/verify?nonce=<random>` is not needed: an app proves its id by signing; the
  other side checks the signature with the id.

Rate limits (per app id): 60 writes/hour, 600 reads/hour per IP for public reads.

## Hosting

AWS, as the rest of `aiui.oeaio.com` (`deploy/`): one CloudFormation stack `aiui-services` with an
HTTP API (API Gateway) with custom domains `shared.aiui.oeaio.com` and `users.aiui.oeaio.com`
(ACM certificate, Route 53 alias in the `oeaio.com` zone), Lambda (Node.js 20, no framework),
DynamoDB (on-demand) for items/profiles/contacts/events/replay, and a private S3 bucket for
payloads, plus an EventBridge schedule for the GitHub mirror. `services/` holds the code with a local server that runs the same handlers for tests.
Deploying is a separate, explicit step (`deploy/deploy-services.sh`).
