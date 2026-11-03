import Foundation

/// How the user uses each AI scene (opens, time, interactions, quality findings, a live
/// screenshot) and when it is due for its next background improvement. The first improvement
/// starts right when the user starts using a scene; each next one when the time since that first
/// use has doubled since the previous improvement (e.g. 3 min → 6 → 12 → 24 …; at least 5 min,
/// at most a week apart) — and only for scenes used since their last improvement.
/// Usage syncs through Storage; screenshots stay on this device.
final class Usage {
    struct Scene: Codable {
        var key: String
        var title: String
        var opens: Int
        var dwellMs: Double
        var interactions: Int
        var lastUsed: Date
        var firstUsed: Date?
        var usedSinceImprove: Int
        var improves: Int
        var lastImproved: Date?
        var nextImprove: Date?
        var findings: [String]
        /// A near-duplicate merged into another scene: opening it returns to that one.
        var mergedInto: String?
    }

    private let file: URL
    let shots: URL
    private var scenes: [String: Scene] = [:]
    static let minGap: TimeInterval = 300, cap: TimeInterval = 7 * 86_400

    init(dir: URL, shots: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("usage.json")
        self.shots = shots
        mergeDisk()
    }

    func reload() { mergeDisk() }

    func shot(_ key: String) -> URL { shots.appendingPathComponent("\(key).jpg") }

    /// A report from the page: an open, time spent, interactions, findings, maybe a screenshot.
    func record(_ r: [String: Any]) {
        guard let key = r["key"] as? String, !key.isEmpty else { return }
        let now = Date()
        var s = scenes[key] ?? Scene(key: key, title: "", opens: 0, dwellMs: 0, interactions: 0, lastUsed: now, firstUsed: now,
                                     usedSinceImprove: 0, improves: 0, lastImproved: nil, nextImprove: nil, findings: [], mergedInto: nil)
        if let t = r["title"] as? String, !t.isEmpty { s.title = t }
        if (r["opened"] as? Bool) == true { s.opens += 1; s.usedSinceImprove += 1 }
        s.dwellMs += r["dwellMs"] as? Double ?? 0
        s.interactions += r["interactions"] as? Int ?? 0
        if let f = r["findings"] as? [String], !f.isEmpty { s.findings = Array(f.prefix(20)) }
        s.lastUsed = now
        // The first improvement starts right away, on first use.
        if s.firstUsed == nil { s.firstUsed = now }
        if s.nextImprove == nil { s.nextImprove = now }
        scenes[key] = s
        if let b64 = r["screenshot"] as? String, let comma = b64.firstIndex(of: ","),
           let data = Data(base64Encoded: String(b64[b64.index(after: comma)...])) {
            try? data.write(to: shot(key), options: .atomic)
        }
        persist()
    }

    /// The scene most due for improvement (used since its last one), if any.
    func due() -> Scene? {
        let now = Date()
        return scenes.values.filter { $0.mergedInto == nil && $0.usedSinceImprove > 0 && ($0.nextImprove ?? .distantFuture) <= now }
            .max { Double($0.opens) * 1000 + $0.dwellMs / 1000 < Double($1.opens) * 1000 + $1.dwellMs / 1000 }
    }

    /// Next: when the time since first use has doubled (elapsed now × 2), 5 min to a week away.
    private static func next(after now: Date, first: Date) -> Date {
        let elapsed = now.timeIntervalSince(first)
        return now.addingTimeInterval(min(max(elapsed, minGap), cap))
    }

    func improved(_ key: String) {
        guard var s = scenes[key] else { return }
        let now = Date()
        s.improves += 1
        s.lastImproved = now
        s.usedSinceImprove = 0
        s.nextImprove = Self.next(after: now, first: s.firstUsed ?? now)
        scenes[key] = s
        persist()
    }

    /// Postpones a scene whose improvement failed (same doubling).
    func deferImprove(_ key: String) {
        guard var s = scenes[key] else { return }
        s.nextImprove = Self.next(after: Date(), first: s.firstUsed ?? Date())
        scenes[key] = s
        persist()
    }

    func list() -> [[String: Any]] {
        let f = ISO8601DateFormatter()
        return scenes.values.sorted { $0.lastUsed > $1.lastUsed }.prefix(40).map { s in
            var r: [String: Any] = ["key": s.key, "title": s.title, "opens": s.opens, "minutes": Int(s.dwellMs / 60000),
                                    "interactions": s.interactions, "improves": s.improves, "usedSinceImprove": s.usedSinceImprove,
                                    "findings": s.findings.count]
            if let n = s.nextImprove { r["nextImprove"] = f.string(from: n) }
            if let data = try? Data(contentsOf: shot(s.key)) { r["shot"] = "data:image/jpeg;base64," + data.base64EncodedString() }
            return r
        }
    }

    func scene(_ key: String) -> Scene? { scenes[key] }

    /// The scene a key stands for now (following merges).
    func canonical(_ key: String) -> String {
        var k = key, hops = 0
        while let n = scenes[k]?.mergedInto, n != k, hops < 8 { k = n; hops += 1 }
        return k
    }

    /// The user's applets (scenes in use, merges excluded), most used first — so a new request
    /// that is almost one of them returns to it instead of building a near-copy.
    func applets(limit: Int = 40) -> [[String: Any]] {
        scenes.values.filter { $0.mergedInto == nil && !$0.title.isEmpty }
            .sorted { $0.opens > $1.opens }.prefix(limit)
            .map { ["key": $0.key, "title": $0.title, "opens": $0.opens] }
    }

    /// An existing applet with this title (normalised), if any.
    func applet(titled title: String) -> String? {
        let n = Self.norm(title)
        guard !n.isEmpty else { return nil }
        return scenes.values.filter { $0.mergedInto == nil && Self.norm($0.title) == n }.max { $0.opens < $1.opens }?.key
    }
    static func norm(_ s: String) -> String {
        s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
    }

    /// The user asked for more of an applet (a request it should absorb): improve it soon with that in mind.
    func request(_ key: String, _ text: String) {
        guard var s = scenes[key], !text.isEmpty else { return }
        s.findings = Array((["The user also asked for: " + String(text.prefix(300))] + s.findings).prefix(20))
        s.usedSinceImprove = max(1, s.usedSinceImprove)
        s.nextImprove = Date()
        s.lastUsed = Date()
        scenes[key] = s
        persist()
    }

    /// Merges a near-duplicate scene into another (the unity pass).
    func merge(_ from: String, into: String) {
        guard from != into, scenes[into] != nil, var s = scenes[from] else { return }
        s.mergedInto = into
        s.lastUsed = Date()
        scenes[from] = s
        if var t = scenes[into] {
            t.opens += s.opens; t.dwellMs += s.dwellMs; t.interactions += s.interactions
            t.findings = Array((t.findings + s.findings).prefix(20))
            t.usedSinceImprove = max(1, t.usedSinceImprove); t.nextImprove = Date(); t.lastUsed = Date()
            scenes[into] = t
        }
        persist()
    }

    // MARK: - Storage

    private func mergeDisk() {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let data = Storage.read(file), let list = try? dec.decode([Scene].self, from: data) else { return }
        for s in list {
            if let mine = scenes[s.key], mine.lastUsed >= s.lastUsed { continue }
            scenes[s.key] = s
        }
    }

    private func persist() {
        mergeDisk()
        if scenes.count > 300 {
            for s in scenes.values.sorted(by: { $0.lastUsed < $1.lastUsed }).prefix(scenes.count - 300) {
                scenes[s.key] = nil
                try? FileManager.default.removeItem(at: shot(s.key))
            }
        }
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(Array(scenes.values)) { Storage.write(data, to: file) }
    }
}
