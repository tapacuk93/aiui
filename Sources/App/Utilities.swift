import CryptoKit
import Foundation

/// The user's library of reusable utilities the AI built (calculators, converters, games, tools),
/// filed in a category tree (`path`, broad → specific) and sorted by use. Size-limited.
final class Utilities {
    struct Item: Codable {
        var id: String
        var name: String
        var icon: String
        var description: String
        var path: [String]
        var screen: [String: AnyCodable]
        var created: Date
        var lastUsed: Date
        var uses: Int
    }

    private let file: URL
    private var items: [String: Item] = [:]
    /// Tombstones: deleted ids and when, so a deletion on one device isn't undone by another.
    private var deleted: [String: Date] = [:]
    private struct Stored: Codable { var items: [Item]; var deleted: [String: Date] }
    let limitBytes = 32 * 1_048_576
    let limitCount = 500

    init(dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("utilities.json")
        Storage.download(dir)
        mergeDisk()
    }

    func reload() { Storage.download(file.deletingLastPathComponent()); mergeDisk() }

    private func mergeDisk() {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let data = Storage.read(file) else { return }
        let disk = (try? dec.decode(Stored.self, from: data))
            ?? Stored(items: (try? dec.decode([Item].self, from: data)) ?? [], deleted: [:])
        for (id, at) in disk.deleted where (deleted[id] ?? .distantPast) < at { deleted[id] = at }
        for i in disk.items {
            if let mine = items[i.id], mine.lastUsed >= i.lastUsed { continue }
            items[i.id] = i
        }
        for (id, at) in deleted where (items[id]?.lastUsed ?? .distantPast) <= at { items[id] = nil }
    }

    /// Saves (or updates, by category path + name) the utility a screen declares in `utility`.
    @discardableResult
    func save(from screen: [String: Any]) -> Item? {
        guard let u = screen["utility"] as? [String: Any], let name = u["name"] as? String, !name.isEmpty else { return nil }
        let path = (u["path"] as? [String] ?? []).filter { !$0.isEmpty }.prefix(3).map { $0 }
        let digest = SHA256.hash(data: Data((path.joined(separator: "/") + "/" + name).lowercased().utf8))
        let id = "u" + digest.prefix(6).map { String(format: "%02x", $0) }.joined()
        var stored = screen
        for k in ["utility", "note", "cacheable", "reuse"] { stored[k] = nil }
        let now = Date()
        let item = Item(id: items[id]?.id ?? id, name: name, icon: u["icon"] as? String ?? (screen["kind"] as? String == "html" ? "🧰" : "🔧"),
                        description: u["description"] as? String ?? "", path: path.isEmpty ? ["General"] : Array(path),
                        screen: stored.mapValues(AnyCodable.init), created: items[id]?.created ?? now,
                        lastUsed: now, uses: items[id]?.uses ?? 0)
        items[item.id] = item
        deleted[item.id] = nil
        trim()
        persist()
        return item
    }

    func open(_ id: String) -> [String: Any]? {
        guard var i = items[id] else { return nil }
        i.uses += 1; i.lastUsed = Date(); items[id] = i
        persist()
        return i.screen.mapValues(\.value)
    }

    func delete(_ id: String) { items[id] = nil; deleted[id] = Date(); persist() }

    /// Children of `path`: sub-categories (with counts and total uses) and utilities directly in it,
    /// each sorted by use, then name.
    func tree(at path: [String]) -> [String: Any] {
        let under = items.values.filter { Array($0.path.prefix(path.count)) == path }
        var cats: [String: (count: Int, uses: Int)] = [:]
        var here: [Item] = []
        for i in under {
            if i.path.count > path.count {
                let c = i.path[path.count]
                cats[c, default: (0, 0)].count += 1
                cats[c, default: (0, 0)].uses += i.uses
            } else { here.append(i) }
        }
        let categories = cats.sorted { $0.value.uses != $1.value.uses ? $0.value.uses > $1.value.uses : $0.key < $1.key }
            .map { ["name": $0.key, "count": $0.value.count] as [String: Any] }
        let utils = here.sorted { $0.uses != $1.uses ? $0.uses > $1.uses : $0.name < $1.name }
            .map { ["id": $0.id, "name": $0.name, "icon": $0.icon, "description": $0.description] as [String: Any] }
        return ["categories": categories, "utilities": utils, "total": items.count]
    }

    /// The library as the AI sees it: one line per utility, most relevant to `words` first.
    func overview(_ words: [String], limit: Int = 30) -> [String] {
        let ws = Set(words.flatMap { $0.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) }.map(String.init))
        return items.values.map { i -> (Item, Int) in
            let hay = (i.path.joined(separator: " ") + " " + i.name + " " + i.description).lowercased()
            return (i, ws.reduce(0) { $0 + (hay.contains($1) ? 1 : 0) })
        }
        .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.uses > $1.0.uses }
        .prefix(limit)
        .map { "\(($0.0.path + [$0.0.name]).joined(separator: " › ")) — \($0.0.description) [\($0.0.id)]" }
    }

    /// Category paths in use, so new utilities land in existing branches.
    var categories: [String] {
        Set(items.values.flatMap { i in (1...max(1, i.path.count)).map { i.path.prefix($0).joined(separator: " › ") } }).sorted()
    }

    private func trim() {
        let enc = JSONEncoder()
        var size = items.values.reduce(0) { $0 + ((try? enc.encode($1))?.count ?? 0) }
        for i in items.values.sorted(by: { $0.lastUsed < $1.lastUsed }) where size > limitBytes || items.count > limitCount {
            size -= (try? enc.encode(i))?.count ?? 0
            items[i.id] = nil
        }
    }

    private func persist() {
        mergeDisk()
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(Stored(items: Array(items.values), deleted: deleted)) { Storage.write(data, to: file) }
    }
}
