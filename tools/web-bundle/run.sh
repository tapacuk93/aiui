#!/bin/sh
# Bundles and minifies a copy of web/ in place: tools/web-bundle/run.sh <dist-dir>
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
[ -d "$HERE/node_modules/esbuild" ] || npm ci --prefix "$HERE" --silent --no-audit --no-fund
node "$HERE/bundle.mjs" "$1"
