#!/bin/zsh
# Tests the app's client for shared.aiui.oeaio.com / users.aiui.oeaio.com against the local stub:
# signing checked by node:crypto, then every flow (tools/shared-client/harness/main.swift).
set -euo pipefail
HERE=${0:A:h}
ROOT=${HERE:h:h}
cd "$HERE"
OUT=${TMPDIR:-/tmp}/aiui-shared-client-test
mkdir -p "$OUT"
PORT=${PORT:-8790}

swiftc -O -swift-version 5 -target arm64-apple-macos13.0 -o "$OUT/harness" harness/main.swift \
  "$ROOT"/Sources/App/{AppIdentity,SharedRegistry,People,Utilities,Storage,Prompts}.swift -framework Security 2>"$OUT/build.log" || { grep error "$OUT/build.log"; exit 1; }

echo "• signing (node:crypto)"
"$OUT/harness" sign | node verify-sign.mjs

echo "• flows against the stub"
node stub.mjs "$PORT" & STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
sleep 0.5
AIUI_SHARED_URL=http://127.0.0.1:$PORT AIUI_USERS_URL=http://127.0.0.1:$PORT AIUI_IDENTITY_SERVICE=com.oeaio.aiui.identity.test \
  "$OUT/harness" flows

# Against the real backend (services/local-server.mjs), when it is in this tree.
if [[ -f "$ROOT/services/local-server.mjs" ]]; then
  echo "• flows against services/local-server.mjs"
  RPORT=${RPORT:-8797}
  node "$ROOT/services/local-server.mjs" --port "$RPORT" >"$OUT/server.log" 2>&1 & SERVER=$!
  trap 'kill $STUB $SERVER 2>/dev/null' EXIT
  sleep 0.8
  AIUI_SHARED_URL=http://127.0.0.1:$RPORT/shared AIUI_USERS_URL=http://127.0.0.1:$RPORT/users AIUI_IDENTITY_SERVICE=com.oeaio.aiui.identity.test \
    "$OUT/harness" flows real
fi
