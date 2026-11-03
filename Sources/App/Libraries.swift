import Foundation

/// Useful JavaScript libraries (charts, 3D, maps, math, audio, ...) installed on this device in
/// the background and removed again by disk usage, so AI-made screens can use them offline and
/// fast — and every screen knows what is installed. The catalog is web/libraries.json
/// (tools/libraries/resolve.py). Installs are local (not iCloud): they can always be downloaded
/// again. Served to views at aiui://app/vendor/<id>/<file>.
final class Libraries {
    struct Installed: Codable {
        var id: String
        var version: String
        var files: [String]      // file names under vendor/<id>/
        var bytes: Int
        var installed: Date
        var lastUsed: Date
        var uses: Int
    }

    let dir: URL
    private var catalog: [[String: Any]] = []
    private var installed: [String: Installed] = [:]
    private var installing = Set<String>()
    private var waiters: [String: [(Bool) -> Void]] = [:]
    private var stateFile: URL { dir.appendingPathComponent("installed.json") }
    /// Libraries discovered on this device in the background, beyond the bundled catalog.
    private var extraFile: URL { dir.appendingPathComponent("catalog-extra.json") }
    private var cursorFile: URL { dir.appendingPathComponent("discover-page.txt") }
    private var discovering = false

    init(dir: URL, catalogFile: URL?) {
        self.dir = dir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let f = catalogFile, let data = try? Data(contentsOf: f),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            catalog = obj["libraries"] as? [[String: Any]] ?? []
        }
        if let data = try? Data(contentsOf: extraFile), let extra = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            let have = Set(catalog.compactMap { $0["id"] as? String })
            catalog += extra.filter { !have.contains($0["id"] as? String ?? "") }
        }
        catalog.removeAll { Self.isJunk("\($0["id"] ?? "") \($0["description"] ?? "")") }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: stateFile), let list = try? dec.decode([Installed].self, from: data) {
            for i in list where FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.folder(i.id)).path) { installed[i.id] = i }
        }
        // Housekeeping: junk that got in earlier, leftovers from interrupted or scoped installs.
        for id in installed.keys where entry(id) == nil { remove(id) }
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix(".") || name.hasPrefix("@") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    private func entry(_ id: String) -> [String: Any]? { catalog.first { $0["id"] as? String == id } }

    /// Not for building screens: analytics, tracking, ads, consent, anti-devtools, fingerprinting,
    /// monitoring and auth SDKs. Kept out of discovery and of the store.
    static let junk = try! NSRegularExpression(pattern: #"analytic|track|metrica|telemetry|consent|onetrust|cookiebot|advert|\bads?\b|adsense|sidecar|statsig|segment|snowplow|permutive|hypelab|devtool|console-ban|fingerprint|thumbmark|rrweb|session-?replay|monitor|beacon|pixel|tag-?manager|gtm|launchdarkly|flagship|feature-?flag|optimizely|hotjar|clarity|sentry|bugsnag|datadog|newrelic|embrace|gumlet|recaptcha|captcha|sdk-analytics|isbot|bot-?detect|antibot|clerk|auth0|firebase"#, options: .caseInsensitive)
    static func isJunk(_ text: String) -> Bool {
        junk.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// The folder for a library: scoped names (@scope/name) flattened.
    static func folder(_ id: String) -> String { id.replacingOccurrences(of: "/", with: "__") }

    // MARK: - Disk budget

    /// The storage budget libraries and the memory cache share: 10 GB, but never more than
    /// 10% of the free space above a 5 GB reserve (nothing when the disk is tight).
    static var sharedBudget: Int {
        let free = (try? URL(fileURLWithPath: NSHomeDirectory())
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage ?? 0
        if free < 5_000_000_000 { return 0 }
        return Int(min(Double(free - 5_000_000_000) * 0.10, 10_000_000_000))
    }

    /// What the memory cache currently uses (set by the API), taken out of the shared budget.
    var cacheBytes: () -> Int = { 0 }

    /// Libraries get the shared budget minus what the cache uses.
    var budget: Int { max(0, Self.sharedBudget - cacheBytes()) }

    var used: Int { installed.values.reduce(0) { $0 + $1.bytes } }

    /// Least recently used first, until within budget (libraries used in the last hour stay).
    private func evict(toFit extra: Int = 0) {
        let limit = budget
        var total = used
        for i in installed.values.sorted(by: { $0.lastUsed < $1.lastUsed }) where total + extra > limit {
            if i.lastUsed > Date().addingTimeInterval(-3600) { continue }
            remove(i.id)
            total -= i.bytes
        }
    }

    // MARK: - Background maintenance

    /// Installs the most useful libraries (catalog priority, then this user's use) while they fit
    /// in 80% of the budget, one at a time; evicts first if the disk got tighter.
    private var lastDiscovery = Date.distantPast

    func maintain() {
        // Growing the catalog is a network walk: every 6 hours, not on every maintenance pass.
        if lastDiscovery < Date().addingTimeInterval(-6 * 3600) { lastDiscovery = Date(); discoverMore() }
        evict()
        let room = Int(Double(budget) * 0.8) - used
        guard room > 0, installing.isEmpty else { return }
        let next = catalog
            .filter { installed[$0["id"] as? String ?? ""] == nil }
            .sorted { ($0["priority"] as? Int ?? 0) > ($1["priority"] as? Int ?? 0) }
            .first { ($0["bytes"] as? Int ?? .max) <= room }
        guard let id = next?["id"] as? String else { return }
        install(id) { [weak self] ok in if ok { self?.maintain() } }   // keep going while there is room
    }

    // MARK: - Growing the catalog in the background

    /// Walks further down jsDelivr's most-used npm packages (3 pages of 100 per round, resuming
    /// where the bundled catalog — the top 8,000 — stops) and keeps those with a plain browser
    /// bundle; they join the catalog and become installable.
    func discoverMore(pages: Int = 3) {
        guard !discovering else { return }
        discovering = true
        let start = Int((try? String(contentsOf: cursorFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 81
        let known = Set(catalog.compactMap { $0["id"] as? String })
        Task {
            var found: [[String: Any]] = []
            var page = start
            for p in start..<(start + pages) {
                guard let url = URL(string: "https://data.jsdelivr.com/v1/stats/packages?period=month&type=npm&limit=100&page=\(p)"),
                      let (data, _) = try? await URLSession.shared.data(from: url),
                      let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], !list.isEmpty else { break }
                let names = list.compactMap { $0["name"] as? String }.filter { !known.contains($0) }
                await withTaskGroup(of: [String: Any]?.self) { group in
                    for (i, name) in names.enumerated() {
                        let rank = (p - 1) * 100 + i
                        group.addTask { await Self.examine(name, rank: rank) }
                    }
                    for await r in group { if let r { found.append(r) } }
                }
                page = p + 1
            }
            let (more, next) = (found, page)
            await MainActor.run {
                self.discovering = false
                try? String(next).write(to: self.cursorFile, atomically: true, encoding: .utf8)
                guard !more.isEmpty else { return }
                self.catalog += more
                var extra = (try? JSONSerialization.jsonObject(with: Data(contentsOf: self.extraFile))) as? [[String: Any]] ?? []
                extra += more
                if let data = try? JSONSerialization.data(withJSONObject: extra) { try? data.write(to: self.extraFile, options: .atomic) }
                self.maintain()
            }
        }
    }

    /// A package qualifies when package.json names a plain .js browser bundle (jsdelivr/unpkg/browser).
    private static func examine(_ name: String, rank: Int) async -> [String: Any]? {
        if isJunk(name) { return nil }
        guard let pj = URL(string: "https://cdn.jsdelivr.net/npm/\(name)/package.json"),
              let (data, _) = try? await URLSession.shared.data(from: pj),
              let pkg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = pkg["version"] as? String else { return nil }
        let entry = (pkg["jsdelivr"] as? String) ?? (pkg["unpkg"] as? String) ?? (pkg["browser"] as? String)
        guard var e = entry, e.hasSuffix(".js"), !e.hasSuffix(".mjs"), !e.hasSuffix(".cjs"), !e.hasSuffix(".esm.js") else { return nil }
        while e.hasPrefix("./") || e.hasPrefix("/") { e.removeFirst(e.hasPrefix("./") ? 2 : 1) }
        guard let file = URL(string: "https://cdn.jsdelivr.net/npm/\(name)@\(version)/\(e)") else { return nil }
        var req = URLRequest(url: file, timeoutInterval: 20)
        req.setValue("bytes=0-4095", forHTTPHeaderField: "Range")
        guard let (head, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, [200, 206].contains(http.statusCode) else { return nil }
        let text = String(decoding: head, as: UTF8.self)
        if text.range(of: #"(?m)^\s*(import|export)\s"#, options: .regularExpression) != nil { return nil }
        let size = Int((http.value(forHTTPHeaderField: "Content-Range") ?? "/0").split(separator: "/").last ?? "0") ?? 0
        var global = "(UMD)"
        if let r = text.range(of: #"\.([A-Za-z_$][\w$]{1,40})\s*=\s*factory\("#, options: .regularExpression) {
            global = String(text[r]).components(separatedBy: CharacterSet(charactersIn: ". =")).filter { !$0.isEmpty }.first ?? global
        }
        let desc = String(((pkg["description"] as? String) ?? "").prefix(120))
        if isJunk(desc) { return nil }
        return ["id": name, "package": name, "version": version, "global": global, "category": "npm",
                "description": desc, "priority": max(1, 50 - rank / 60), "bytes": size,
                "files": [["url": file.absoluteString, "name": (e as NSString).lastPathComponent, "type": "js", "bytes": size]]]
    }

    // MARK: - Install / remove

    func install(_ id: String, _ done: @escaping (Bool) -> Void) {
        if installed[id] != nil { return done(true) }
        guard let e = entry(id), let files = e["files"] as? [[String: Any]] else { return done(false) }
        waiters[id, default: []].append(done)
        guard !installing.contains(id) else { return }
        installing.insert(id)
        let target = dir.appendingPathComponent(Self.folder(id), isDirectory: true)
        let tmp = dir.appendingPathComponent(".\(Self.folder(id))-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        Task {
            var names: [String] = [], bytes = 0, ok = true
            for f in files {
                guard let s = f["url"] as? String, let url = URL(string: s), let name = f["name"] as? String else { ok = false; break }
                var req = URLRequest(url: url, timeoutInterval: 60)
                req.setValue("aiui", forHTTPHeaderField: "User-Agent")
                guard let (data, resp) = try? await URLSession.shared.data(for: req),
                      (resp as? HTTPURLResponse)?.statusCode == 200 else { ok = false; break }
                do { try data.write(to: tmp.appendingPathComponent(name)) } catch { ok = false; break }
                names.append(name); bytes += data.count
            }
            let (success, fileNames, total) = (ok, names, bytes)
            await MainActor.run {
                let (ok, names, bytes) = (success, fileNames, total)
                self.installing.remove(id)
                if ok {
                    self.evict(toFit: bytes)
                    try? FileManager.default.removeItem(at: target)
                    try? FileManager.default.moveItem(at: tmp, to: target)
                    let now = Date()
                    self.installed[id] = Installed(id: id, version: e["version"] as? String ?? "", files: names, bytes: bytes,
                                                   installed: now, lastUsed: now, uses: 0)
                    self.persist()
                } else {
                    try? FileManager.default.removeItem(at: tmp)
                }
                for w in self.waiters.removeValue(forKey: id) ?? [] { w(ok) }
            }
        }
    }

    func remove(_ id: String) {
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(Self.folder(id)))
        installed[id] = nil
        persist()
    }

    /// Tags for the libraries a screen declares: local files when installed (installing on
    /// demand first), the CDN otherwise. Counts the use.
    func ensure(_ ids: [String], _ done: @escaping ([[String: String]]) -> Void) {
        // Any npm package not in the catalog loads from jsDelivr's default browser file.
        let unknown = ids.filter { entry($0) == nil && $0.range(of: #"^(@[\w.-]+/)?[\w.-]+$"#, options: .regularExpression) != nil }
        let fallback = unknown.map { ["type": "js", "src": "https://cdn.jsdelivr.net/npm/\($0)"] }
        let wanted = ids.filter { entry($0) != nil }
        guard !wanted.isEmpty else { return done(fallback) }
        let group = DispatchGroup()
        for id in wanted where installed[id] == nil {
            group.enter()
            var finished = false
            install(id) { _ in if !finished { finished = true; group.leave() } }
            // Don't hold a screen for long: after 12 s it gets the CDN copy instead.
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { if !finished { finished = true; group.leave() } }
        }
        group.notify(queue: .main) {
            var tags: [[String: String]] = []
            for id in wanted {
                guard let e = self.entry(id), let files = e["files"] as? [[String: Any]] else { continue }
                if var i = self.installed[id] {
                    i.uses += 1; i.lastUsed = Date(); self.installed[id] = i
                    for f in files {
                        let name = f["name"] as? String ?? ""
                        tags.append(["type": f["type"] as? String ?? "js", "src": "aiui://app/vendor/\(Self.folder(id))/\(name)"])
                    }
                } else {
                    for f in files { tags.append(["type": f["type"] as? String ?? "js", "src": f["url"] as? String ?? ""]) }
                }
            }
            self.persist()
            done(tags + fallback)
        }
    }

    // MARK: - What the AI and the user see

    /// What the AI gets (the full catalog is far too big): the installed libraries most relevant
    /// to `words` (then most used and highest priority), relevant ones it could install, and totals.
    func overview(_ words: [String] = []) -> [String: Any] {
        let ws = Set(words.flatMap { $0.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) }.map(String.init).filter { $0.count > 2 })
        func score(_ e: [String: Any]) -> Double {
            let hay = "\(e["id"] ?? "") \(e["description"] ?? "") \(e["category"] ?? "")".lowercased()
            let hits = ws.reduce(0) { $0 + (hay.contains($1) ? 1 : 0) }
            let id = e["id"] as? String ?? ""
            return Double(hits) * 100 + Double(installed[id]?.uses ?? 0) * 5 + Double(e["priority"] as? Int ?? 0)
        }
        let inst = catalog.filter { installed[$0["id"] as? String ?? ""] != nil }.sorted { score($0) > score($1) }
        let avail = catalog.filter { installed[$0["id"] as? String ?? ""] == nil }.sorted { score($0) > score($1) }
        var cats: [String: Int] = [:]
        for e in inst { cats[e["category"] as? String ?? "other", default: 0] += 1 }
        return ["installed": inst.prefix(30).map(Self.line), "installable": avail.prefix(15).map(Self.line),
                "totals": ["installed": inst.count, "catalog": catalog.count, "byCategory": cats],
                "note": "any npm package name also works in libs (loaded from jsDelivr)"]
    }

    private static func line(_ e: [String: Any]) -> String {
        let g = (e["global"] as? String).map { $0.isEmpty ? "CSS" : $0 } ?? ""
        return "\(e["id"] ?? "") \(e["version"] ?? "") (\(g)) — \(e["description"] ?? "")"
    }

    func list() -> [String: Any] {
        let rows: [[String: Any]] = catalog.map { e in
            let id = e["id"] as? String ?? ""
            var r: [String: Any] = ["id": id, "description": e["description"] ?? "", "category": e["category"] ?? "",
                                    "bytes": e["bytes"] ?? 0, "installed": installed[id] != nil]
            if let i = installed[id] { r["uses"] = i.uses; r["lastUsed"] = ISO8601DateFormatter().string(from: i.lastUsed) }
            return r
        }
        return ["libraries": rows, "used": used, "budget": budget, "installing": Array(installing)]
    }

    func filePath(_ path: String) -> URL? {
        let url = dir.appendingPathComponent(path).standardizedFileURL
        return url.path.hasPrefix(dir.standardizedFileURL.path + "/") ? url : nil
    }

    private func persist() {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(Array(installed.values)) { try? data.write(to: stateFile, options: .atomic) }
    }
}
