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

### Mirror to GitHub: one revision per change

The registry mirrors the live shared items to a GitHub repository (default `tapacuk93/aiui-shared`,
branch `main`) as **one evolving collection** whose direction is *a personal OS with all its
software*. Every change to the collection - an item added, a new version, a withdrawal, an item
hidden by reports - becomes **one revision**: one commit, tagged `r<N>` and `v<version>`. A write
asks for a run 90 seconds later; while a burst goes on the run waits until the newest change is 90 s
old (at most 10 minutes after the oldest), then makes one revision per changed item in the order of
their first change (several changes of one item in a burst are one revision with its last state).
Adoptions alone do not make revisions; they count in the next one.

```
README.md                          generated: what this is, version, maturity, coverage, the formula
TAXONOMY.json                      the target: categories of software a complete personal OS needs
COLLECTION.json                    version, maturity, coverage per category, each item's category and value
REVISIONS.md                       every revision, newest first
revisions/r<N>.md                  one revision: the change, its value, maturity, coverage, notes
index.json                         the same as GET /v1/index (all live items, no payloads)
<kind>/<path...>/<name>/meta.json  the item's metadata (as in the API)
<kind>/<path...>/<name>/payload.json  the exact payload bytes (sha256 matches meta.sha256)
<kind>/<path...>/<name>/code.js   components/utils: the code alone, for reading and diffs
```

Withdrawn and hidden (reported) items are removed from the tree (their revision files stay).
Authors appear by app id (and display name if they set one). Commits are made through the GitHub
API by a bot token kept in AWS Secrets Manager (`aiui/github-mirror`), with the message
`r<N> v<version>: <added|updated|withdrawn|hidden> <kind>/<path>/<name> (value <v>, maturity <m>)`.
The mirror is read-only output: nothing is read back from GitHub except the branch's tree listing.

### Revisions: taxonomy, value, maturity, notes

**Taxonomy.** `TAXONOMY.json` (in `services/src/`) lists 25 categories a complete personal OS needs -
system and settings, files, text, documents, spreadsheets and data, charts, presentations, media
players, media editors, drawing/design/music, web and reading, mail and messaging, calendar and
clock, notes and tasks, developer tools, network, security, money, learning, games, maps and
weather, health, AI, interface building blocks, calculators and converters - each with a weight
(3 essential, 2 expected, 1 nice to have), keywords and examples. Each item is mapped to one
category from its path, name, title, description and usage (path segment = category id or alias: 6;
keyword in path/name: 3, in the title: 2, in description/usage: 1; at least 2, else
*uncategorized*). **Coverage** = the weight of categories with at least one live item over all weights.

**Value of a revision** (deterministic; constants in `services/src/analysis.mjs`):

- *source* = 10 x log2(1 + novel / 512) x documentation, where *novel* = brotli(references + source)
  - brotli(references) in bytes (quality 9, 24-bit window), over whitespace-normalized source
  (components/utils: code + css; applets: the html), and the references are the item's previous
  version and its (up to 4) most similar live items (MinHash similarity >= 0.1). *documentation* =
  0.5, +0.25 for a description of 40+ characters, +0.25 for usage of 20+ characters, +0.1 when the
  code carries self-tests (`test(`, `assert(`, `expect(`, `describe(`), at most 1.1.
- *coverage*: the first item in a category earns 15 x weight; the second and third 3 x weight.
- *builds on*: 2 per live item listed in `uses`, at most 5 counted.
- *duplicate*: 90%+ alike (MinHash over 5-token shingles, 64 hashes; or identical after
  normalization) to another live item -> the whole value is 0.
- *usage*: +0.5 per adoption, -2 per report since the previous revision (in the next revision).
- *withdrawn*: minus everything the item added; *hidden* (3 reports): that and 5 more.

**Maturity.** Points P = the sum of revision values, never below 0; the **maturity index** =
100 x P / (P + 1000) (50 at 1000 points, approaching 100). The **version** MAJOR.MINOR.PATCH: MAJOR =
the number of weighted-coverage quarters reached (25/50/75/100%; it never goes back); otherwise a
revision worth 20 or more bumps MINOR, any other (also negative) PATCH. So a reformatted copy or a
typo fix moves maturity by ~0 and is a PATCH, while a substantial item in a new category moves it a
lot and is a MINOR (or MAJOR when it crosses a coverage quarter).

**Notes for the next revision.** Each revision ends with notes computed from the collection after
it: the most valuable next contribution (the heaviest uncovered category, else the thinnest), gaps
in the taxonomy, near-duplicates to merge (60%+ alike, neither `uses` the other), items that should
build on each other (30-60% alike), items missing description/usage or self-tests, and items the
taxonomy cannot place. Each note has a stable id; the next revision lists the previous notes as
*addressed* (no longer open) or *still open (since r<N>)*. Optionally (off by default,
`ReviewEnabled`), Claude reads the revision, the deterministic notes, its own previous notes and the
item's source (as untrusted data) and adds "Reviewer notes (AI)"; the key is in Secrets Manager
(`aiui/revision-review`: an Anthropic API key or an AICoin token for `proxy.aicoin.oeaio.com`).
Without it, or when it fails or declines, the notes are the deterministic ones.

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

## Implementation decisions (`services/`)

Points the contract above left open, as the backend implements them:

- **Payload bytes.** The server stores `JSON.stringify` of the `payload` object as received (key
  order kept, no whitespace); `sha256` and `size` are over those bytes and come back in the item.
  Component/util payloads may hold only `code` (required) and `css`; an applet payload is any
  object with a string `kind`.
- **Names.** `name` is 1-80 of `A-Z a-z 0-9 _ $ -` and each `path` segment 1-40 of
  `A-Z a-z 0-9 _ -`, at most 8 segments (they are directories in the mirror: no dots or slashes).
  `title` defaults to `name`; `libs` at most 32, `uses` at most 64 item ids. An over-long title,
  description, usage, report reason or payload is `413`; other bad input (names included) `400`.
- **Versions.** Creating answers `201`, a new version `200`. Posting exactly what is already there
  (same payload and metadata) returns the item unchanged, without a new version. After a withdrawal
  the same kind + path + name starts a new item (new id, version 1). A hidden (reported) item's new
  versions stay hidden.
- **`authorName`** is the author's display name from their users profile at share time, if any.
- **Hidden and withdrawn items** answer `404` on `GET /v1/items/<id>` and `/payload`, and cannot be
  adopted or reported.
- **Index paging.** `limit` (1-500, default 500); `next` is a relative URL
  (`/v1/index?...&after=<cursor>`) or `null`. `removed` is present only with `since`, on the first
  page, and lists withdrawn **and** hidden items (both left the index).
- **Reports** need `{reason}` (1-1000 characters); the answer is `{id, reports, hidden}`. Adoption
  answers the item.
- **Profiles.** A non-findable profile is also returned to a *signed* `GET /v1/profiles/<id>` from a
  mutual contact (or from its owner). `GET /v1/find?q=<64-hex id>` answers `{profiles: [p]}` or 404.
  `findable` defaults to false.
- **Contacts.** At most 1000 per app id; `note` up to 280 characters. Entries:
  `{id, state: "pending", added, note?, name?}`, `{id, state: "incoming", added, note?, name?}`,
  `{id, state: "mutual", since, note?, name}` - the name only from a findable profile, or for a
  mutual contact. Removing a contact (or deleting the profile) sends the other side `removed`, also
  when it was only pending. `incoming` events always carry `note` (possibly "").
- **Router inbox.** At most 100 events per call, with `"more": true` when there are more.
- **Rate limits.** Writes = signed non-GET requests, 60/hour per app id across both hosts; reads =
  all GETs, 600/hour per IP. The API also throttles at 50 requests/s (burst 100).
- **Replay.** Ed25519 signatures are deterministic: an identical request signed in the same
  millisecond is a replay (`409`). Unknown method on a known path is `405`.
- **Mirror.** Writes record a change log (DynamoDB); a write sends a delayed SQS message (90 s)
  that starts the mirror Lambda; a 15-minute schedule is the safety net. One run at a time (a
  lock); a run that stops half-way is completed by the next without duplicates. The first run makes
  revisions of the items already live, in creation order. `index.json` in the mirror has `next:
  null` and `generated` = the latest item update. When two authors share kind + path + name, the
  earliest-created item keeps the plain directory and later ones get `<name>.<first 12 hex of the
  author id>`. The secret holds the token itself or `{"token": "..."}`; an empty repository gets a
  first commit through the contents API. Nothing runs until the stack is deployed with
  `MirrorEnabled=true`.
- **Hosting.** Region us-east-1 (as the web stack; the regional certificate for both names lives
  there). Lambda runtime `nodejs24.x` by default: the code needs Node.js 20 or later, and Lambda
  deprecated `nodejs20.x` on 2026-04-30. DNS has A aliases only (the regional API domains are IPv4).
