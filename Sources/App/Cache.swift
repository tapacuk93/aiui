import CryptoKit
import Foundation

/// Size-limited, persistent record of what the user did (action), what came out (outcome),
/// and a one-line index description of each. Doubles as a screen cache for stable outcomes
/// and as long-term memory the AI can search (index.txt).
final class Cache {
    static let version = 2

    struct Entry: Codable {
        var v: Int
        var flow: [String]
        var key: String
        var created: Date
        var lastUsed: Date
        var hits: Int
        var description: String
        var cacheable: Bool
        var size: Int
        var action: [String: AnyCodable]
        var outcome: [String: AnyCodable]
    }

    /// Index row: everything but the outcome itself.
    struct IndexRow: Codable {
        var v: Int
        /// The prompt/schema generation that produced the outcome (see `generation`).
        var gen: String?
        var flow: [String]
        var key: String
        var created: Date
        var lastUsed: Date
        var hits: Int
        var description: String
        var cacheable: Bool
        var size: Int
        var action: [String: AnyCodable]
    }

    let dir: URL
    var limitBytes: Int
    private var index: [String: IndexRow] = [:]
    private let fm = FileManager.default
    private let enc: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()
    private let dec: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    var indexText: URL { dir.appendingPathComponent("index.txt") }
    private var indexJSON: URL { dir.appendingPathComponent("index.json") }
    private var entries: URL { dir.appendingPathComponent("entries", isDirectory: true) }

    /// Fingerprint of the prompts and screen schema in this build. Outcomes from another
    /// generation stay in the index (memory, flows) but are not replayed or reused as screens:
    /// that is how the cache migrates across app updates.
    var generation = ""

    init(dir: URL, limitMB: Int) {
        self.dir = dir
        self.limitBytes = max(1, limitMB) * 1_048_576
        try? fm.createDirectory(at: entries, withIntermediateDirectories: true)
        Storage.download(dir)
        if let data = Storage.read(indexJSON),
           let rows = try? dec.decode([IndexRow].self, from: data) {
            for r in rows where r.v == Self.version && fm.fileExists(atPath: file(r.key).path) { index[r.key] = r }
        }
        // Drop entry files the index no longer knows (older formats, interrupted writes).
        for f in (try? fm.contentsOfDirectory(at: entries, includingPropertiesForKeys: nil)) ?? []
        where index[f.deletingPathExtension().lastPathComponent] == nil {
            try? fm.removeItem(at: f)
        }
    }

    // MARK: - Actions

    /// The parts of a UI event that identify the action (not the whole screen state).
    static func action(from input: [String: Any]) -> [String: Any] {
        var a: [String: Any] = ["event": input["event"] ?? "?"]
        // Outcomes are in the user's language: a different language is a different action.
        if let lang = input["language"] as? String { a["language"] = lang }
        if let path = input["path"] as? [Any] { a["path"] = path }
        if let t = input["target"] as? [String: Any], let label = t["label"] { a["target"] = label }
        if let text = input["text"] as? String, !text.isEmpty { a["text"] = text }
        if let data = input["data"] { a["data"] = data }
        if let screen = input["screen"] as? [String: Any] {
            if let title = screen["title"] { a["on"] = title }
            let circles = screen["circles"] as? [[String: Any]] ?? []
            let selected = circles.filter { ($0["selected"] as? Bool) == true }.compactMap { $0["label"] as? String }
            if !selected.isEmpty { a["selected"] = selected.sorted() }
            let valued = circles.compactMap { c -> String? in
                guard let v = c["value"], let l = c["label"] as? String else { return nil }
                return "\(l)=\(v)"
            }
            if !valued.isEmpty { a["values"] = valued.sorted() }
            if let removed = screen["removed"] as? [String], !removed.isEmpty { a["removed"] = removed.sorted() }
        }
        return a
    }

    static func key(for action: [String: Any]) -> String {
        var norm = action
        if let t = norm["text"] as? String { norm["text"] = t.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
        let data = (try? JSONSerialization.data(withJSONObject: norm, options: [.sortedKeys])) ?? Data()
        return SHA256.hash(data: data).prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Lookup / store

    /// A stored outcome for this action, if the AI marked it stable.
    func lookup(_ key: String) -> [String: Any]? {
        guard var row = index[key], row.cacheable, row.gen == generation,
              let data = try? Data(contentsOf: file(key)),
              let entry = try? dec.decode(Entry.self, from: data) else { return nil }
        row.hits += 1
        row.lastUsed = Date()
        index[key] = row
        saveIndex()
        return entry.outcome.mapValues { $0.value }
    }

    /// Any stored outcome by key (for AI `reuse`), cacheable or not.
    func outcome(_ key: String) -> [String: Any]? {
        guard var row = index[key], let data = try? Data(contentsOf: file(key)),
              let entry = try? dec.decode(Entry.self, from: data) else { return nil }
        // An HTML screen from an older generation may not work with this build: don't reuse it.
        if row.gen != generation, (entry.outcome["kind"]?.value as? String) == "html" { return nil }
        row.hits += 1
        row.lastUsed = Date()
        index[key] = row
        saveIndex()
        return entry.outcome.mapValues { $0.value }
    }

    /// The circle the user most often opens on the screen at `path` (by label), if any.
    func likely(path: [String]) -> String? {
        let rows = index.values.filter { row in
            let a = row.action.mapValues { $0.value }
            return a["event"] as? String == "open" && ((a["path"] as? [Any])?.map { "\($0)" } ?? []) == path
        }
        return rows.max { $0.hits != $1.hits ? $0.hits < $1.hits : $0.lastUsed < $1.lastUsed }
            .flatMap { $0.action["target"]?.value as? String }
    }

    /// The flow index in brief: most recent and most used flows, one line each.
    func overview(limit: Int = 16) -> [String] {
        let recent = index.values.sorted { $0.lastUsed > $1.lastUsed }.prefix(limit * 2 / 3)
        let frequent = index.values.sorted { $0.hits > $1.hits }.prefix(limit)
        var seen = Set<String>(), rows: [IndexRow] = []
        for r in Array(recent) + Array(frequent) where rows.count < limit && seen.insert(r.key).inserted { rows.append(r) }
        return rows.map { "\(($0.flow + [Self.line($0)]).joined(separator: " ⟶ ")) | \($0.description) | ×\($0.hits) [\($0.key)]" }
    }

    /// Index rows most related to `words` (path, target, text), for the AI's context.
    func related(_ words: [String], limit: Int = 8) -> [[String: Any]] {
        let ws = Set(words.flatMap { $0.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) }
            .map(String.init).filter { $0.count > 2 })
        guard !ws.isEmpty else { return [] }
        let scored = index.values.map { row -> (IndexRow, Int) in
            let hay = (row.description + " " + Self.line(row) + " " + row.flow.joined(separator: " ")).lowercased()
            return (row, ws.reduce(0) { $0 + (hay.contains($1) ? 1 : 0) })
        }
        return scored.filter { $0.1 > 0 }
            .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.lastUsed > $1.0.lastUsed }
            .prefix(limit)
            .map { ["key": $0.0.key, "flow": ($0.0.flow + [Self.line($0.0)]).joined(separator: " ⟶ "),
                    "outcome": $0.0.description, "hits": $0.0.hits] }
    }

    func store(key: String, action: [String: Any], flow: [String], outcome: [String: Any]) {
        var outcome = outcome
        let description = (outcome.removeValue(forKey: "note") as? String) ?? Self.describe(action, outcome)
        let cacheable = (outcome.removeValue(forKey: "cacheable") as? Bool) ?? false
        let now = Date()
        var entry = Entry(v: Self.version, flow: flow, key: key, created: index[key]?.created ?? now, lastUsed: now,
                          hits: (index[key]?.hits ?? 0) + 1, description: description, cacheable: cacheable,
                          size: 0, action: action.mapValues(AnyCodable.init), outcome: outcome.mapValues(AnyCodable.init))
        guard var data = try? enc.encode(entry) else { return }
        entry.size = data.count
        data = (try? enc.encode(entry)) ?? data
        Storage.write(data, to: file(key))
        index[key] = IndexRow(v: Self.version, gen: generation, flow: flow, key: key, created: entry.created, lastUsed: now, hits: entry.hits,
                              description: description, cacheable: cacheable, size: data.count,
                              action: entry.action)
        evict()
        saveIndex()
    }

    // MARK: - Maintenance

    var totalBytes: Int { index.values.reduce(0) { $0 + $1.size } }

    func stats() -> [String: Any] {
        ["entries": index.count, "bytes": totalBytes, "limitBytes": limitBytes,
         "dir": dir.path, "index": indexText.path]
    }

    func search(_ q: String, limit: Int = 50) -> [[String: Any]] {
        let words = q.lowercased().split(separator: " ").map(String.init)
        return index.values
            .filter { row in
                let hay = (row.description + " " + Self.line(row)).lowercased()
                return words.allSatisfy { hay.contains($0) }
            }
            .sorted { $0.lastUsed > $1.lastUsed }
            .prefix(limit)
            .map { ["key": $0.key, "description": $0.description, "when": ISO8601DateFormatter().string(from: $0.lastUsed),
                    "hits": $0.hits, "action": $0.action.mapValues { $0.value }] }
    }

    /// The flow recorded with a key (the steps that led to it).
    func flow(_ key: String) -> [String] { index[key]?.flow ?? [] }

    /// The stored outcome for a key, whatever its generation (for improvement and live reload).
    func raw(_ key: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: file(key)), let entry = try? dec.decode(Entry.self, from: data) else { return nil }
        return entry.outcome.mapValues { $0.value }
    }

    /// Replaces a stored outcome in place (an improved version), keeping its action and flow.
    func replace(_ key: String, with outcome: [String: Any]) {
        guard let row = index[key] else { return }
        store(key: key, action: row.action.mapValues { $0.value }, flow: row.flow, outcome: outcome)
    }

    /// Drops one stored outcome (a screen that turned out broken).
    func invalidate(_ key: String) {
        try? fm.removeItem(at: file(key))
        index[key] = nil
        saveIndex()
    }

    func clear() {
        try? fm.removeItem(at: entries)
        try? fm.createDirectory(at: entries, withIntermediateDirectories: true)
        index = [:]
        saveIndex()
    }

    /// Least-recently-used entries go first until the cache fits its limit.
    private func evict() {
        var total = totalBytes
        guard total > limitBytes else { return }
        for row in index.values.sorted(by: { $0.lastUsed < $1.lastUsed }) {
            if total <= limitBytes * 9 / 10 { break }
            try? fm.removeItem(at: file(row.key))
            index[row.key] = nil
            total -= row.size
        }
    }

    /// Pulls in rows another device wrote (their entry files arrive through iCloud).
    func reload() {
        Storage.download(dir); Storage.download(entries)
        mergeDisk()
    }

    private func mergeDisk() {
        guard let data = Storage.read(indexJSON), let rows = try? dec.decode([IndexRow].self, from: data) else { return }
        for r in rows where r.v == Self.version {
            guard fm.fileExists(atPath: file(r.key).path) else { continue }
            if let mine = index[r.key] {
                if r.lastUsed > mine.lastUsed { var m = r; m.hits = max(r.hits, mine.hits); index[r.key] = m }
            } else {
                index[r.key] = r
            }
        }
        // Rows whose entry was deleted (evicted or cleared on any device) go too.
        for k in index.keys where !fm.fileExists(atPath: file(k).path) { index[k] = nil }
    }

    private func saveIndex() {
        mergeDisk()
        let rows = index.values.sorted { $0.lastUsed > $1.lastUsed }
        if let data = try? enc.encode(rows) { Storage.write(data, to: indexJSON) }
        let header = "# aiui memory index — user flows and outcomes, newest first.\n# when | hits | flow (earlier steps ⟶ this action) | outcome [key]. Full outcome: entries/<key>.json; reuse any by key.\n"
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd HH:mm"
        let lines = rows.map {
            "\(fmt.string(from: $0.lastUsed)) | \($0.hits) | \(($0.flow + [Self.line($0)]).joined(separator: " ⟶ ")) | \($0.description) [\($0.key)]"
        }
        try? (header + lines.joined(separator: "\n") + "\n").write(to: indexText, atomically: true, encoding: .utf8)
    }

    private func file(_ key: String) -> URL { entries.appendingPathComponent("\(key).json") }

    private static func line(_ row: IndexRow) -> String { line(action: row.action.mapValues { $0.value }) }

    /// One readable line for an action: event, path, target, selections, text.
    static func line(action a: [String: Any]) -> String {
        var parts = [a["event"] as? String ?? "?"]
        if let path = a["path"] as? [Any], !path.isEmpty { parts.append(path.map { "\($0)" }.joined(separator: " › ")) }
        if let t = a["target"] { parts.append("→ \(t)") }
        if let s = a["selected"] as? [Any] { parts.append("selected: " + s.map { "\($0)" }.joined(separator: ", ")) }
        if let t = a["text"] as? String { parts.append("“\(t.prefix(80))”") }
        return parts.joined(separator: " ")
    }

    private static func describe(_ action: [String: Any], _ outcome: [String: Any]) -> String {
        let kind = outcome["kind"] as? String ?? "screen"
        let title = outcome["title"] as? String ?? ""
        let n = (outcome["circles"] as? [Any])?.count
        return "\(kind)\(title.isEmpty ? "" : " “\(title)”")\(n.map { " with \($0) circles" } ?? "")"
    }
}

/// Minimal JSON-value wrapper so arbitrary screen JSON can be Codable.
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = NSNull() }
        else if let b = try? c.decode(Bool.self) { value = b }
        else if let i = try? c.decode(Int.self) { value = i }
        else if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = s }
        else if let a = try? c.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let o = try? c.decode([String: AnyCodable].self) { value = o.mapValues(\.value) }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let n as NSNumber where CFGetTypeID(n) == CFBooleanGetTypeID(): try c.encode(n.boolValue)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let a as [Any]: try c.encode(a.map(AnyCodable.init))
        case let o as [String: Any]: try c.encode(o.mapValues(AnyCodable.init))
        default: try c.encodeNil()
        }
    }
}
