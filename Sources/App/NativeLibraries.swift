#if os(macOS)
import Foundation
import CryptoKit
import Network

/// Native command-line tools (ffmpeg, yt-dlp, pandoc, jq, ...) for the AI and AI-written scenes,
/// installed on this Mac and put on the PATH of every shell the app runs (Shell.loginEnvironment).
/// The JS library store's counterpart (Libraries.swift). The catalog is web/native.json
/// (tools/native/catalog.py): per tool its version, artifacts with pinned SHA-256 and the
/// executables they provide; a newer catalog is fetched from aiui.oeaio.com now and then.
///
/// Layout (Application Support/aiui/native):
///   <id>/<version>/payload/…   the unpacked artifacts
///   <id>/<version>/bin/<exe>   links into payload
///   <id>/current → <version>   swapped atomically; the version before stays for rollback
///   bin/<exe> → ../<id>/current/bin/<exe>   the one folder on the PATH (+ aiui-native)
///
/// Every artifact is hash-checked before it is unpacked; quarantine is removed only after that,
/// and a tool goes live only when its own check command (e.g. --version) runs. The default set
/// installs in the background — from a pack bundled with the app first (offline), then by
/// download, but only while policy allows it (`policy`).
final class NativeLibraries {
    static let shared = NativeLibraries()

    /// The folder on the PATH (stable, so the shell environment can be computed once).
    static let binDir: URL = root.appendingPathComponent("bin", isDirectory: true)
    static let root: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("aiui/native", isDirectory: true)
    static let liveCatalogURL = URL(string: ProcessInfo.processInfo.environment["AIUI_NATIVE_CATALOG"] ?? "https://aiui.oeaio.com/native.json")!

    struct Installed: Codable {
        var id: String
        var version: String
        var previous: String?
        var executables: [String]
        var bytes: Int
        var isDefault: Bool
        var installed: Date
        var lastUsed: Date
        var uses: Int
        var fromPack: Bool?
    }

    let dir: URL
    /// Where the bundled catalog and pack are (overridable for tests).
    var bundledCatalog: URL? = API.webRoot?.appendingPathComponent("native.json")
        ?? Bundle.main.resourceURL?.appendingPathComponent("web/native.json")
    var packDir: URL? = Bundle.main.resourceURL?.appendingPathComponent("native-pack", isDirectory: true)
    /// What else uses the shared disk budget (memory cache + JS libraries), set by the API.
    var otherBytes: () -> Int = { 0 }

    private(set) var catalog: [String: Any] = [:]
    private var installed: [String: Installed] = [:]
    private var installing: [String: Job] = [:]
    private var waiters: [String: [(String?) -> Void]] = [:]
    private(set) var errors: [String: String] = [:]
    /// Failed tools are retried by background maintenance after a while (or with a new catalog).
    private var errorAt: [String: Date] = [:]
    private func failedRecently(_ id: String) -> Bool { (errorAt[id] ?? .distantPast) > Date().addingTimeInterval(-3 * 3600) }
    private(set) var lastBlocked: String?
    private(set) var lastUpdateCheck: Date?
    private var maintaining = false
    private let work = DispatchQueue(label: "aiui.native", qos: .utility)
    private var path: NWPath?
    private let monitor = NWPathMonitor()
    private var requestWatch: DispatchSourceFileSystemObject?
    private var stateFile: URL { dir.appendingPathComponent("installed.json") }
    private var liveCatalogFile: URL { dir.appendingPathComponent("catalog.json") }
    private var requestsDir: URL { dir.appendingPathComponent("requests", isDirectory: true) }

    private final class Job {
        var cancelled = false
        var task: URLSessionDownloadTask?
        var timer: Timer?
    }

    init(dir: URL = NativeLibraries.root) {
        self.dir = dir
        let fm = FileManager.default
        try? fm.createDirectory(at: dir.appendingPathComponent("bin"), withIntermediateDirectories: true)
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: stateFile), let list = try? dec.decode([Installed].self, from: data) {
            for i in list where fm.fileExists(atPath: versionDir(i.id, i.version).appendingPathComponent("bin").path) { installed[i.id] = i }
        }
        // Leftovers from interrupted installs.
        for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix(".") {
            try? fm.removeItem(at: dir.appendingPathComponent(name))
        }
        monitor.pathUpdateHandler = { [weak self] p in DispatchQueue.main.async { self?.path = p } }
        monitor.start(queue: DispatchQueue(label: "aiui.native.net"))
    }

    /// Loads the catalog, links what is installed, writes `aiui-native`, and starts background
    /// maintenance (soon after launch, then every 6 hours).
    func start(after delay: TimeInterval = 15) {
        loadCatalog()
        for i in installed.values { linkGlobal(i.id) }
        writeHelper()
        watchRequests()
        persist()
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.maintain() }
        Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.maintain() }
    }

    // MARK: - Catalog

    func loadCatalog() {
        let bundled = bundledCatalog.flatMap { Self.readCatalog($0) } ?? [:]
        let live = Self.readCatalog(liveCatalogFile) ?? [:]
        catalog = (live["version"] as? Int ?? 0) > (bundled["version"] as? Int ?? 0) ? live : bundled
    }

    static func readCatalog(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url), let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              valid(obj) else { return nil }
        return obj
    }

    /// A catalog is usable when it is for this platform and every artifact is pinned.
    static func valid(_ c: [String: Any]) -> Bool {
        guard c["version"] is Int, (c["platform"] as? String) == "macos-arm64", let tools = c["tools"] as? [[String: Any]] else { return false }
        return tools.allSatisfy { t in
            guard let id = t["id"] as? String, safeID(id), t["version"] is String,
                  let arts = t["artifacts"] as? [[String: Any]], !arts.isEmpty else { return false }
            return arts.allSatisfy { a in
                (a["sha256"] as? String)?.count == 64 && (a["url"] as? String)?.hasPrefix("https://") == true
                    && (a["bin"] as? [String: String]).map { b in b.keys.allSatisfy(safeID) && b.values.allSatisfy(safeRel) } == true
            }
        }
    }

    static func safeID(_ s: String) -> Bool { s.range(of: #"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$"#, options: .regularExpression) != nil }
    static func safeRel(_ s: String) -> Bool { !s.hasPrefix("/") && !s.split(separator: "/").contains("..") && !s.isEmpty }

    var tools: [[String: Any]] { catalog["tools"] as? [[String: Any]] ?? [] }
    func entry(_ id: String) -> [String: Any]? { tools.first { $0["id"] as? String == id } }
    private func isDefault(_ e: [String: Any]) -> Bool { (e["default"] as? Bool) == true }

    // MARK: - Policy

    /// Downloads are allowed when: the setting "Download native libraries" is on (default), no
    /// admin policy denies them (managed preference AllowNativeDownloads = false), the network is
    /// neither constrained (Low Data Mode) nor expensive (metered), and — for background work —
    /// background work is not paused. Returns why not, or nil when allowed.
    func blocked(background: Bool) -> String? {
        let d = UserDefaults.standard
        if d.objectIsForced(forKey: "AllowNativeDownloads"), !d.bool(forKey: "AllowNativeDownloads") {
            return "denied by an administrator policy (AllowNativeDownloads)"
        }
        if !Self.settingOn { return "turned off in Settings (Download native libraries)" }
        if let p = path {
            if p.status != .satisfied { return "offline" }
            if p.isConstrained { return "Low Data Mode is on" }
            if p.isExpensive { return "the network is metered" }
        }
        if background && API.paused { return "background work is paused" }
        return nil
    }

    static var settingOn: Bool {
        get { UserDefaults.standard.object(forKey: "nativeDownloads") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "nativeDownloads") }
    }

    func policy() -> [String: Any] {
        let d = UserDefaults.standard
        let managed: Any = d.objectIsForced(forKey: "AllowNativeDownloads") ? d.bool(forKey: "AllowNativeDownloads") : NSNull()
        var net = "unknown"
        if let p = path { net = p.status != .satisfied ? "offline" : p.isConstrained ? "low data mode" : p.isExpensive ? "metered" : "ok" }
        let b = blocked(background: true)
        return ["allowed": b == nil, "reason": b ?? NSNull(), "setting": Self.settingOn, "managed": managed,
                "network": net, "paused": API.paused, "foregroundAllowed": blocked(background: false) == nil,
                "lastBlocked": lastBlocked ?? NSNull()]
    }

    // MARK: - Disk budget (shared with the memory cache and the JS libraries)

    var used: Int { installed.values.reduce(0) { $0 + $1.bytes } }

    var budget: Int {
        let capGB = UserDefaults.standard.double(forKey: "budgetGB")
        let shared = capGB > 0 ? min(Libraries.sharedBudget, Int(capGB * 1_000_000_000)) : Libraries.sharedBudget
        return max(0, shared - otherBytes())
    }

    /// Least recently used non-default tools go first until `extra` more bytes fit.
    @discardableResult
    private func evict(toFit extra: Int = 0, keep: String? = nil) -> Bool {
        noteUse()
        let limit = budget
        var total = used
        for i in installed.values.filter({ !$0.isDefault && $0.id != keep && installing[$0.id] == nil })
            .sorted(by: { $0.lastUsed < $1.lastUsed }) where total + extra > limit {
            if i.lastUsed > Date().addingTimeInterval(-3600) { continue }
            remove(i.id)
            total -= i.bytes
        }
        return total + extra <= limit
    }

    /// Shell use doesn't pass through the app: the executables' access times tell when a tool ran.
    private func noteUse() {
        for (id, var i) in installed {
            let bin = versionDir(id, i.version).appendingPathComponent("bin")
            for exe in i.executables {
                let real = bin.appendingPathComponent(exe).resolvingSymlinksInPath()
                if let t = (try? real.resourceValues(forKeys: [.contentAccessDateKey]))?.contentAccessDate,
                   t > i.lastUsed, t > i.installed.addingTimeInterval(120) { i.lastUsed = t; installed[id] = i }
            }
        }
    }

    // MARK: - Background maintenance

    /// The offline pack first, then (when policy allows) the update check and the default set,
    /// one tool at a time; then eviction.
    func maintain(force: Bool = false, _ done: (() -> Void)? = nil) {
        guard !maintaining else { done?(); return }
        maintaining = true
        let finish = { [weak self] in self?.maintaining = false; self?.evict(); self?.persist(); done?() }
        installFromPack { [weak self] in
            guard let self else { return }
            if let reason = self.blocked(background: !force) {
                self.lastBlocked = reason
                return finish()
            }
            self.lastBlocked = nil
            self.checkForUpdate { [weak self] in
                guard let self else { return }
                // Default tools not installed or out of date, then installed extras with a new version.
                let due = self.tools.filter { e in
                    let id = e["id"] as? String ?? ""
                    let v = e["version"] as? String ?? ""
                    if let i = self.installed[id] { return i.version != v }
                    return self.isDefault(e) && !self.failedRecently(id)
                }.compactMap { $0["id"] as? String }
                self.installSequentially(due, background: !force, finish)
            }
        }
    }

    private func installSequentially(_ ids: [String], background: Bool, _ done: @escaping () -> Void) {
        guard let id = ids.first else { return done() }
        if let reason = blocked(background: background) { lastBlocked = reason; return done() }
        install(id, background: background) { [weak self] _ in
            self?.installSequentially(Array(ids.dropFirst()), background: background, done)
        }
    }

    /// Default tools whose every artifact is in the bundled pack: installed without the network.
    private func installFromPack(_ done: @escaping () -> Void) {
        guard let pack = packDir, FileManager.default.fileExists(atPath: pack.path) else { return done() }
        let ids = tools.filter { e in
            let id = e["id"] as? String ?? ""
            guard isDefault(e), installed[id]?.version != e["version"] as? String, !failedRecently(id) else { return false }
            return (e["artifacts"] as? [[String: Any]] ?? []).allSatisfy { packFile($0) != nil }
        }.compactMap { $0["id"] as? String }
        func next(_ rest: ArraySlice<String>) {
            guard let id = rest.first else { return done() }
            install(id, background: true, packOnly: true) { _ in next(rest.dropFirst()) }
        }
        next(ids[...])
    }

    private func packFile(_ a: [String: Any]) -> URL? {
        guard let pack = packDir, let sha = a["sha256"] as? String, let name = a["name"] as? String else { return nil }
        let f = pack.appendingPathComponent("\(sha)-\(name)")
        return FileManager.default.fileExists(atPath: f.path) ? f : nil
    }

    /// Fetches the live catalog; a valid one with a higher version replaces the current one.
    func checkForUpdate(_ done: @escaping () -> Void) {
        if let last = lastUpdateCheck, last > Date().addingTimeInterval(-3600) { return done() }
        lastUpdateCheck = Date()
        var req = URLRequest(url: Self.liveCatalogURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        req.setValue("aiui", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                defer { done() }
                let okStatus = (resp as? HTTPURLResponse).map { $0.statusCode == 200 } ?? (resp != nil)
                guard okStatus, let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], Self.valid(obj),
                      (obj["version"] as? Int ?? 0) > (self.catalog["version"] as? Int ?? 0) else { return }
                try? data.write(to: self.liveCatalogFile, options: .atomic)
                self.catalog = obj
                self.errors.removeAll(); self.errorAt.removeAll()     // a new catalog: earlier failures may be fixed
            }
        }.resume()
    }

    // MARK: - Install

    /// Installs (or updates) a tool. `background`: subject to pause. `packOnly`: from the bundled
    /// pack, no network. Calls back with nil on success or the reason it failed.
    func install(_ id: String, background: Bool = false, packOnly: Bool = false, _ done: @escaping (String?) -> Void) {
        guard let e = entry(id), let version = e["version"] as? String,
              let arts = e["artifacts"] as? [[String: Any]] else { return done("\(id) is not in the native catalog") }
        if installed[id]?.version == version { return done(nil) }
        let needsNetwork = !arts.allSatisfy { packFile($0) != nil }
        if needsNetwork {
            if packOnly { return done("not in the pack") }
            if let reason = blocked(background: background) { lastBlocked = reason; return done("downloads blocked: \(reason)") }
        }
        let size = (e["installedBytes"] as? Int ?? 0) + (e["bytes"] as? Int ?? 0)
        // Room: extras evict least recently used extras; the default set and requested tools only
        // need the disk not to be tight (the shared budget is zero below 5 GB free).
        if !evict(toFit: size, keep: id) && (Libraries.sharedBudget == 0 || (background && !isDefault(e))) {
            return done("no room in the disk budget")
        }
        waiters[id, default: []].append(done)
        guard installing[id] == nil else { return }
        let job = Job()
        installing[id] = job
        let total = arts.reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) }
        let title = "\(needsNetwork ? "downloading" : "installing") \(id) \(version)"
        API.activity("native-" + id, title, kind: "native", name: id, detail: Self.mb(total), actions: ["cancel"])
        let staging = dir.appendingPathComponent(".staging-\(id)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: staging.appendingPathComponent("payload"), withIntermediateDirectories: true)

        // 1. Each artifact: from the pack or downloaded, then hash-checked and unpacked.
        func fetch(_ i: Int) {
            if job.cancelled { return finish("cancelled") }
            guard i < arts.count else { return activate() }
            let a = arts[i]
            let name = a["name"] as? String ?? "file", sha = a["sha256"] as? String ?? ""
            let unpack: (URL, Bool) -> Void = { file, temporary in
                self.work.async {
                    let err = Self.verifyAndUnpack(file, sha256: sha, artifact: a, into: staging.appendingPathComponent("payload"))
                    if temporary { try? FileManager.default.removeItem(at: file) }
                    DispatchQueue.main.async { if let err { finish(err) } else { fetch(i + 1) } }
                }
            }
            if let p = packFile(a) { return unpack(p, false) }
            guard let s = a["url"] as? String, let url = URL(string: s) else { return finish("bad url for \(name)") }
            var req = URLRequest(url: url, timeoutInterval: 120)
            req.setValue("aiui", forHTTPHeaderField: "User-Agent")
            let task = URLSession.shared.downloadTask(with: req) { tmp, resp, error in
                // The temporary file goes away when this returns: keep it.
                var kept: URL?
                if let tmp, error == nil, ((resp as? HTTPURLResponse)?.statusCode ?? 200) == 200 {
                    let dest = staging.appendingPathComponent("dl-\(i)")
                    if (try? FileManager.default.moveItem(at: tmp, to: dest)) != nil { kept = dest }
                }
                DispatchQueue.main.async {
                    job.timer?.invalidate()
                    if job.cancelled { return finish("cancelled") }
                    guard let kept else {
                        return finish("download failed for \(name): \(error?.localizedDescription ?? "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)")")
                    }
                    unpack(kept, true)
                }
            }
            job.task = task
            let before = arts.prefix(i).reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) }
            job.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                let got = before + Int(task.countOfBytesReceived)
                API.activity("native-" + id, title, kind: "native", name: id, detail: "\(Self.mb(got)) / \(Self.mb(total))", actions: ["cancel"])
            }
            task.resume()
        }

        // 2. Links, quarantine, the tool's own check; then the atomic swap.
        func activate() {
            let bins = arts.reduce(into: [String: String]()) { r, a in
                for (exe, rel) in a["bin"] as? [String: String] ?? [:] {
                    r[exe] = (a["format"] as? String) == "file" ? (a["name"] as? String ?? rel) : rel
                }
            }
            let check = e["check"] as? [String] ?? []
            let codes = (e["checkCodes"] as? [Int] ?? [0]).map(Int32.init)
            work.async {
                let err = Self.finishStaging(staging, bins: bins, check: check, codes: codes)
                let bytes = Self.size(of: staging)
                DispatchQueue.main.async {
                    if job.cancelled { return finish("cancelled") }
                    if let err { return finish(err) }
                    let target = self.versionDir(id, version)
                    let fm = FileManager.default
                    try? fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? fm.removeItem(at: target)
                    do { try fm.moveItem(at: staging, to: target) } catch { return finish("could not move into place: \(error.localizedDescription)") }
                    let prev = self.installed[id]?.version ?? self.currentVersion(id)
                    guard self.swapCurrent(id, to: version) else { return finish("could not switch to \(version)") }
                    let now = Date()
                    let old = self.installed[id]
                    self.installed[id] = Installed(id: id, version: version, previous: prev == version ? old?.previous : prev,
                                                   executables: bins.keys.sorted(), bytes: bytes, isDefault: self.isDefault(e),
                                                   installed: now, lastUsed: old?.lastUsed ?? now, uses: old?.uses ?? 0,
                                                   fromPack: !needsNetwork)
                    self.linkGlobal(id)
                    self.prune(id)
                    finish(nil)
                }
            }
        }

        func finish(_ err: String?) {
            job.timer?.invalidate()
            if err != nil { try? FileManager.default.removeItem(at: staging) }
            installing[id] = nil
            errors[id] = err
            errorAt[id] = err == nil || err == "cancelled" ? nil : Date()
            API.activity("native-" + id, nil)
            persist()
            for w in waiters.removeValue(forKey: id) ?? [] { w(err) }
        }
        fetch(0)
    }

    func cancel(_ id: String) {
        guard let job = installing[id] else { return }
        job.cancelled = true
        job.task?.cancel()
    }

    /// SHA-256 first; only a matching file is unpacked (zip: ditto, tar: bsdtar, file: copied).
    static func verifyAndUnpack(_ file: URL, sha256 expected: String, artifact a: [String: Any], into payload: URL) -> String? {
        let name = a["name"] as? String ?? "file"
        guard let got = sha256(of: file) else { return "cannot read \(name)" }
        guard got == expected.lowercased() else { return "SHA-256 mismatch for \(name): expected \(expected), got \(got) — refused" }
        let format = a["format"] as? String ?? "file"
        switch format {
        case "file":
            let dest = payload.appendingPathComponent(name)
            do { try FileManager.default.copyItem(at: file, to: dest) } catch { return "cannot place \(name)" }
            chmod(dest.path, 0o755)
        case "zip":
            let r = run("/usr/bin/ditto", ["-x", "-k", file.path, payload.path], timeout: 300)
            if r.code != 0 { return "cannot unpack \(name): \(r.out.prefix(300))" }
        default:
            let r = run("/usr/bin/tar", ["-xf", file.path, "-C", payload.path], timeout: 300)
            if r.code != 0 { return "cannot unpack \(name): \(r.out.prefix(300))" }
        }
        return nil
    }

    /// Checks nothing points outside the staging folder, links bin/, clears quarantine (the
    /// files are verified by now) and runs the tool's check command.
    static func finishStaging(_ staging: URL, bins: [String: String], check: [String], codes: [Int32] = [0]) -> String? {
        let fm = FileManager.default
        let base = staging.resolvingSymlinksInPath().path + "/"
        if let en = fm.enumerator(at: staging, includingPropertiesForKeys: [.isSymbolicLinkKey]) {
            for case let f as URL in en where (try? f.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink == true {
                let target = f.resolvingSymlinksInPath().path
                if !target.hasPrefix(base) { return "unpacked link points outside: \(f.lastPathComponent)" }
            }
        }
        let bin = staging.appendingPathComponent("bin", isDirectory: true)
        try? fm.createDirectory(at: bin, withIntermediateDirectories: true)
        for (exe, rel) in bins {
            guard safeID(exe), safeRel(rel) else { return "bad executable path \(rel)" }
            let real = staging.appendingPathComponent("payload").appendingPathComponent(rel)
            guard fm.isExecutableFile(atPath: real.path) else { return "\(exe) missing from the package (\(rel))" }
            do { try fm.createSymbolicLink(atPath: bin.appendingPathComponent(exe).path, withDestinationPath: "../payload/" + rel) }
            catch { return "cannot link \(exe)" }
        }
        _ = run("/usr/bin/xattr", ["-r", "-d", "com.apple.quarantine", staging.path], timeout: 60)
        if let exe = check.first {
            let r = run(bin.appendingPathComponent(exe).path, Array(check.dropFirst()), timeout: 60)
            if !codes.contains(r.code) && r.code != 0 { return "\(exe) does not run here (exit \(r.code)): \(r.out.prefix(300))" }
        }
        return nil
    }

    // MARK: - Versions, links, removal

    func versionDir(_ id: String, _ version: String) -> URL {
        dir.appendingPathComponent(id, isDirectory: true).appendingPathComponent(version, isDirectory: true)
    }

    private func currentVersion(_ id: String) -> String? {
        try? FileManager.default.destinationOfSymbolicLink(atPath: dir.appendingPathComponent("\(id)/current").path)
    }

    /// current → version, atomically (a new link renamed over the old one).
    private func swapCurrent(_ id: String, to version: String) -> Bool {
        let cur = dir.appendingPathComponent("\(id)/current").path
        let tmp = dir.appendingPathComponent("\(id)/.current-\(UUID().uuidString)").path
        guard symlink(version, tmp) == 0 else { return false }
        if rename(tmp, cur) != 0 { unlink(tmp); return false }
        return true
    }

    /// The tool's executables in the shared bin/ (a name another tool already has stays theirs).
    /// Each link points straight at the file inside current/payload — one link level, so scripts
    /// that find their own files by reading their link once (exiftool) work — and is replaced by
    /// renaming a new link over it.
    private func linkGlobal(_ id: String) {
        guard let i = installed[id] else { return }
        let fm = FileManager.default
        let versionBin = versionDir(id, i.version).appendingPathComponent("bin")
        for exe in i.executables {
            guard let inner = try? fm.destinationOfSymbolicLink(atPath: versionBin.appendingPathComponent(exe).path),
                  inner.hasPrefix("../payload/") else { continue }
            let link = Self.binDir(dir).appendingPathComponent(exe).path
            let want = "../\(id)/current/" + inner.dropFirst(3)
            if let have = try? fm.destinationOfSymbolicLink(atPath: link) {
                if have == want { continue }
                let owner = have.split(separator: "/").dropFirst().first.map(String.init) ?? ""
                if owner != id, installed[owner] != nil { continue }
            }
            let tmp = Self.binDir(dir).appendingPathComponent(".\(exe)-\(UUID().uuidString)").path
            guard symlink(want, tmp) == 0 else { continue }
            if rename(tmp, link) != 0 { unlink(tmp) }
        }
    }

    private static func binDir(_ dir: URL) -> URL { dir.appendingPathComponent("bin", isDirectory: true) }

    /// Keeps the current and the previous version.
    private func prune(_ id: String) {
        guard let i = installed[id] else { return }
        let folder = dir.appendingPathComponent(id, isDirectory: true)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        where name != "current" && name != i.version && name != i.previous {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    /// Back to the version before the last update, when it is still there.
    func rollback(_ id: String) -> String? {
        guard var i = installed[id], let prev = i.previous,
              FileManager.default.fileExists(atPath: versionDir(id, prev).appendingPathComponent("bin").path) else { return "no earlier version of \(id)" }
        guard swapCurrent(id, to: prev) else { return "could not switch \(id) back" }
        (i.version, i.previous) = (prev, i.version)
        i.bytes = Self.size(of: versionDir(id, prev))
        installed[id] = i
        linkGlobal(id)
        persist()
        return nil
    }

    func remove(_ id: String) {
        guard Self.safeID(id) else { return }
        cancel(id)
        let fm = FileManager.default
        for exe in installed[id]?.executables ?? [] {
            let link = Self.binDir(dir).appendingPathComponent(exe).path
            if (try? fm.destinationOfSymbolicLink(atPath: link))?.hasPrefix("../\(id)/") == true { try? fm.removeItem(atPath: link) }
        }
        try? fm.removeItem(at: dir.appendingPathComponent(id, isDirectory: true))
        installed[id] = nil
        persist()
    }

    // MARK: - Requests (scenes via aiui.sys / the native endpoint, the AI via aiui-native)

    /// ops: list | status | ensure {ids} | remove {id} | update | rollback {id} | setting {on} | cancel {id}
    func handle(_ input: [String: Any], send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        let op = (input["op"] as? String) ?? (input["action"] as? String) ?? "list"
        let id = (input["id"] as? String) ?? (input["ids"] as? [String])?.first ?? ""
        switch op {
        case "ensure":
            var ids = input["ids"] as? [String] ?? []
            if ids.isEmpty, !id.isEmpty { ids = [id] }
            ensure(ids, wait: (input["wait"] as? Double) ?? 45, send)
        case "remove":
            remove(id); send(status())
        case "rollback":
            if let err = rollback(id) { return fail(err) }
            send(status())
        case "cancel":
            cancel(id); send(status())
        case "update":
            lastUpdateCheck = nil
            maintain(force: true) { [weak self] in send(self?.status() ?? [:]) }
        case "setting":
            Self.settingOn = (input["on"] as? Bool) ?? Self.settingOn
            if Self.settingOn { maintain() }
            send(status())
        default:
            send(status())
        }
    }

    /// Installs what is missing (when policy allows) and answers once all are ready or after
    /// `wait` seconds, with each tool's state.
    func ensure(_ ids: [String], wait: Double, _ send: @escaping ([String: Any]) -> Void) {
        var failed: [String: String] = [:]
        let group = DispatchGroup()
        for id in ids {
            guard entry(id) != nil else { failed[id] = "not in the native catalog"; continue }
            if var i = installed[id] { i.uses += 1; i.lastUsed = Date(); installed[id] = i; continue }
            group.enter()
            var left = false
            install(id) { err in
                if let err { failed[id] = err }
                if !left { left = true; group.leave() }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { if !left { left = true; group.leave() } }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.persist()
            let ready = ids.filter { self.installed[$0] != nil }
            let pending = ids.filter { self.installing[$0] != nil }
            var r: [String: Any] = ["ready": ready, "pending": pending, "failed": failed, "path": Self.binDir(self.dir).path]
            r["executables"] = ready.flatMap { self.installed[$0]?.executables ?? [] }
            if let b = self.blocked(background: false) { r["downloads"] = "blocked: \(b)" }
            send(r)
        }
    }

    /// Answers `aiui-native` (bin/aiui-native): request files dropped in requests/.
    private func watchRequests() {
        let fm = FileManager.default
        try? fm.createDirectory(at: requestsDir, withIntermediateDirectories: true)
        let fd = open(requestsDir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
        src.setEventHandler { [weak self] in self?.takeRequests() }
        src.setCancelHandler { close(fd) }
        src.resume()
        requestWatch = src
        takeRequests()
    }

    private func takeRequests() {
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: requestsDir.path)) ?? [] where name.hasSuffix(".json") {
            let file = requestsDir.appendingPathComponent(name)
            let base = String(name.dropLast(5))
            guard Self.safeID(base), let data = try? Data(contentsOf: file) else { continue }
            try? fm.removeItem(at: file)
            let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            let out = requestsDir.appendingPathComponent(base + ".out")
            let write: ([String: Any]) -> Void = { obj in
                let d = (try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])) ?? Data("{}".utf8)
                try? d.write(to: out, options: .atomic)
            }
            handle(input, send: write, fail: { write(["error": $0]) })
        }
    }

    /// bin/aiui-native: the AI's way to ask for a tool from its shell.
    private func writeHelper() {
        let script = """
        #!/bin/sh
        # aiui-native — asks the AI UI app for native tools (installed into this folder, on the PATH).
        #   aiui-native list | ensure ID... | remove ID | update | rollback ID
        dir="$(cd "$(dirname "$0")/../requests" 2>/dev/null && pwd)" || { echo '{"error":"AI UI native store not found"}'; exit 1; }
        op="${1:-list}"; [ $# -gt 0 ] && shift
        ids=""; for a in "$@"; do case "$a" in *[!A-Za-z0-9._+-]*) ;; *) ids="$ids${ids:+,}\\"$a\\"";; esac; done
        req="r$$-$(date +%s)"
        printf '{"op":"%s","ids":[%s]}' "$op" "$ids" > "$dir/.$req" && mv "$dir/.$req" "$dir/$req.json"
        i=0
        while [ ! -f "$dir/$req.out" ]; do
          sleep 0.5; i=$((i+1))
          if [ $i -gt 360 ]; then rm -f "$dir/$req.json"; echo '{"error":"AI UI did not answer (is the app running?)"}'; exit 1; fi
        done
        out="$(cat "$dir/$req.out")"; rm -f "$dir/$req.out"
        printf '%s\n' "$out"
        case "$out" in *'"error"'*) exit 1;; esac
        """
        let f = Self.binDir(dir).appendingPathComponent("aiui-native")
        try? script.write(to: f, atomically: true, encoding: .utf8)
        chmod(f.path, 0o755)
    }

    // MARK: - What the AI and the user see

    /// For events: what is installed (on the PATH of every shell), what could be, and how to ask.
    func overview() -> [String: Any] {
        func line(_ e: [String: Any]) -> String {
            let exes = (e["executables"] as? [String] ?? []).joined(separator: ", ")
            return "\(e["id"] ?? "") \(e["version"] ?? "") [\(exes)] — \(e["description"] ?? ""); for \(e["purpose"] ?? "")"
        }
        let inst = tools.filter { installed[$0["id"] as? String ?? ""] != nil }
        let avail = tools.filter { installed[$0["id"] as? String ?? ""] == nil }
        var out: [String: Any] = [
            "installed": inst.map { e -> String in
                let id = e["id"] as? String ?? ""
                return installed[id]?.version == e["version"] as? String ? line(e) : line(e) + " (installed: \(installed[id]?.version ?? ""))"
            },
            "installable": avail.map { line($0) + " · \(Self.mb(($0["bytes"] as? Int) ?? 0)) download" },
            "how": "Installed tools are on the PATH of every shell the app runs, after the user's own (\(Self.binDir(dir).path), " +
                "also $AIUI_NATIVE_BIN); call them by name, or as \"$AIUI_NATIVE_BIN/<exe>\" for exactly the listed version. " +
                "To get an installable one: from your shell `aiui-native ensure <id>` (waits, prints JSON with ready/failed); " +
                "from a scene `aiui.sys({op:'native', action:'ensure', ids:['<id>']})`. macOS itself has sqlite3, curl, " +
                "sips (images), textutil (doc/rtf/html), afconvert/afinfo (audio), mdfind/mdls, plutil, shortcuts.",
        ]
        if !installing.isEmpty { out["installing"] = Array(installing.keys) }
        if let b = blocked(background: false) { out["downloads"] = "blocked: \(b) — say so if a needed tool is missing" }
        return out
    }

    func status() -> [String: Any] {
        noteUse()
        let iso = ISO8601DateFormatter()
        let rows: [[String: Any]] = tools.map { e in
            let id = e["id"] as? String ?? ""
            var r: [String: Any] = ["id": id, "version": e["version"] ?? "", "description": e["description"] ?? "",
                                    "purpose": e["purpose"] ?? "", "license": e["license"] ?? "", "homepage": e["homepage"] ?? "",
                                    "source": e["source"] ?? "", "executables": e["executables"] ?? [], "default": isDefault(e),
                                    "bytes": e["bytes"] ?? 0, "installed": installed[id] != nil, "installing": installing[id] != nil]
            if let i = installed[id] {
                r["installedVersion"] = i.version; r["previous"] = i.previous ?? NSNull(); r["diskBytes"] = i.bytes
                r["uses"] = i.uses; r["lastUsed"] = iso.string(from: i.lastUsed); r["fromPack"] = i.fromPack ?? false
            }
            if let err = errors[id] { r["error"] = err }
            return r
        }
        return ["tools": rows, "catalogVersion": catalog["version"] ?? 0, "used": used, "budget": budget,
                "policy": policy(), "path": Self.binDir(dir).path, "folder": dir.path,
                "installing": Array(installing.keys), "lastUpdateCheck": lastUpdateCheck.map { iso.string(from: $0) } ?? NSNull(),
                "pack": packDir.map { FileManager.default.fileExists(atPath: $0.path) } ?? false]
    }

    private func persist() {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601; enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(installed.values.sorted { $0.id < $1.id }) { try? data.write(to: stateFile, options: .atomic) }
    }

    // MARK: - Helpers

    static func mb(_ n: Int) -> String { n >= 1_000_000 ? String(format: "%.0f MB", Double(n) / 1e6) : "\(max(1, n / 1000)) KB" }

    static func sha256(of url: URL) -> String? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try? h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func size(of url: URL) -> Int {
        var total = 0
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .isRegularFileKey]
        if let en = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) {
            for case let f as URL in en {
                if let v = try? f.resourceValues(forKeys: Set(keys)), v.isRegularFile == true { total += v.totalFileAllocatedSize ?? 0 }
            }
        }
        return total
    }

    /// Runs a helper with a time limit; stdout and stderr together.
    static func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> (code: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(), "LANG": "en_US.UTF-8"]
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return (-1, "\(error.localizedDescription)") }
        var data = Data()
        let reader = DispatchQueue.global()
        let g = DispatchGroup()
        g.enter(); reader.async { data = pipe.fileHandleForReading.readDataToEndOfFile(); g.leave() }
        if g.wait(timeout: .now() + timeout) == .timedOut { p.terminate(); _ = g.wait(timeout: .now() + 2); return (-2, "timed out") }
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
#endif
