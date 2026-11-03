#!/bin/sh
# Smoke test of the UI's AI-turn paths with a stubbed backend (no AI calls). Needs a running
# AI UI with AIUI_DEBUG_PORT=9333 (its Chromium hosts a temporary tab):
#   AIUI_DEBUG_PORT=9333 "build/AI UI.app/Contents/MacOS/aiui" &  then  tools/smoke/run.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rm -rf "$ROOT/build/webdist" && cp -R "$ROOT/web" "$ROOT/build/webdist"
(cd "$ROOT/build/webdist" && exec python3 -m http.server 8765 >/dev/null 2>&1) & SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
TID=$(node -e "
const v = await (await fetch('http://127.0.0.1:9333/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'http://127.0.0.1:8765/' } }));
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { console.log(d.result.targetId); process.exit(0); } };" --input-type=module)
sleep 2
STATUS=0
OUT=$(node "$ROOT/tools/smoke/smoke-page.mjs" "$TID") || STATUS=$?
node -e "
const v = await (await fetch('http://127.0.0.1:9333/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
ws.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: '$TID' } }));
ws.onmessage = () => process.exit(0);" --input-type=module
echo "$OUT"
[ $STATUS -eq 0 ] && echo "smoke test passed" || { echo "SMOKE TEST FAILED" >&2; exit 1; }
