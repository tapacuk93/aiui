import Foundation

/// App-level state shared by every scene and screen — and synced across devices through Storage:
/// `aiui.app.get/set/subscribe` in scenes, and the app's own services (the background player).
/// Values are JSON; the newest write wins per key. Changes from other devices are announced
/// to the page (`appChanged`) when they arrive.
final class AppStore {
    private struct Item: Codable { var value: AnyCodable; var updated: Date }
    private let file: URL
    private var items: [String: Item] = [:]
    var onChange: ((String, Any) -> Void)?

    init(dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("app.json")
        _ = mergeDisk()
    }

    func get(_ key: String) -> Any? { items[key]?.value.value }
    func all() -> [String: Any] { items.mapValues { $0.value.value } }

    func set(_ key: String, _ value: Any) {
        items[key] = Item(value: AnyCodable(value), updated: Date())
        persist()
    }

    /// Pulls in other devices' changes and announces the keys that changed.
    func reload() {
        for (k, v) in mergeDisk() { onChange?(k, v) }
    }

    @discardableResult
    private func mergeDisk() -> [String: Any] {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let data = Storage.read(file), let disk = try? dec.decode([String: Item].self, from: data) else { return [:] }
        var changed: [String: Any] = [:]
        for (k, v) in disk where (items[k]?.updated ?? .distantPast) < v.updated {
            items[k] = v
            changed[k] = v.value.value
        }
        return changed
    }

    private func persist() {
        mergeDisk()
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(items) { Storage.write(data, to: file) }
    }
}
