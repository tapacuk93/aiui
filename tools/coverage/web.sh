#!/bin/sh
# Coverage of the web client (web/*.js): runs the tests in tools/coverage/web (headless Chromium,
# Playwright, a fake backend and fake AI providers; nothing real is called) and fails unless every
# file has 100% line coverage. Prints per-file lines/branches/functions and every uncovered line
# range; the HTML report goes to tools/coverage/web/.out/html/index.html.
#   tools/coverage/web.sh               all tests, then the report
#   tools/coverage/web.sh tests/qa      only matching spec files (the report then shows a part)
#   MIN_LINES=95 tools/coverage/web.sh  another threshold
set -eu
DIR=$(cd "$(dirname "$0")/web" && pwd)
cd "$DIR"
if [ ! -d node_modules/@playwright/test ] || [ ! -d node_modules/v8-to-istanbul ]; then
  npm ci --no-audit --no-fund --silent
fi
# The Chromium build this Playwright version drives (cached in ~/Library/Caches/ms-playwright).
npx playwright install chromium-headless-shell >/dev/null 2>&1 || npx playwright install chromium-headless-shell
rm -rf .out
STATUS=0
npx playwright test "$@" || STATUS=$?
node report.mjs --min-lines "${MIN_LINES:-100}" || STATUS=1
if [ "$STATUS" -ne 0 ]; then echo "web coverage: FAILED" >&2; exit 1; fi
echo "web coverage: OK"
