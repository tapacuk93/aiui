#!/usr/bin/env python3
"""Discovers browser-ready libraries among jsDelivr's most-used npm packages: a package
qualifies when its package.json names a browser bundle (`jsdelivr`, `unpkg` or a string
`browser` field) that is a plain .js file. Detects the UMD global name from the bundle head,
verifies the file, and writes tools/libraries/discovered.json for resolve.py to merge.
    python3 tools/libraries/discover.py [how-many-top-packages=3000]"""
import json, os, re, sys, urllib.request, concurrent.futures as cf

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOP = int(sys.argv[1]) if len(sys.argv) > 1 else 3000

def get(url, limit=None, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "aiui-catalog"})
    if limit: req.add_header("Range", f"bytes=0-{limit}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.headers, r.read()

# 1. the most-used npm packages on jsDelivr (by monthly hits), page by page
names, page = [], 1
while len(names) < TOP:
    _, _, body = get(f"https://data.jsdelivr.com/v1/stats/packages?period=month&type=npm&limit=100&page={page}")
    batch = json.loads(body)
    if not batch: break
    names += [(p["name"], len(names) + i) for i, p in enumerate(batch) if p.get("type") == "npm"]
    page += 1
names = names[:TOP]
print(f"{len(names)} packages to examine", file=sys.stderr)

GLOBAL = [re.compile(p) for p in [
    r"(?:root|global|globalThis|self|window|e|t|n|r)\[?[.\"']([A-Za-z_$][\w$]*)[\"']?\]?\s*=\s*(?:factory|t\(\)|e\(\)|n\(\)|r\(\))",
    r"\.([A-Za-z_$][\w$]{1,40})\s*=\s*factory\(",
    r"var\s+([A-Za-z_$][\w$]{1,40})\s*=\s*\(?function\s*\(",
]]

def examine(item):
    name, rank = item
    try:
        _, _, body = get(f"https://cdn.jsdelivr.net/npm/{name}/package.json")
        pkg = json.loads(body)
        entry = pkg.get("jsdelivr") or pkg.get("unpkg") or (pkg["browser"] if isinstance(pkg.get("browser"), str) else None)
        if not entry or not isinstance(entry, str) or not entry.endswith(".js") or entry.endswith((".mjs", ".cjs", ".esm.js")):
            return None
        entry = entry.lstrip("./")
        version = pkg.get("version")
        url = f"https://cdn.jsdelivr.net/npm/{name}@{version}/{entry}"
        status, headers, head = get(url, limit=4095)
        if status not in (200, 206): return None
        size = int((headers.get("Content-Range") or "/0").split("/")[-1] or 0) or int(headers.get("Content-Length") or 0)
        text = head.decode("utf-8", "ignore")
        if re.search(r"^\s*(import|export)\s", text, re.M): return None       # an ES module, not a browser global
        glob = ""
        for g in GLOBAL:
            m = g.search(text)
            if m: glob = m.group(1); break
        desc = (pkg.get("description") or "").strip().replace("\n", " ")[:120]
        return {"id": name, "package": name, "version": version, "global": glob or "(UMD)", "category": "npm",
                "description": desc, "priority": max(1, 50 - rank // 60), "bytes": size,
                "files": [{"url": url, "name": os.path.basename(entry), "type": "js", "bytes": size}]}
    except Exception:
        return None

with cf.ThreadPoolExecutor(24) as ex:
    found = [r for r in ex.map(examine, names) if r]
json.dump(found, open(os.path.join(ROOT, "tools/libraries/discovered.json"), "w"), indent=0)
print(f"{len(found)} browser-ready libraries, {sum(r['bytes'] for r in found) / 1e6:.0f} MB", file=sys.stderr)
