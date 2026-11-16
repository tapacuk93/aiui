#!/bin/sh
# 100% line, branch and function coverage of the Node backend (services/): the handlers, the stores,
# the GitHub mirror, the analysis, the Lambda adapter and the local server. Runs the services tests
# with Node's built-in coverage and fails below 100%, listing every uncovered line, branch and
# function as file:line.
#   tools/coverage/services.sh
# Not measured: services/test/** (the tests) and services/mock-github.mjs (a test double of the
# GitHub API that the tests and `local-server.mjs --mirror` talk to instead of GitHub).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
cd "$ROOT/services"
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
status=0
node --test --experimental-test-coverage \
  --test-coverage-include='src/**' --test-coverage-include='*.mjs' \
  --test-coverage-exclude='test/**' --test-coverage-exclude='mock-github.mjs' \
  --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination="$OUT/lcov.info" \
  test/*.test.mjs || status=$?
# every source file must be in the report, also one that no test imports
node "$ROOT/tools/coverage/services-report.mjs" "$OUT/lcov.info" local-server.mjs $(find src -name '*.mjs' | sort) || status=1
exit $status
