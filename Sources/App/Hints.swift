import CryptoKit
import Foundation

/// Learning from mistakes. The journal records what went wrong (repairs, failed QA, timeouts,
/// errors, screens left at once, cancels); now and then a retrospective AI pass turns it into
/// hints — lessons with evidence and confidence — and retires those that no longer hold. The
/// most relevant hints go with every generation. Both stores are synced through Storage.
final class Hints {
    struct Incident: Codable { var at: Date; var kind: String; var scene: String; var detail: String }
    struct Hint: Codable {
        var id: String
        var text: String
        var scope: String         // all | html | circles | a topic
        var why: String
        var confidence: Double
        var evidence: Int
        var created: Date
        var updated: Date
    }
    private struct Stored: Codable {
        var journal: [Incident]
        var hints: [Hint]
        var retired: [String: Date]
        var lastRetro: Date?
        var lastSummary: String?
    }

    private let file: URL
    private var journal: [Incident] = []
    private var hints: [String: Hint] = [:]
    private var retired: [String: Date] = [:]
    private(set) var lastRetro: Date?
    private(set) var lastSummary = ""

    init(dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("hints.json")
        mergeDisk()
    }

    func reload() { mergeDisk() }

    func add(kind: String, scene: String, detail: String) {
        journal.append(Incident(at: Date(), kind: kind, scene: String(scene.prefix(80)), detail: String(detail.prefix(400))))
        if journal.count > 300 { journal.removeFirst(journal.count - 300) }
        persist()
    }

    /// Due after 15 new incidents, or 6 hours with at least 3.
    var retroDue: Bool {
        let since = journal.filter { $0.at > (lastRetro ?? .distantPast) }.count
        return since >= 15 || (since >= 3 && (lastRetro ?? .distantPast) < Date().addingTimeInterval(-6 * 3600))
    }

    func retroInput() -> [String: Any] {
        let f = ISO8601DateFormatter()
        let recent = journal.filter { $0.at > (lastRetro ?? .distantPast) }.suffix(120)
        return [
            "incidents": recent.map { ["at": f.string(from: $0.at), "kind": $0.kind, "scene": $0.scene, "detail": $0.detail] },
            "hints": hints.values.sorted { $0.confidence > $1.confidence }.map {
                ["id": $0.id, "text": $0.text, "scope": $0.scope, "confidence": $0.confidence, "evidence": $0.evidence]
            },
        ]
    }

    func applyRetro(_ r: [String: Any]) {
        let now = Date()
        for h in r["hints"] as? [[String: Any]] ?? [] {
            guard let text = h["text"] as? String, !text.isEmpty else { continue }
            let id = (h["id"] as? String).flatMap { hints[$0] != nil ? $0 : nil }
                ?? "h" + SHA256.hash(data: Data(text.lowercased().utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
            let conf = min(1, max(0, h["confidence"] as? Double ?? 0.6))
            var x = hints[id] ?? Hint(id: id, text: text, scope: h["scope"] as? String ?? "all", why: h["why"] as? String ?? "",
                                      confidence: conf, evidence: 0, created: now, updated: now)
            x.text = text
            x.scope = h["scope"] as? String ?? x.scope
            x.why = h["why"] as? String ?? x.why
            x.confidence = max(x.confidence * 0.7 + conf * 0.3, conf)
            x.evidence += 1
            x.updated = now
            hints[id] = x
            retired[id] = nil
        }
        for id in r["retire"] as? [String] ?? [] { hints[id] = nil; retired[id] = now }
        // Hints not reconfirmed for 30 days fade.
        for (id, h) in hints where h.updated < now.addingTimeInterval(-30 * 86_400) { hints[id] = nil; retired[id] = now }
        if hints.count > 60 {
            for h in hints.values.sorted(by: { $0.confidence < $1.confidence }).prefix(hints.count - 60) { hints[h.id] = nil }
        }
        lastRetro = now
        lastSummary = r["summary"] as? String ?? ""
        persist()
    }

    /// The hints for a generation: scope all, or matching the screen kind / words; most certain first.
    func relevant(_ words: [String], kind: String? = nil, limit: Int = 12) -> [String] {
        let ws = Set(words.flatMap { $0.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) }.map(String.init).filter { $0.count > 2 })
        return hints.values.filter { h in
            h.scope == "all" || h.scope == kind || ws.contains { h.scope.lowercased().contains($0) || h.text.lowercased().contains($0) }
                || h.scope == "html" || h.scope == "circles"
        }
        .sorted { $0.confidence * Double($0.evidence + 1) > $1.confidence * Double($1.evidence + 1) }
        .prefix(limit)
        .map { "\($0.text) (\($0.scope), ×\($0.evidence))" }
    }

    func status() -> [String: Any] {
        let f = ISO8601DateFormatter()
        return [
            "journal": journal.count,
            "sinceRetro": journal.filter { $0.at > (lastRetro ?? .distantPast) }.count,
            "lastRetro": lastRetro.map { f.string(from: $0) } ?? "",
            "summary": lastSummary,
            "hints": hints.values.sorted { $0.confidence > $1.confidence }.map {
                ["text": $0.text, "scope": $0.scope, "why": $0.why, "confidence": $0.confidence, "evidence": $0.evidence] as [String: Any]
            },
            "recent": journal.suffix(10).reversed().map { ["kind": $0.kind, "scene": $0.scene, "detail": $0.detail] },
        ]
    }

    // MARK: - Storage (merge on write)

    private func mergeDisk() {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let data = Storage.read(file), let d = try? dec.decode(Stored.self, from: data) else { return }
        // Whole seconds: the file keeps ISO-8601 dates without fractions, memory keeps them exact.
        let key = { (i: Incident) in "\(Int(i.at.timeIntervalSince1970))|\(i.kind)|\(i.detail)" }
        var seen = Set<String>()
        journal = (journal + d.journal).sorted { $0.at < $1.at }.filter { seen.insert(key($0)).inserted }
        if journal.count > 300 { journal.removeFirst(journal.count - 300) }
        for (id, at) in d.retired where (retired[id] ?? .distantPast) < at { retired[id] = at }
        for h in d.hints {
            if let mine = hints[h.id], mine.updated >= h.updated { continue }
            hints[h.id] = h
        }
        for (id, at) in retired where (hints[id]?.updated ?? .distantPast) <= at { hints[id] = nil }
        if let r = d.lastRetro, r > (lastRetro ?? .distantPast) { lastRetro = r; lastSummary = d.lastSummary ?? lastSummary }
    }

    private func persist() {
        mergeDisk()
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        let s = Stored(journal: journal, hints: Array(hints.values), retired: retired, lastRetro: lastRetro, lastSummary: lastSummary)
        if let data = try? enc.encode(s) { Storage.write(data, to: file) }
    }
}
