#!/bin/bash
# Runs the tests with coverage and fails unless every source line is covered (100% line coverage).
#   ./coverage.sh            test + gate
#   ./coverage.sh --report   also print the per-file llvm-cov report
#
# Measured: every file in Sources/OSInstallerCore (all logic: probes, layout parsing, preflight, planners,
# safety guard, executor, CLI).
# Excluded, and why:
#   - Tests/                  the test target itself.
#   - Sources/aiui-os/        main.swift only: one line, `exit(CLI.live().run(arguments))`. It is not linked
#                             into the test bundle and calling `exit` would end the test process; `CLI.live()`
#                             and `CLI.run` that it calls are covered by the tests.
#   - .build/                 dependencies and generated code (there are none today).
# The real executor is NOT excluded: its gates and its run loop are tested with a recording runner.
set -euo pipefail
cd "$(dirname "$0")"

swift test --enable-code-coverage

BIN=$(swift build --show-bin-path)
PROFDATA="$(dirname "$(swift test --show-codecov-path)")/default.profdata"
TESTBIN=$(ls -d "$BIN"/*.xctest/Contents/MacOS/* | head -1)
IGNORE='(/Tests/|/\.build/|/Sources/aiui-os/)'

[[ ${1:-} == --report ]] && xcrun llvm-cov report "$TESTBIN" -instr-profile "$PROFDATA" -ignore-filename-regex="$IGNORE" Sources

# lcov: "SF:<file>" starts a file, "DA:<line>,<count>" is one executable line.
xcrun llvm-cov export -format=lcov "$TESTBIN" -instr-profile "$PROFDATA" -ignore-filename-regex="$IGNORE" Sources |
LC_ALL=C awk -F'[:,]' '
  /^SF:/ { file = substr($0, 4); sub(".*/Sources/", "Sources/", file); files++ }
  /^DA:/ { lines++; if ($3 == 0) { missed++; print "  not covered: " file ":" $2 } else covered++ }
  END {
    if (files == 0 || lines == 0) { print "coverage: no data"; exit 1 }
    printf "line coverage: %d/%d lines in %d files (%.2f%%)\n", covered, lines, files, 100 * covered / lines
    if (missed > 0) { print "FAIL: line coverage is below 100%"; exit 1 }
    print "OK: 100% line coverage"
  }'
