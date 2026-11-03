import Foundation

/// What the app knows about its user, kept on this Mac:
/// - a characteristic tree (path broad → specific, e.g. Interests › Games › Puzzles) with a value,
///   confidence and evidence count per node — written by the background profiler AI;
/// - the behavioral baseline the page measures (typing rhythm, pointer speed, decision time,
///   active hours, language, screen), stored as an opaque blob for the page's own checks.
final class Profile {
    struct Trait: Codable {
        var path: [String]
        var value: String
        var confidence: Double
        var evidence: Int
        var updated: Date
    }

    private let file: URL
    private(set) var traits: [String: Trait] = [:]
    var baseline: [String: AnyCodable] = [:]
    let limit = 300

    private var removed: [String: Date] = [:]
    private struct Stored: Codable { var traits: [Trait]; var baseline: [String: AnyCodable]; var removed: [String: Date]? }

    init(dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("profile.json")
        Storage.download(dir)
        mergeDisk()
    }

    func reload() { Storage.download(file.deletingLastPathComponent()); mergeDisk() }

    private func mergeDisk() {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let data = Storage.read(file), let s = try? dec.decode(Stored.self, from: data) else { return }
        for (k, at) in s.removed ?? [:] where (removed[k] ?? .distantPast) < at { removed[k] = at }
        for t in s.traits {
            let k = Self.key(t.path)
            if let mine = traits[k], mine.updated >= t.updated { continue }
            traits[k] = t
        }
        for (k, at) in removed where (traits[k]?.updated ?? .distantPast) <= at { traits[k] = nil }
        baseline = Self.mergeBaseline(baseline.mapValues(\.value), s.baseline.mapValues(\.value)).mapValues(AnyCodable.init)
    }

    /// Per measure, the summary with more samples wins; active hours take the larger count.
    static func mergeBaseline(_ a: [String: Any], _ b: [String: Any]) -> [String: Any] {
        var out = a
        for (k, v) in b {
            switch (out[k], v) {
            case (nil, _): out[k] = v
            case (let x as [String: Any], let y as [String: Any]):
                if (y["n"] as? Double ?? 0) > (x["n"] as? Double ?? 0) { out[k] = y }
            case (let x as [Any], let y as [Any]) where x.count == y.count:
                out[k] = zip(x, y).map { max(($0 as? Double) ?? 0, ($1 as? Double) ?? 0) }
            default: break
            }
        }
        return out
    }

    private static func key(_ path: [String]) -> String { path.map { $0.lowercased() }.joined(separator: " › ") }

    /// Applies the profiler's updates: new or revised traits (evidence accumulates) and removals.
    func merge(_ result: [String: Any]) {
        for u in result["updates"] as? [[String: Any]] ?? [] {
            guard let path = u["path"] as? [String], !path.isEmpty, let value = u["value"] as? String else { continue }
            let k = Self.key(path)
            let conf = min(1, max(0, u["confidence"] as? Double ?? 0.5))
            var t = traits[k] ?? Trait(path: path, value: value, confidence: conf, evidence: 0, updated: Date())
            t.value = value
            t.confidence = traits[k] == nil ? conf : (t.confidence * 0.6 + conf * 0.4)
            t.evidence += 1
            t.updated = Date()
            traits[k] = t
        }
        for r in result["remove"] as? [[String]] ?? [] { traits[Self.key(r)] = nil }
        if traits.count > limit {
            for t in traits.values.sorted(by: { $0.confidence * Double($0.evidence) < $1.confidence * Double($1.evidence) })
                .prefix(traits.count - limit) { traits[Self.key(t.path)] = nil }
        }
        persist()
    }

    /// The tree as the AI sees it: one line per trait, most certain first.
    func overview(limit: Int = 24) -> [String] {
        traits.values.sorted { $0.confidence * log(Double($0.evidence) + 1.7) > $1.confidence * log(Double($1.evidence) + 1.7) }
            .prefix(limit)
            .map { "\($0.path.joined(separator: " › ")): \($0.value) (\(String(format: "%.1f", $0.confidence)))" }
    }

    /// Children of `path` for browsing: branches (with counts) and traits directly at it.
    func tree(at path: [String]) -> [String: Any] {
        let under = traits.values.filter { Array($0.path.prefix(path.count)).map { $0.lowercased() } == path.map { $0.lowercased() } }
        var branches: [String: Int] = [:]
        var here: [Trait] = []
        for t in under where t.path.count > path.count {
            if t.path.count > path.count + 1 { branches[t.path[path.count], default: 0] += 1 } // deeper: a branch
            else { here.append(t) }                                                              // a trait right here
        }
        return [
            "branches": branches.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map { ["name": $0.key, "count": $0.value] },
            "traits": here.sorted { $0.confidence > $1.confidence }.map {
                ["name": $0.path.last ?? "", "value": $0.value, "confidence": $0.confidence, "path": $0.path] as [String: Any]
            },
            "total": traits.count,
        ]
    }

    func remove(_ path: [String]) { traits[Self.key(path)] = nil; removed[Self.key(path)] = Date(); persist() }
    func clear() { traits = [:]; baseline = [:]; persist() }

    func persist() {
        mergeDisk()
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(Stored(traits: Array(traits.values), baseline: baseline, removed: removed)) {
            Storage.write(data, to: file)
        }
    }
}
