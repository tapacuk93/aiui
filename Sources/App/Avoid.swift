import Foundation

/// An indexed record of everything that failed in AI-made screens — hosts and specific URLs —
/// with why, how often and since when. Active entries go to the AI with every request
/// (`avoid`) so it stops using them; each is rechecked in the background with exponential
/// backoff (10 min, doubling, up to 7 days) and cleared once it works again.
/// Synced through Storage like the other stores.
final class Avoid {
    struct Entry: Codable {
        var key: String          // host, or a full URL for one resource
        var kind: String         // "host" | "url"
        var sample: String       // a URL to recheck with
        var reason: String       // last failure: "403", "timeout", "failed", ...
        var failures: Int
        var first: Date
        var last: Date
        var nextCheck: Date
        var backoff: Double      // seconds until the next recheck
        var checks: Int
    }

    private let file: URL
    private var entries: [String: Entry] = [:]
    private var checking = Set<String>()
    static let firstBackoff: Double = 600, maxBackoff: Double = 7 * 86_400

    init(dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("avoid.json")
        mergeDisk()
    }

    func reload() { mergeDisk() }

    /// Records failures reported by a view: [{url, reason}]. A host counts as failing once two
    /// of its resources failed, or one was refused outright (401/403/451, DNS).
    func record(_ items: [[String: Any]]) {
        let now = Date()
        for item in items {
            guard let url = item["url"] as? String, let u = URL(string: url), let host = u.host else { continue }
            let reason = item["reason"] as? String ?? "failed"
            for (key, kind) in [(host, "host"), (url, "url")] {
                var e = entries[key] ?? Entry(key: key, kind: kind, sample: url, reason: reason, failures: 0, first: now,
                                              last: now, nextCheck: now.addingTimeInterval(Self.firstBackoff),
                                              backoff: Self.firstBackoff, checks: 0)
                e.failures += 1
                e.last = now
                e.reason = reason
                e.sample = url
                entries[key] = e
            }
        }
        persist()
    }

    private func isActive(_ e: Entry) -> Bool {
        e.kind == "url" || e.failures >= 2 || ["401", "403", "451", "dns"].contains(e.reason)
    }

    /// What the AI sees: active hosts first (most failures), then single URLs, one line each.
    func overview(limit: Int = 30) -> [String] {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate]
        return entries.values.filter(isActive)
            .sorted { $0.kind != $1.kind ? $0.kind == "host" : $0.failures > $1.failures }
            .prefix(limit)
            .map { "\($0.key) — \($0.reason) ×\($0.failures) since \(f.string(from: $0.first))" }
    }

    /// Rechecks entries whose time has come; a success clears the entry (and, for a host,
    /// its URLs), a failure doubles the wait.
    func recheckDue() {
        let now = Date()
        for e in entries.values where e.nextCheck <= now && !checking.contains(e.key) {
            guard let url = URL(string: e.sample) else { entries[e.key] = nil; continue }
            checking.insert(e.key)
            var req = URLRequest(url: url, timeoutInterval: 15)
            req.httpMethod = "GET"
            req.setValue("bytes=0-1023", forHTTPHeaderField: "Range")
            URLSession.shared.dataTask(with: req) { [weak self] _, response, error in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let ok = error == nil && (200..<400).contains(status)
                DispatchQueue.main.async {
                    guard let self, var cur = self.entries[e.key] else { return }
                    self.checking.remove(e.key)
                    cur.checks += 1
                    if ok {
                        self.entries[e.key] = nil
                        if cur.kind == "host" {
                            for (k, v) in self.entries where v.kind == "url" && URL(string: k)?.host == cur.key { self.entries[k] = nil }
                        }
                    } else {
                        cur.reason = status > 0 ? String(status) : (error.map { ($0 as NSError).code == NSURLErrorTimedOut ? "timeout" : "failed" } ?? "failed")
                        cur.backoff = min(cur.backoff * 2, Self.maxBackoff)
                        cur.nextCheck = Date().addingTimeInterval(cur.backoff)
                        self.entries[e.key] = cur
                    }
                    self.persist()
                }
            }.resume()
        }
    }

    func list() -> [[String: Any]] {
        let f = ISO8601DateFormatter()
        return entries.values.sorted { $0.last > $1.last }.map {
            ["key": $0.key, "kind": $0.kind, "reason": $0.reason, "failures": $0.failures, "active": isActive($0),
             "nextCheck": f.string(from: $0.nextCheck), "checks": $0.checks]
        }
    }

    func clear() { entries = [:]; persist() }

    // MARK: - Storage (merge on write, newest `last` wins)

    private func mergeDisk() {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let data = Storage.read(file), let disk = try? dec.decode([Entry].self, from: data) else { return }
        for e in disk {
            if let mine = entries[e.key], mine.last >= e.last { continue }
            entries[e.key] = e
        }
    }

    private func persist() {
        if entries.count > 500 {
            for e in entries.values.sorted(by: { $0.last < $1.last }).prefix(entries.count - 500) { entries[e.key] = nil }
        }
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(Array(entries.values)) { Storage.write(data, to: file) }
    }
}
