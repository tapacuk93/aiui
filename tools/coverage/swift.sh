#!/bin/zsh
# Swift line coverage gate: builds the test package (Package.swift at the repo root), runs every
# XCTest with coverage, and fails unless every line of Sources/App and Sources/Mac is covered,
# apart from the exclusions below. Prints each uncovered line as file:line.
#   tools/coverage/swift.sh            run tests, report, gate
#   tools/coverage/swift.sh --report   per-file table even when the gate passes
#   tools/coverage/swift.sh --no-test  reuse the last run's profile (no rebuild)
set -euo pipefail
cd "${0:A:h}/../.."

# Exclusions, one per line: "<path>[::<func name>]  <reason>". A path excludes the whole file; with
# ::name, the body of `func name` / `init` / `var name` in that file (first match).
EXCLUDE=(
  "Sources/iOS/AIUIApp.swift            UIKit/SwiftUI app; built only by the iOS Xcode project (project.yml), not on macOS"
  "Sources/iOS/SystemAccess.swift       UIKit; built only by the iOS Xcode project"
  "Sources/iOS/WebView.swift            WKWebView + UIKit; built only by the iOS Xcode project"
  "Sources/Mac/main.swift               process entry point, one line: exit(AppMain.run()); AppMain is tested"
  "Sources/Mac/AppDelegate.swift::present   default hook that puts a real window on screen and activates the app"
  "Sources/Mac/AppDelegate.swift::install   default hook that installs the menu bar and gives the process a Dock icon"
)

REPORT=0; TEST=1
for a in "$@"; do
  case $a in
    --report) REPORT=1 ;;
    --no-test) TEST=0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

if (( TEST )); then
  mkdir -p .build
  log=.build/swift-test.log
  if ! swift test --enable-code-coverage >"$log" 2>&1; then
    grep -E "error:|failed|fatal|Fatal" "$log" | grep -v "^\[" | head -60
    echo "✗ tests failed (full log: $log)"; exit 1
  fi
  grep -E "^Test Suite 'All tests'|Executed [0-9]+ tests" "$log" | tail -2
fi

BIN=$(swift build --show-bin-path)
PROF=$BIN/codecov/default.profdata
XCT=$(print -l "$BIN"/*.xctest/Contents/MacOS/*(N) | head -1)
[[ -f $PROF && -n $XCT && -f $XCT ]] || { echo "✗ no coverage data (run without --no-test)"; exit 1; }

xcrun llvm-cov export -format=lcov -instr-profile "$PROF" "$XCT" > "$BIN/codecov/swift.lcov"

python3 -I - "$PWD" "$BIN/codecov/swift.lcov" "$REPORT" "${EXCLUDE[@]}" <<'PY'
import os, re, sys
root, lcov, report, excl = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4:]

def body(path, name):
    """Line range of the first `func name`/`init`/`var name` declaration in path (brace matched)."""
    lines = open(os.path.join(root, path)).read().split("\n")
    pat = re.compile(r"\b(func|var|init)\s*" + re.escape(name) + r"\b" if name != "init" else r"\binit\s*[(<]")
    for i, l in enumerate(lines):
        if pat.search(l):
            depth, started = 0, False
            for j in range(i, len(lines)):
                depth += lines[j].count("{") - lines[j].count("}")
                started = started or "{" in lines[j]
                if started and depth <= 0: return range(i + 1, j + 2)
    sys.exit(f"✗ exclusion {path}::{name}: declaration not found")

whole, ranges = set(), {}
for e in excl:
    target = e.split()[0]
    if "::" in target:
        p, n = target.split("::"); ranges.setdefault(p, []).append(body(p, n))
    else:
        whole.add(target)

data, cur = {}, None
for l in open(lcov):
    l = l.strip()
    if l.startswith("SF:"):
        cur = os.path.relpath(l[3:], root)
        data.setdefault(cur, {})
    elif l.startswith("DA:") and cur:
        n, c = l[3:].split(",")[:2]
        data[cur][int(n)] = max(data[cur].get(int(n), 0), int(c))

sources = sorted(os.path.join(d, f) for d in ["Sources/App", "Sources/Mac", "Sources/iOS"]
                 if os.path.isdir(os.path.join(root, d)) for f in os.listdir(os.path.join(root, d)) if f.endswith(".swift"))
missing, uncovered, rows = [], [], []
tot_l = tot_c = 0
for s in sources:
    if s in whole: rows.append((s, None, None)); continue
    if s not in data: missing.append(s); continue
    skip = set(n for r in ranges.get(s, []) for n in r)
    lines = {n: c for n, c in data[s].items() if n not in skip}
    cov = sum(1 for c in lines.values() if c > 0)
    rows.append((s, cov, len(lines)))
    tot_l += len(lines); tot_c += cov
    uncovered += [f"{s}:{n}" for n, c in sorted(lines.items()) if c == 0]

pct = 100.0 * tot_c / tot_l if tot_l else 100.0
if report or uncovered or missing:
    for s, c, n in rows:
        print(f"  {s:42} " + ("excluded" if c is None else f"{100.0 * c / n if n else 100:6.2f}%  {c}/{n}"))
for u in uncovered: print("uncovered", u)
for m in missing: print(f"✗ {m}: not compiled into the tests (add it to Package.swift or EXCLUDE)")
print(f"Swift line coverage: {pct:.2f}% ({tot_c}/{tot_l} lines)")
if uncovered or missing:
    print("✗ below 100% line coverage"); sys.exit(1)
print("✓ 100% line coverage")
PY
