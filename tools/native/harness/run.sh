#!/bin/zsh
# Builds and runs the native store test harness (tools/native/harness/main.swift).
#   tools/native/harness/run.sh blocked | mismatch | update | pack DIR | install | shell
set -euo pipefail
cd "${0:A:h}/../../.."
out=build/native-harness
mkdir -p build
if [[ ! -x $out || -n "$(find Sources/App/NativeLibraries.swift Sources/App/Libraries.swift Sources/Mac/Shell.swift tools/native/harness/main.swift -newer $out)" ]]; then
  swiftc -O -swift-version 5 -target arm64-apple-macos13.0 -module-name harness \
    Sources/App/NativeLibraries.swift Sources/App/Libraries.swift Sources/Mac/Shell.swift tools/native/harness/main.swift -o $out
fi
exec $out "$PWD/web" "$@"
