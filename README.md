# AI UI

A native macOS app whose whole UI is one Blink webview (CEF), driven by the `claude` CLI.

- Screens of **circles**. Each has two ears: left **×** removes or reduces it, right **+** selects, adds or increases it.
  Shift- or Cmd-click also selects. Clicking a circle opens the next screen, which the AI generates.
- **Go** (bottom center) appears when the AI gives the screen one, or when something is selected.
- Click **any empty place** (or just start typing), and the whole screen becomes a text area starting there.
  Enter sends, Shift-Enter adds a new line, Esc closes it.
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

## Build

    ./build.sh          # downloads CEF 156 (arm64) into vendor/ the first time, builds build/AI UI.app
    ./build.sh run      # build and launch, serving web/ live from the source tree (Cmd-R reloads)

Environment variables: `AIUI_CACHE_MB` (memory cache limit), `AIUI_MODEL` (passed to `claude --model`), `AIUI_WEB` (web root override),
`AIUI_DEBUG_PORT` (Chrome DevTools Protocol port). Cmd-Opt-I opens DevTools, and Cmd-N starts a new AI session.

## Layout

- `Sources/Native`: the CEF bridge (ObjC++): the NSApplication subclass, the browser, the `aiui://` scheme with `/api/*` mapped to Swift, and the helper main.
- `Sources/App`: the Swift shell: window and menus, the API endpoints, the `claude` runner and prompts.
- `web/`: the circles UI.
