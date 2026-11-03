#!/usr/bin/env python3
"""Builds web/libraries.json from catalog.source.json: resolves each package's version on
jsDelivr, verifies every file exists, and records sizes. Run when changing the catalog:
    python3 tools/libraries/resolve.py
Entry: [id, npm package, version range, files, global, category, description, priority]"""
import json, os, sys, urllib.request, concurrent.futures as cf

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
src = json.load(open(os.path.join(ROOT, "tools/libraries/catalog.source.json")))

def get(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "aiui-catalog"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.headers, (r.read() if method == "GET" else b"")

def resolve(entry):
    lid, pkg, rng, files, glob, cat, desc, prio = entry
    try:
        _, _, body = get(f"https://data.jsdelivr.com/v1/packages/npm/{pkg}/resolved?specifier={rng}")
        version = json.loads(body).get("version")
        if not version:
            return lid, None, f"no version for {pkg}@{rng}"
        out, total = [], 0
        for f in files:
            url = f"https://cdn.jsdelivr.net/npm/{pkg}@{version}/{f}"
            status, headers, body = get(url)
            if status != 200 or len(body) < 64:
                return lid, None, f"{url} -> {status}"
            total += len(body)
            out.append({"url": url, "name": os.path.basename(f), "type": "css" if f.endswith(".css") else "js",
                        "bytes": len(body)})
        return lid, {"id": lid, "package": pkg, "version": version, "files": out, "global": glob, "category": cat,
                     "description": desc, "priority": prio, "bytes": total}, None
    except Exception as e:
        return lid, None, f"{pkg}: {e}"

with cf.ThreadPoolExecutor(12) as ex:
    results = list(ex.map(resolve, src))
catalog = [r for _, r, _ in results if r]
for lid, _, err in results:
    if err:
        print("SKIP", lid, err, file=sys.stderr)
# Merge what discover.py found (the curated entries win on the same id/package).
disc = os.path.join(ROOT, "tools/libraries/discovered.json")
if os.path.exists(disc):
    have = {r["id"] for r in catalog} | {r["package"] for r in catalog}
    catalog += [r for r in json.load(open(disc)) if r["id"] not in have and r["package"] not in have]
catalog.sort(key=lambda r: (-r["priority"], r["id"]))
json.dump({"libraries": catalog}, open(os.path.join(ROOT, "web/libraries.json"), "w"), separators=(",", ":"))
print(f"{len(catalog)} libraries, {sum(r['bytes'] for r in catalog) / 1e6:.1f} MB total")
