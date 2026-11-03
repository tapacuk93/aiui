#!/usr/bin/env python3
"""The native tool catalog: resolves tools/native/sources.json into web/native.json (bundled with
the app, and served at https://aiui.oeaio.com/native.json for the app's update check).

    python3 -I tools/native/catalog.py refresh [--cache DIR]   resolve latest versions, download every
                                                               artifact, pin its SHA-256, write the catalog
    python3 -I tools/native/catalog.py pack DIR [--cache DIR]  the default set's artifacts for an offline
                                                               pack (build.sh --native-pack), hash-checked

For each artifact `refresh` downloads the file, computes its SHA-256 and compares it with what the
project publishes (GitHub's asset digest, a SHA256SUMS file, a .sha256 file, exiftool's
checksums.txt); a mismatch is an error. It then lists the archive, finds each executable, checks it
is an arm64 (or universal) Mach-O or a script, and that it links nothing outside macOS (otool -L,
the archive's own @rpath/@loader_path libraries allowed). What it fetched is recorded in
tools/native/refresh-log.json. GITHUB_TOKEN raises GitHub's rate limit (optional).

Downloads are untrusted data: they are only hashed, listed and inspected with otool, never run.
"""
import hashlib, json, os, re, shutil, subprocess, sys, tarfile, tempfile, time, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCES = os.path.join(ROOT, "tools/native/sources.json")
CATALOG = os.path.join(ROOT, "web/native.json")
LOG = os.path.join(ROOT, "tools/native/refresh-log.json")


def curl(url, out=None, accept=None):
    """Fetches with /usr/bin/curl (the system trust store; some hosts send incomplete chains)."""
    cmd = ["/usr/bin/curl", "-fsSL", "--retry", "2", "-A", "aiui-native-catalog"]
    if accept: cmd += ["-H", "Accept: " + accept]
    if "api.github.com" in url and os.environ.get("GITHUB_TOKEN"):
        cmd += ["-H", "Authorization: Bearer " + os.environ["GITHUB_TOKEN"]]
    cmd += ["-o", out] if out else []
    r = subprocess.run(cmd + [url], capture_output=True)
    if r.returncode != 0: raise RuntimeError(f"{url}: curl exit {r.returncode} {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


def get(url, accept=None): return curl(url, accept=accept)


def text(url): return get(url).decode("utf-8", "replace")


def download(url, cache):
    """Downloads into the cache (once per URL) and returns (path, sha256, bytes)."""
    name = hashlib.sha256(url.encode()).hexdigest()[:16] + "-" + os.path.basename(url.split("?")[0].removesuffix("/download"))
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        curl(url, out=path + ".part")
        os.replace(path + ".part", path)
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return path, h.hexdigest(), os.path.getsize(path)


def parse_sums(body):
    """sha256sum / BSD-style lines → {file name: sha256}."""
    out = {}
    for line in body.splitlines():
        m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$", line.strip())
        if m: out[os.path.basename(m.group(2))] = m.group(1).lower(); continue
        m = re.match(r"^SHA2?-?256\s*\(([^)]+)\)\s*=\s*([0-9a-fA-F]{64})", line.strip())
        if m: out[m.group(1)] = m.group(2).lower()
    return out


# ---------------------------------------------------------------- resolvers → (version, [artifact])
# artifact: {url, name, format, published: sha256|None, publishedFrom, bin: {exe: path} | exe: [names]}

def resolve_github(tool, r):
    rel = json.loads(get(f"https://api.github.com/repos/{r['repo']}/releases/latest", "application/vnd.github+json"))
    version = rel["tag_name"].lstrip("v").removeprefix("jq-")
    sums = {}
    if r.get("sums"):
        for a in rel["assets"]:
            if re.search(r["sums"], a["name"]):
                sums.update(parse_sums(text(a["browser_download_url"])))
    arts = []
    for spec in r["assets"]:
        asset = next((a for a in rel["assets"] if re.search(spec["match"], a["name"])), None)
        if not asset: raise RuntimeError(f"{r['repo']} {version}: no asset matching {spec['match']}")
        published, frm = None, None
        if (asset.get("digest") or "").startswith("sha256:"):
            published, frm = asset["digest"][7:], "GitHub release asset digest"
        if asset["name"] in sums:
            if published and published != sums[asset["name"]]:
                raise RuntimeError(f"{asset['name']}: GitHub digest and {r['sums']} disagree")
            published, frm = sums[asset["name"]], (frm + " + " if frm else "") + "release checksum file"
        arts.append({"url": asset["browser_download_url"], "name": asset["name"], "format": spec["format"],
                     "published": published, "publishedFrom": frm, "bin": spec.get("bin"), "exe": spec.get("exe")})
    return version, arts, rel.get("html_url")


def resolve_ffmpeg(tool, r):
    page = text("https://ffmpeg.martin-riedl.de/")
    builds = set(re.findall(r'/download/macos/arm64/(\d+_(\d+\.\d+(?:\.\d+)?))/ffmpeg\.zip', page))
    if not builds: raise RuntimeError("ffmpeg: no macOS arm64 release build listed")
    key = lambda b: tuple(int(x) for x in b[1].split("."))
    folder, version = max(builds, key=key)
    arts = []
    for f in r["files"]:
        url = f"https://ffmpeg.martin-riedl.de/download/macos/arm64/{folder}/{f}.zip"
        published = text(url + ".sha256").split()[0].lower()
        arts.append({"url": url, "name": f + ".zip", "format": "zip", "published": published,
                     "publishedFrom": "build server .sha256", "exe": [f]})
    return version, arts, "https://ffmpeg.martin-riedl.de/"


def resolve_exiftool(tool, r):
    version = text("https://exiftool.org/ver.txt").strip()
    name = f"Image-ExifTool-{version}.tar.gz"
    sums = parse_sums(text("https://exiftool.org/checksums.txt"))
    if name not in sums: raise RuntimeError("exiftool: no checksum for " + name)
    # exiftool.org links its downloads to SourceForge (the hash is the one exiftool.org publishes).
    return version, [{"url": f"https://sourceforge.net/projects/exiftool/files/{name}/download", "name": name, "format": "tar", "published": sums[name],
                      "publishedFrom": "exiftool.org/checksums.txt", "exe": ["exiftool"]}], "https://exiftool.org"


def resolve_xpdf(tool, r):
    page = text("https://www.xpdfreader.com/download.html")
    m = re.search(r'https://dl\.xpdfreader\.com/(xpdf-tools-mac-(\d+\.\d+(?:\.\d+)?)\.tar\.gz)"', page)
    if not m: raise RuntimeError("xpdf: no mac tools link")
    # The publisher offers only a GPG signature (.sig), no checksum: the hash is pinned at refresh.
    return m.group(2), [{"url": "https://dl.xpdfreader.com/" + m.group(1), "name": m.group(1), "format": "tar",
                         "published": None, "publishedFrom": "none (GPG signature only); pinned at refresh",
                         "exe": r["exe"], "prefer": r.get("prefer")}], "https://www.xpdfreader.com/download.html"


RESOLVERS = {"github": resolve_github, "ffmpeg-riedl": resolve_ffmpeg, "exiftool": resolve_exiftool, "xpdf": resolve_xpdf}


# ---------------------------------------------------------------- inspection

def fmt_of(art):
    f = art["format"]
    if f != "auto": return f
    return "zip" if art["name"].endswith(".zip") else "tar"


def members(path, fmt):
    """[(name, size, is_file, is_exec)] of an archive."""
    if fmt == "zip":
        with zipfile.ZipFile(path) as z:
            out = []
            for i in z.infolist():
                mode = (i.external_attr >> 16) & 0o170777
                is_link = (mode & 0o170000) == 0o120000
                out.append((i.filename.rstrip("/"), i.file_size, not i.is_dir() and not is_link, bool(mode & 0o111)))
            return out
    with tarfile.open(path) as t:
        return [(m.name.lstrip("./"), m.size, m.isfile(), bool(m.mode & 0o111)) for m in t.getmembers()]


def safe_names(names):
    for n in names:
        if n.startswith("/") or ".." in n.split("/"): raise RuntimeError(f"unsafe path in archive: {n}")


def extract(path, fmt, dest):
    if fmt == "zip":
        subprocess.run(["/usr/bin/ditto", "-x", "-k", path, dest], check=True)
    else:
        subprocess.run(["/usr/bin/tar", "-xf", path, "-C", dest], check=True)


ARM64 = 0x0100000C


def macho_kind(data):
    if data[:2] == b"#!": return "script:" + data[2:data.find(b"\n")].decode(errors="replace").strip()
    if data[:4] == b"\xcf\xfa\xed\xfe":
        return "arm64" if int.from_bytes(data[4:8], "little") == ARM64 else "mach-o other"
    if data[:4] == b"\xca\xfe\xba\xbe":
        n = int.from_bytes(data[4:8], "big")
        cpus = [int.from_bytes(data[8 + 20 * i:12 + 20 * i], "big") for i in range(min(n, 8))]
        return "universal (arm64)" if ARM64 in cpus else "universal (no arm64)"
    return "unknown"


def foreign_libs(file):
    out = subprocess.run(["/usr/bin/otool", "-L", file], capture_output=True, text=True).stdout
    # Universal binaries list each architecture under a "file (architecture x):" line.
    libs = [l.strip().split(" (")[0] for l in out.splitlines() if l.startswith("\t")]
    return [l for l in libs if not (l.startswith("/usr/lib/") or l.startswith("/System/") or l.startswith("@rpath/")
                                    or l.startswith("@loader_path/") or l.startswith("@executable_path/"))]


def inspect(tool, art, path, sha):
    """Finds the executables, checks architecture and linkage; returns (bin map, installed bytes)."""
    fmt = fmt_of(art)
    if fmt == "file":
        with open(path, "rb") as f: kind = macho_kind(f.read(4096))
        if kind not in ("arm64", "universal (arm64)"): raise RuntimeError(f"{art['name']}: {kind}")
        bad = foreign_libs(path)
        if bad: raise RuntimeError(f"{art['name']} links {bad}")
        return {exe: art["name"] for exe in art["bin"]}, os.path.getsize(path), {exe: kind for exe in art["bin"]}
    ms = members(path, fmt)
    safe_names([m[0] for m in ms])
    total = sum(m[1] for m in ms if m[2])
    with tempfile.TemporaryDirectory() as tmp:
        extract(path, fmt, tmp)
        bins, kinds = {}, {}
        for exe in art["exe"]:
            cands = [m[0] for m in ms if m[2] and os.path.basename(m[0]) == exe]
            if art.get("prefer"): cands.sort(key=lambda n: (art["prefer"] not in "/" + n, len(n)))
            else: cands.sort(key=len)
            if not cands: raise RuntimeError(f"{art['name']}: no {exe} inside")
            rel = cands[0]
            full = os.path.join(tmp, rel)
            with open(full, "rb") as f: kind = macho_kind(f.read(4096))
            if not (kind in ("arm64", "universal (arm64)") or kind.startswith("script:")):
                raise RuntimeError(f"{art['name']}: {rel} is {kind}")
            if not kind.startswith("script:"):
                bad = foreign_libs(full)
                if bad: raise RuntimeError(f"{art['name']}: {rel} links {bad}")
            bins[exe], kinds[exe] = rel, kind
        return bins, total, kinds


# ---------------------------------------------------------------- commands

def refresh(cache):
    src = json.load(open(SOURCES))
    old = json.load(open(CATALOG)) if os.path.exists(CATALOG) else {}
    tools, log, errors = [], [], []
    for t in src["tools"]:
        try:
            version, arts, release = RESOLVERS[t["resolver"]["type"]](t, t["resolver"])
            out_arts, size, installed, kinds = [], 0, 0, {}
            for a in arts:
                path, sha, n = download(a["url"], cache)
                if a["published"] and a["published"].lower() != sha:
                    raise RuntimeError(f"{a['name']}: downloaded sha256 {sha} != published {a['published']}")
                bins, inst, k = inspect(t, a, path, sha)
                kinds.update(k)
                out_arts.append({"url": a["url"], "name": a["name"], "format": fmt_of(a), "sha256": sha, "bytes": n, "bin": bins})
                size += n; installed += inst
                log.append({"tool": t["id"], "version": version, "url": a["url"], "sha256": sha, "bytes": n,
                            "checksum": a["publishedFrom"] or "none published", "matched": bool(a["published"]),
                            "executables": {e: f"{p} ({kinds.get(e)})" for e, p in bins.items()}})
                print(f"  {t['id']} {version}  {a['name']}  {n / 1e6:.1f} MB  sha256 {sha[:16]}…  "
                      f"{'✓ ' + a['publishedFrom'] if a['published'] else 'pinned (no published checksum)'}")
            tools.append({"id": t["id"], "version": version, "default": t["default"], "description": t["description"],
                          "purpose": t["purpose"], "license": t["license"], "homepage": t["homepage"], "source": t["source"],
                          "release": release, "bytes": size, "installedBytes": installed,
                          "executables": sorted({e for a in out_arts for e in a["bin"]}), "check": t.get("check"), **({"checkCodes": t["checkCodes"]} if "checkCodes" in t else {}),
                          "artifacts": out_arts})
        except Exception as e:
            errors.append(f"{t['id']}: {e}")
            print(f"✗ {t['id']}: {e}", file=sys.stderr)
            prev = next((x for x in old.get("tools", []) if x["id"] == t["id"]), None)
            if prev: tools.append(prev)      # keep the last good entry
    same = [x for x in old.get("tools", [])] == tools
    today = int(time.strftime("%Y%m%d")) * 100
    version = old.get("version", 0) if same else max(today + 1, old.get("version", 0) + 1)
    catalog = {"version": version, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) if not same else old.get("generated"),
               "platform": "macos-arm64", "about": src["about"], "tools": tools}
    with open(CATALOG, "w") as f: json.dump(catalog, f, indent=1, ensure_ascii=False); f.write("\n")
    with open(LOG, "w") as f:
        json.dump({"fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "catalogVersion": version,
                   "artifacts": log, "errors": errors}, f, indent=1, ensure_ascii=False); f.write("\n")
    d = [x for x in tools if x["default"]]
    print(f"catalog v{version}: {len(tools)} tools, default set {len(d)} = {sum(x['bytes'] for x in d) / 1e6:.0f} MB download, "
          f"{sum(x['installedBytes'] for x in d) / 1e6:.0f} MB installed" + (f"; {len(errors)} errors" if errors else ""))
    return 1 if errors else 0


def pack(dest, cache):
    """The default set's artifacts, verified against the catalog, for Resources/native-pack/."""
    catalog = json.load(open(CATALOG))
    os.makedirs(dest, exist_ok=True)
    for t in catalog["tools"]:
        if not t["default"]: continue
        for a in t["artifacts"]:
            path, sha, n = download(a["url"], cache)
            if sha != a["sha256"]:
                print(f"✗ {a['name']}: sha256 {sha} != catalog {a['sha256']}", file=sys.stderr); return 1
            shutil.copyfile(path, os.path.join(dest, a["sha256"] + "-" + a["name"]))
    shutil.copyfile(CATALOG, os.path.join(dest, "native.json"))
    print(f"✓ native pack in {dest}")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    cache = os.path.join(ROOT, "vendor/native-cache")
    if "--cache" in args:
        i = args.index("--cache"); cache = args[i + 1]; del args[i:i + 2]
    os.makedirs(cache, exist_ok=True)
    if args[:1] == ["refresh"]: sys.exit(refresh(cache))
    if args[:1] == ["pack"] and len(args) == 2: sys.exit(pack(os.path.abspath(args[1]), cache))
    print(__doc__); sys.exit(2)
