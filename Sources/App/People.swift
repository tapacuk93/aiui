import Foundation

/// People (docs/shared-and-users.md, users.aiui.oeaio.com): an opt-in profile, finding others by
/// name or handle, adding by app id, the contacts list (pending / incoming / mutual) and the
/// router's inbox. Mutual contacts' ids came through the router after both sides added each
/// other with signed requests, so they are shown as verified.
/// Nothing reaches the service until the user opens People (then the inbox is polled every few
/// minutes while the app is open). Kept on this device: the app id is per installation.
final class People {
    static let pollEvery: TimeInterval = 180

    private let file: URL
    /// The profile as last saved (nil: not listed).
    private(set) var profile: [String: Any]?
    private(set) var contacts: [[String: Any]] = []
    private(set) var lastCheck: Date?
    /// The user opened People: from then on the inbox is polled.
    private var active = false
    private var recent: [[String: Any]] = []
    private var timer: Timer?
    private var polling = false

    var emit: ([String: Any]) -> Void = { _ in }

    init(dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("people.json")
        load()
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: Self.pollEvery, repeats: true) { [weak self] _ in self?.pollIfActive() }
        if active { DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.pollIfActive() } }
    }

    func pollIfActive() {
        guard active, !polling else { return }
        Task { try? await self.poll() }
    }

    // MARK: - Ids

    /// A typed or pasted id: 64 hex, spaces, dashes and a prefix like `aiui:` tolerated.
    static func normalize(_ s: String) -> String? {
        let t = s.lowercased().filter { !$0.isWhitespace && $0 != "-" }
        guard let r = t.range(of: "[0-9a-f]{64}", options: .regularExpression) else { return nil }
        // Exactly one id: no further hex right before or after it.
        if r.lowerBound > t.startIndex, t[t.index(before: r.lowerBound)].isHexDigit, t[..<r.lowerBound].contains(":") == false { return nil }
        if r.upperBound < t.endIndex, t[r.upperBound].isHexDigit { return nil }
        return String(t[r])
    }

    static func validate(_ p: [String: Any]) throws -> [String: Any] {
        let name = (p["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let handle = (p["handle"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let about = (p["about"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...60).contains(name.count) else { throw Services.error(400, "The name needs 1 to 60 characters.") }
        if !handle.isEmpty, handle.range(of: "^[a-z0-9_-]{3,30}$", options: .regularExpression) == nil {
            throw Services.error(400, "A handle is 3 to 30 characters: a–z, 0–9, _ and -.")
        }
        guard about.count <= 280 else { throw Services.error(400, "About is at most 280 characters.") }
        var out: [String: Any] = ["name": name, "findable": (p["findable"] as? Bool) ?? false]
        if !handle.isEmpty { out["handle"] = handle }
        if !about.isEmpty { out["about"] = about }
        return out
    }

    // MARK: - Calls

    func saveProfile(_ p: [String: Any]) async throws -> [String: Any] {
        let body = try Self.validate(p)
        let r = try await Services.call(Services.usersURL, "PUT", "/v1/profile", json: body, signed: true)
        return await MainActor.run {
            var saved = body
            for (k, v) in r where !(v is NSNull) { saved[k] = v }
            self.profile = saved
            self.active = true
            self.save()
            return self.status()
        }
    }

    func deleteProfile() async throws -> [String: Any] {
        _ = try await Services.call(Services.usersURL, "DELETE", "/v1/profile", signed: true)
        return await MainActor.run {
            self.profile = nil
            self.save()
            return self.status()
        }
    }

    func find(_ q: String) async throws -> [String: Any] {
        let text = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return ["profiles": []] }
        if let id = Self.normalize(text), text.filter({ $0.isHexDigit }).count >= 64 {
            // An exact id finds a findable profile only; adding by id works anyway.
            var hit: [[String: Any]] = []
            do { hit = [try await Services.call(Services.usersURL, "GET", "/v1/profiles/\(id)")] }
            catch let e as NSError where e.code == 404 { hit = [] }
            let found = hit
            return await MainActor.run { ["profiles": found.map(self.describe), "id": id] }
        }
        let r = try await Services.call(Services.usersURL, "GET", "/v1/find", query: ["q": text])
        let found = (r["profiles"] ?? r["items"] ?? r["results"]) as? [[String: Any]] ?? []
        return await MainActor.run { ["profiles": found.map(self.describe)] }
    }

    func add(_ raw: String, note: String?) async throws -> [String: Any] {
        guard let id = Self.normalize(raw) else { throw Services.error(400, "An app id is 64 hexadecimal characters.") }
        guard id != AppIdentity.shared.id else { throw Services.error(400, "That is this app's own id.") }
        var body: [String: Any] = ["id": id]
        if let note, !note.isEmpty { body["note"] = String(note.prefix(280)) }
        _ = try await Services.call(Services.usersURL, "POST", "/v1/contacts", json: body, signed: true)
        await MainActor.run { self.active = true }
        return try await refresh()
    }

    func remove(_ id: String) async throws -> [String: Any] {
        _ = try await Services.call(Services.usersURL, "DELETE", "/v1/contacts/\(id)", signed: true)
        return try await refresh()
    }

    /// GET /v1/contacts (signed): the list with each one's state.
    @discardableResult
    func refresh() async throws -> [String: Any] {
        let r = try await Services.call(Services.usersURL, "GET", "/v1/contacts", signed: true)
        let list = (r["contacts"] ?? r["items"]) as? [[String: Any]] ?? []
        return await MainActor.run {
            let known = Dictionary(self.contacts.compactMap { c in (c["id"] as? String).map { ($0, c) } }, uniquingKeysWith: { a, _ in a })
            self.contacts = list.compactMap { c in
                guard let id = c["id"] as? String else { return nil }
                var o = c.filter { !($0.value is NSNull) }
                if o["name"] == nil, let n = known[id]?["name"] { o["name"] = n }
                return o
            }
            self.active = true
            self.save()
            return self.status()
        }
    }

    /// The router's inbox since the last call: notifies incoming and mutual, then refreshes.
    @discardableResult
    func poll() async throws -> [String: Any] {
        await MainActor.run { self.polling = true }
        defer { DispatchQueue.main.async { self.polling = false } }
        var events: [[String: Any]] = []
        for _ in 0..<20 {                              // at most 100 per call, `more` while there are more
            let r = try await Services.call(Services.usersURL, "GET", "/v1/router/inbox", signed: true)
            events += (r["events"] ?? r["items"]) as? [[String: Any]] ?? []
            guard (r["more"] as? Bool) == true else { break }
        }
        let got = events
        if !got.isEmpty { try? await refresh() }
        return await MainActor.run {
            let events = got
            self.lastCheck = Date()
            for e in events {
                guard let type = e["type"] as? String, let id = e["id"] as? String else { continue }
                let c = self.contacts.first { ($0["id"] as? String) == id }
                var ev: [String: Any] = ["type": "people", "what": type, "id": id, "short": AppIdentity.short(id)]
                if let n = c?["name"] as? String { ev["name"] = n }
                if let n = e["note"] as? String, !n.isEmpty { ev["note"] = n }
                if let at = e["at"] { ev["at"] = at }
                self.recent.append(ev)
                self.emit(ev)
            }
            if self.recent.count > 30 { self.recent.removeFirst(self.recent.count - 30) }
            self.save()
            var st = self.status()
            st["events"] = events
            return st
        }
    }

    // MARK: - For the page

    func describe(_ p: [String: Any]) -> [String: Any] {
        var o = p.filter { !($0.value is NSNull) }
        if let id = p["id"] as? String {
            o["short"] = AppIdentity.short(id)
            if let c = contacts.first(where: { ($0["id"] as? String) == id }) { o["state"] = c["state"] }
            if id == AppIdentity.shared.id { o["self"] = true }
        }
        return o
    }

    func identity() -> [String: Any] {
        guard let id = AppIdentity.shared.id else { return ["error": "The app id could not be created (Keychain)."] }
        return ["id": id, "short": AppIdentity.short(id)]
    }

    func status() -> [String: Any] {
        var o = identity()
        o["profile"] = profile ?? NSNull()
        o["contacts"] = contacts.map { c -> [String: Any] in
            var x = describe(c)
            x["verified"] = (c["state"] as? String) == "mutual"
            return x
        }
        o["recent"] = Array(recent.suffix(10))
        o["base"] = Services.usersURL
        if let d = lastCheck { o["lastCheck"] = Services.iso(d) }
        return o
    }

    // MARK: - Storage

    private func load() {
        guard let data = try? Data(contentsOf: file), let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        profile = o["profile"] as? [String: Any]
        contacts = o["contacts"] as? [[String: Any]] ?? []
        recent = o["recent"] as? [[String: Any]] ?? []
        active = (o["active"] as? Bool) ?? false
        lastCheck = Services.date(o["lastCheck"])
    }

    private func save() {
        var o: [String: Any] = ["contacts": contacts, "recent": recent, "active": active]
        if let p = profile { o["profile"] = p }
        if let d = lastCheck { o["lastCheck"] = Services.iso(d) }
        if let data = try? JSONSerialization.data(withJSONObject: o) { try? data.write(to: file, options: .atomic) }
    }

    // MARK: - The `people` endpoint

    func handle(_ input: [String: Any], send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        let op = input["op"] as? String ?? "status"
        func run(_ work: @escaping () async throws -> [String: Any]) {
            Task {
                do { let r = try await work(); await MainActor.run { send(r) } }
                catch { await MainActor.run { fail(error.localizedDescription) } }
            }
        }
        switch op {
        case "identity": send(identity())
        case "status": send(status())
        case "open":                                  // People was opened: refresh and check the inbox
            active = true
            save()
            run {
                do { _ = try await self.poll(); return try await self.refresh() }
                catch { return await MainActor.run { var s = self.status(); s["offline"] = error.localizedDescription; return s } }
            }
        case "profile": run { try await self.saveProfile(input["profile"] as? [String: Any] ?? input) }
        case "deleteProfile": run { try await self.deleteProfile() }
        case "find": run { try await self.find(input["q"] as? String ?? "") }
        case "add": run { try await self.add(input["id"] as? String ?? "", note: input["note"] as? String) }
        case "remove": run { try await self.remove(input["id"] as? String ?? "") }
        case "contacts": run { try await self.refresh() }
        case "inbox": run { try await self.poll() }
        default: fail("unknown op \(op)")
        }
    }
}
