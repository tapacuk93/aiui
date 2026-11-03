import CryptoKit
import Foundation

/// The internal utility library: small reusable code modules (JS helpers, CSS components) that
/// screen generations publish and later screens reuse instead of rewriting. Filed in a category
/// tree (`path`, broad → specific), sorted by use, reviewed now and then by the librarian AI
/// (merge duplicates, improve, re-file, drop dead code). Merged/renamed modules leave aliases,
/// so screens that declared the old id keep working. Synced through Storage like the other stores.
final class Utilities {
    struct Module: Codable {
        var id: String
        var path: [String]
        var name: String
        var kind: String          // "js" | "css"
        var description: String
        var usage: String
        var code: String
        var version: Int
        var uses: Int
        var created: Date
        var updated: Date
        var lastUsed: Date
    }

    private struct Stored: Codable {
        var modules: [Module]
        var deleted: [String: Date]
        var aliases: [String: String]
        var lastReview: Date?
        var publishesSinceReview: Int?
    }

    private let file: URL
    private var modules: [String: Module] = [:]
    private var deleted: [String: Date] = [:]
    private var aliases: [String: String] = [:]
    private(set) var lastReview: Date?
    private(set) var publishesSinceReview = 0
    let limitBytes = 4 * 1_048_576
    let limitCount = 400

    init(dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("library.json")
        Storage.download(dir)
        mergeDisk()
    }

    func reload() { Storage.download(file.deletingLastPathComponent()); mergeDisk() }

    static func id(path: [String], name: String) -> String {
        let d = SHA256.hash(data: Data((path + [name]).joined(separator: "/").lowercased().utf8))
        return "m" + d.prefix(5).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Publish / resolve

    /// Saves the modules a screen publishes (`publish`: [{path, name, kind, description, usage, code}]).
    @discardableResult
    func publish(from screen: [String: Any]) -> [String] {
        var ids: [String] = []
        for m in screen["publish"] as? [[String: Any]] ?? [] {
            guard let name = m["name"] as? String, !name.isEmpty, let code = m["code"] as? String, !code.isEmpty else { continue }
            let path = (m["path"] as? [String] ?? []).filter { !$0.isEmpty }.prefix(3).map { $0 }
            let id = Self.id(path: path, name: name)
            let now = Date()
            let prev = modules[id]
            modules[id] = Module(id: id, path: path.isEmpty ? ["misc"] : path, name: name,
                                 kind: (m["kind"] as? String) == "css" ? "css" : "js",
                                 description: m["description"] as? String ?? prev?.description ?? "",
                                 usage: m["usage"] as? String ?? prev?.usage ?? "",
                                 code: code, version: (prev?.version ?? 0) + 1, uses: prev?.uses ?? 0,
                                 created: prev?.created ?? now, updated: now, lastUsed: now)
            deleted[id] = nil
            ids.append(id)
        }
        if !ids.isEmpty {
            publishesSinceReview += ids.count
            trim()
            persist()
        }
        return ids
    }

    /// The code for the modules a screen declares in `uses` (ids, or "path/name"), in the listed
    /// order; follows aliases left by reviews. Counts the use.
    func bundle(_ refs: [String]) -> [String: Any] {
        var js: [String] = [], css: [String] = [], found: [String] = [], missing: [String] = []
        var seen = Set<String>()
        for ref in refs {
            guard let id = resolve(ref), !seen.contains(id), var m = modules[id] else { missing.append(ref); continue }
            seen.insert(id)
            m.uses += 1; m.lastUsed = Date(); modules[id] = m
            let header = "/* \((m.path + [m.name]).joined(separator: "/")) v\(m.version) */\n"
            if m.kind == "css" { css.append(header + m.code) } else { js.append(header + m.code) }
            found.append(id)
        }
        if !found.isEmpty { persist() }
        return ["js": js.joined(separator: "\n;\n"), "css": css.joined(separator: "\n"), "ids": found, "missing": missing]
    }

    private func resolve(_ ref: String) -> String? {
        var id = ref
        if modules[id] == nil, ref.contains("/") {
            let parts = ref.split(separator: "/").map(String.init)
            id = Self.id(path: Array(parts.dropLast()), name: parts.last ?? "")
        }
        var hops = 0
        while modules[id] == nil, let next = aliases[id], hops < 8 { id = next; hops += 1 }
        return modules[id] == nil ? nil : id
    }

    // MARK: - What the AI sees

    /// One line per module, most relevant to `words` first, then most used.
    func overview(_ words: [String], limit: Int = 40) -> [String] {
        let ws = Set(words.flatMap { $0.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) }.map(String.init))
        return modules.values.map { m -> (Module, Int) in
            let hay = (m.path.joined(separator: " ") + " " + m.name + " " + m.description).lowercased()
            return (m, ws.reduce(0) { $0 + (hay.contains($1) ? 1 : 0) })
        }
        .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.uses > $1.0.uses }
        .prefix(limit)
        .map { (pair: (Module, Int)) -> String in
            let m = pair.0
            let name: String = (m.path + [m.name]).joined(separator: " › ")
            let usage: String = m.usage.isEmpty ? "" : " · usage: \(m.usage)"
            return "\(name) (\(m.kind)) — \(m.description)\(usage) [\(m.id)]"
        }
    }

    var categories: [String] {
        Set(modules.values.flatMap { m in (1...max(1, m.path.count)).map { m.path.prefix($0).joined(separator: " › ") } }).sorted()
    }

    // MARK: - Review (librarian)

    var needsReview: Bool {
        guard modules.count >= 2 else { return false }
        return publishesSinceReview >= 6 || (lastReview ?? .distantPast) < Date().addingTimeInterval(-86_400)
    }

    /// Every module with its code (bounded), for the librarian.
    func reviewInput() -> [[String: Any]] {
        var budget = 120_000
        return modules.values.sorted { $0.uses > $1.uses }.compactMap { m in
            guard budget > 0 else { return nil }
            budget -= m.code.count
            return ["id": m.id, "path": m.path, "name": m.name, "kind": m.kind, "description": m.description,
                    "usage": m.usage, "uses": m.uses, "version": m.version, "code": String(m.code.prefix(12_000))]
        }
    }

    /// Applies the librarian's result: `updates` (improve or re-file a module), `merge` (several
    /// into one; the old ids become aliases), `remove` (dead code).
    func applyReview(_ r: [String: Any]) {
        let now = Date()
        for u in r["updates"] as? [[String: Any]] ?? [] {
            guard let id = u["id"] as? String, var m = modules[id] else { continue }
            if let v = u["code"] as? String, !v.isEmpty { m.code = v; m.version += 1 }
            if let v = u["description"] as? String { m.description = v }
            if let v = u["usage"] as? String { m.usage = v }
            let newPath = (u["path"] as? [String])?.filter { !$0.isEmpty }
            let newName = u["name"] as? String
            if let p = newPath, !p.isEmpty { m.path = p }
            if let n = newName, !n.isEmpty { m.name = n }
            let nid = Self.id(path: m.path, name: m.name)
            if nid != id { modules[id] = nil; deleted[id] = now; aliases[id] = nid; m.id = nid }
            m.updated = now
            modules[m.id] = m
        }
        for g in r["merge"] as? [[String: Any]] ?? [] {
            guard let from = g["from"] as? [String], let into = g["into"] as? [String: Any],
                  let name = into["name"] as? String, let code = into["code"] as? String else { continue }
            let path = (into["path"] as? [String] ?? []).filter { !$0.isEmpty }
            let nid = Self.id(path: path, name: name)
            let olds = from.compactMap { modules[$0] }
            modules[nid] = Module(id: nid, path: path.isEmpty ? ["misc"] : path, name: name,
                                  kind: (into["kind"] as? String) == "css" ? "css" : "js",
                                  description: into["description"] as? String ?? "", usage: into["usage"] as? String ?? "",
                                  code: code, version: (olds.map(\.version).max() ?? 0) + 1,
                                  uses: olds.reduce(0) { $0 + $1.uses }, created: olds.map(\.created).min() ?? now,
                                  updated: now, lastUsed: olds.map(\.lastUsed).max() ?? now)
            deleted[nid] = nil
            for o in from where o != nid { modules[o] = nil; deleted[o] = now; aliases[o] = nid }
        }
        for id in r["remove"] as? [String] ?? [] { modules[id] = nil; deleted[id] = now }
        lastReview = now
        publishesSinceReview = 0
        persist()
    }

    // MARK: - Browsing (local, for the user)

    func tree(at path: [String]) -> [String: Any] {
        let under = modules.values.filter { Array($0.path.prefix(path.count)) == path }
        var cats: [String: (count: Int, uses: Int)] = [:]
        var here: [Module] = []
        for m in under {
            if m.path.count > path.count {
                let c = m.path[path.count]
                cats[c, default: (0, 0)].count += 1
                cats[c, default: (0, 0)].uses += m.uses
            } else { here.append(m) }
        }
        return [
            "categories": cats.sorted { $0.value.uses != $1.value.uses ? $0.value.uses > $1.value.uses : $0.key < $1.key }
                .map { ["name": $0.key, "count": $0.value.count] as [String: Any] },
            "utilities": here.sorted { $0.uses != $1.uses ? $0.uses > $1.uses : $0.name < $1.name }
                .map { ["id": $0.id, "name": $0.name, "icon": $0.kind == "css" ? "🎨" : "🧩",
                        "description": $0.description, "uses": $0.uses, "version": $0.version] as [String: Any] },
            "total": modules.count,
            "lastReview": lastReview.map { ISO8601DateFormatter().string(from: $0) } ?? "",
        ]
    }

    func delete(_ id: String) { modules[id] = nil; deleted[id] = Date(); persist() }

    // MARK: - Storage

    private func mergeDisk() {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let data = Storage.read(file), let disk = try? dec.decode(Stored.self, from: data) else { return }
        for (id, at) in disk.deleted where (deleted[id] ?? .distantPast) < at { deleted[id] = at }
        for (k, v) in disk.aliases where aliases[k] == nil { aliases[k] = v }
        for m in disk.modules {
            if let mine = modules[m.id], mine.updated >= m.updated {
                modules[m.id]?.uses = max(mine.uses, m.uses)
                continue
            }
            modules[m.id] = m
        }
        for (id, at) in deleted where (modules[id]?.updated ?? .distantPast) <= at { modules[id] = nil }
        if let r = disk.lastReview, r > (lastReview ?? .distantPast) { lastReview = r; publishesSinceReview = 0 }
    }

    private func trim() {
        var size = modules.values.reduce(0) { $0 + $1.code.utf8.count }
        for m in modules.values.sorted(by: { $0.lastUsed < $1.lastUsed }) where size > limitBytes || modules.count > limitCount {
            size -= m.code.utf8.count
            modules[m.id] = nil
            deleted[m.id] = Date()
        }
    }

    private func persist() {
        mergeDisk()
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        let s = Stored(modules: Array(modules.values), deleted: deleted, aliases: aliases,
                       lastReview: lastReview, publishesSinceReview: publishesSinceReview)
        if let data = try? enc.encode(s) { Storage.write(data, to: file) }
    }
}
