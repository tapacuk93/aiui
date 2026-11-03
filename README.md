# aiui

A native macOS app whose whole UI is one Blink webview (CEF), driven by the `claude` CLI.

- Screens of **circles**. Each has two ears: left **×** removes or reduces it, right **+** selects, adds or increases it.
  Shift- or Cmd-click also selects. Clicking a circle opens the next screen, which the AI generates.
- **Go** (bottom center) appears when the AI gives the screen one, or when something is selected.
- Click **any empty place** (or just start typing), and the whole screen becomes a text area starting there.
  Enter sends, Shift-Enter adds a new line, Esc closes it.
- **Backspace** goes back (Esc cancels a running AI turn). Arrows and PageUp/PageDown, or the ↑ ↓ buttons, page through circles.
- Open-ended sets (the root's "things to do" among them) are infinite: a background stateless Claude "pager"
  loads the next page whenever less than one screen is left below.
- The AI can also return a full-screen `text` screen, or a second-level `html` view it writes itself. That view is
  webview-aware and calls `aiui.sys(...)`, `aiui.next(...)` and `aiui.back()`.
- The app gives the AI full system access: `claude` runs with `--permission-mode bypassPermissions`, and
  `aiui.sys` exposes shell, JXA/AppleScript (every Cocoa API), open, file read/write, clipboard and notifications.

## Build

    ./build.sh          # downloads CEF 156 (arm64) into vendor/ the first time, builds build/aiui.app
    ./build.sh run      # build and launch, serving web/ live from the source tree (Cmd-R reloads)

Environment variables: `AIUI_MODEL` (passed to `claude --model`), `AIUI_WEB` (web root override),
`AIUI_DEBUG_PORT` (Chrome DevTools Protocol port). Cmd-Opt-I opens DevTools, and Cmd-N starts a new AI session.

## Layout

- `Sources/Native`: the CEF bridge (ObjC++): the NSApplication subclass, the browser, the `aiui://` scheme with `/api/*` mapped to Swift, and the helper main.
- `Sources/App`: the Swift shell: window and menus, the API endpoints, the `claude` runner and prompts.
- `web/`: the circles UI.
