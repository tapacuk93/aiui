# AI UI

A native macOS app whose whole UI is one Blink webview (CEF), driven by the `claude` CLI.

- Screens of **circles**. Each has two ears: left **×** removes or reduces it, right **+** selects, adds or increases it.
  Shift- or Cmd-click also selects. Clicking a circle opens the next screen, which the AI generates.
- **Go** (bottom center) appears when the AI gives the screen one, or when something is selected.
- Click **any empty place** (or just start typing), and the whole screen becomes a text area starting there.
  Enter sends, Shift-Enter adds a new line, Esc closes it.
  On an AI scene, typing goes to the scene's own key bindings; any key the scene does nothing with
  opens the text input. **⌘T** opens it anywhere (also on scenes that keep every key, like games).
- **No scrolling.** Bottom row: **Back · Go · More**. Circles that don't fit go to further pages. More appears on
  every screen the AI marks expandable (`more`). Open-ended sets, like the root's "things to do", are endless:
  a background, stateless Claude "pager" keeps one full page preloaded. Back appears after paging forward, or when
  the AI decides the context needs one (`back`).
- **Backspace** goes to the previous page, then the previous screen. Esc cancels a running AI turn.
  Arrow keys and PageUp/PageDown page through circles.
- **Memory cache** (`~/Library/Application Support/aiui/cache`, capped at `AIUI_CACHE_MB`, default 64; least
  recently used entries are evicted first). Each entry stores the user's action, its outcome (the screen) and a one-line
  index description written by the AI. `index.txt` is the searchable index; the AI greps it for history and
  preferences. Outcomes the AI marks `cacheable` (menus, categories) are replayed instantly when the action
  repeats, and the AI is told about those replays on its next turn. View › Clear Memory Cache empties it.
- The AI can also return a full-screen `text` screen, or a second-level `html` view it writes itself. That view is
  webview-aware and calls `aiui.sys(...)`, `aiui.next(...)` and `aiui.back()`.
- **Language**: the AI writes in the system language. The app's own words and root circles are
  translated once by the AI and cached.
- **Cursor trajectories**: the circle the pointer is heading for is highlighted, and its screen is
  prefetched in the background (read-only), so opening it is instant. Where the pointer lingered or
  hesitated goes to the AI as `attention`. Screens marked `live` get a background pass that updates
  their circles in place with real data.
- **Utilities library**: reusable things the AI builds (tools, calculators, converters, games) are
  saved to a category tree, sorted by use, and reachable from the root's Utilities circle. The AI
  sees the library and can bring any utility back by id.
- **JS libraries**: a catalog of 1,100+ verified browser libraries (`web/libraries.json`,
  `tools/libraries/`). Curated ones are on top, the rest discovered among jsDelivr's top 8,000, and
  the catalog keeps growing in the background on each device. The app installs libraries locally in the
  background within a budget it shares with the memory cache: 10 GB, at most 10% of the free disk,
  nothing below 5 GB free; least recently used go first. Screens declare `libs` and get local copies.
  View › Installed JS Libraries…
- **Native libraries** (Mac): command-line tools for the AI and its scenes — default set ffmpeg/ffprobe, yt-dlp,
  pandoc, jq, ripgrep, exiftool, xpdf-tools (pdftotext, pdftoppm, …), qpdf, 7-Zip (7zz); on request duckdb, fd,
  yq, typst, fzf. Only the projects' own prebuilt arm64 binaries, each artifact pinned by SHA-256 in
  `web/native.json` (`tools/native/catalog.py refresh` resolves `tools/native/sources.json`; a newer catalog is
  fetched from aiui.oeaio.com/native.json). Installed under `Application Support/aiui/native/<id>/<version>/`,
  hash-checked before unpacking, quarantine cleared only after that, live after the tool's own `--version` check,
  swapped atomically with the previous version kept for rollback; `native/bin` is on the PATH of every shell the
  app runs (after the user's own tools; `$AIUI_NATIVE_BIN`). The default set installs in the background on first
  launch — from a bundled pack first (`./build.sh --native-pack`), then by download only when policy allows:
  the setting "Download native libraries" (Settings), no admin denial (managed preference
  `AllowNativeDownloads = false`), no Low Data Mode or metered network, background work not paused. Events tell
  the AI what is installed; it asks for more with `aiui-native ensure <id>` from its shell, scenes with
  `aiui.sys({op:'native', action:'ensure', ids:[…]})`. Shares the disk budget; least recently used extras go
  first. View › Native Libraries… (tests: `tools/native/harness/run.sh`)
- **Self-checking screens**: every AI view renders hidden first while a UI test checks its real
  layout (overlaps, cropped text, overflow, contrast, broken images, emptiness). The tested render
  is then shown, and problems are repaired by the AI in place. Views also report errors and failed or slow
  resources, and must call `aiui.ready()`; stuck or failing views are repaired automatically. Failing
  hosts go to an avoid record that is rechecked with exponential backoff.
- **Scene QA** (`web/qa.js`): every AI scene is measured in two screen modes: the real size and
  theme, and a phone in the other theme. It gets 0–100 scores for UX, readability, accessibility
  (WCAG contrast, names, labels, touch targets) and security. A hidden lab clone with `aiui` mocked exercises
  every control and a corner-case suite: double clicks, keyboard only, empty, long and special input
  including HTML injection, offline, 320 px, 200% text, Back/More twice. The AI also writes each scene's
  **Definition of Done** and tests for it, which run in the lab. Anything under 70 or unmet goes back
  to the AI with the findings.
- **Context menus**: right-click (long press on touch) on any object. In the background the AI
  generates actions for every class of object on the scene, and decides per class whether a menu
  makes sense. Generation starts at once or when idle, depending on the median generation time
  against the median time until menus get used.
- **Scene listeners**: scenes handle Back/More (`aiui.onBack/onMore`) and find (`aiui.onFind`). A
  long press on Back returns to the circles.
- **Browser hotkeys**: ⌘F, ⌘= ⌘- ⌘0, ⌘R (⌘⇧R the app), ⌘[ ⌘], ⌘P, Home/End.
- **Retrospectives**: a journal of what went wrong (repairs, failed QA or DoD, timeouts, errors,
  quick exits, cancels). A periodic retrospective AI pass turns it into hints with evidence and
  confidence, which go to every generation.
- **System scene** (⇧⌘D): AI, storage, cache, libraries, utilities, profile, avoid record, the last
  scene's scores, corner cases and DoD, context-menu timing, and the retrospective with its hints.
- The app gives the AI full system access: `claude` runs with `--permission-mode bypassPermissions`, and
  `aiui.sys` exposes shell, JXA/AppleScript (every Cocoa API), open, file read/write, clipboard and notifications.

## AI provider

At launch the app looks for an agent CLI on the login PATH: `claude` (Claude Code), then `codex`, then `gemini`.
If none is found, it asks for an API key from any provider. Anthropic, OpenAI, Google, OpenRouter, Groq and xAI are
recognised from the key's prefix; any other OpenAI-compatible provider takes `<base-url> <key> [model]`. Keys are
kept in the macOS Keychain. With a key, the app runs its own agent loop: a `shell` tool for system access, and a
`screen` tool that ends the turn. View › AI Provider… switches between what's available. `AIUI_ENGINE` forces
one (`claude`, `codex`, `gemini`, `key`).

## Web version

`web/` also runs in an ordinary browser (https://aiui.oeaio.com). There is no Mac backend there:
`web/backend.js` answers the same `/api/*` calls in the page. The visitor's own API key is kept in
localStorage and goes only to its provider. The memory cache lives in localStorage (3 MB, least
recently used entries evicted first). Anthropic keys also get web search. There is no system access,
and AI-written views run in a sandboxed iframe that reaches `aiui` through postMessage, so they can't
read the key. The prompts come from `Sources/App/Prompts.swift`, with a web section in place of the
Mac one (`tools/export-prompts`).

Deploy: run `deploy/request-cert.sh` once and wait for ISSUED, then `deploy/deploy-web.sh`. This uses a
CloudFormation stack `aiui-web` (private S3 bucket, CloudFront with origin access control, Route 53
alias in the `oeaio.com` zone).

Auto-deploy: `.github/workflows/deploy-web.yml` deploys on every push to `main` that touches the web
version, through an AWS role assumed with GitHub OIDC (no stored keys). One-time setup:

    aws cloudformation deploy --region us-east-1 --stack-name aiui-github \
      --template-file deploy/github-role.yaml --capabilities CAPABILITY_NAMED_IAM
    gh variable set AWS_DEPLOY_ROLE_ARN --body "$(aws cloudformation describe-stacks --region us-east-1 \
      --stack-name aiui-github --query 'Stacks[0].Outputs[0].OutputValue' --output text)"

## Build

    ./build.sh          # downloads CEF 156 (arm64) into vendor/ the first time, builds build/AI UI.app
    ./build.sh run      # build and launch, serving web/ live from the source tree (Cmd-R reloads)

Environment variables: `AIUI_CACHE_MB` (memory cache limit), `AIUI_MODEL` (passed to `claude --model`), `AIUI_WEB` (web root override),
`AIUI_DEBUG_PORT` (Chrome DevTools Protocol port). Cmd-Opt-I opens DevTools, and Cmd-N starts a new AI session.

## Layout

- `Sources/Native`: the CEF bridge (ObjC++): the NSApplication subclass, the browser, the `aiui://` scheme with `/api/*` mapped to Swift, and the helper main.
- `Sources/App`: the Swift shell: window and menus, the API endpoints, the `claude` runner and prompts.
- `web/`: the circles UI.
