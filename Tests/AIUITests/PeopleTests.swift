import XCTest
@testable import AIUI

private let peopleOther = String(repeating: "ab", count: 32)
private let peopleThird = String(repeating: "cd", count: 32)

final class PeopleTests: AIUITestCase {

    private func people(_ dir: URL = TestEnv.tempDir("people")) -> People { People(dir: dir) }

    private func run<T>(_ body: @escaping () async throws -> T) -> Result<T, Error> { SharedTestKit.wait(self, body) }

    private func handle(_ p: People, _ input: [String: Any]) -> (sent: [String: Any]?, failed: String?) {
        var sent: [String: Any]?, failed: String?
        p.handle(input, send: { sent = $0 }, fail: { failed = $0 })
        waitUntil { sent != nil || failed != nil }
        return (sent, failed)
    }

    // MARK: Ids and validation

    func testNormalize() {
        XCTAssertEqual(People.normalize(peopleOther.uppercased()), peopleOther)
        XCTAssertEqual(People.normalize("aiui:" + peopleOther), peopleOther)
        XCTAssertEqual(People.normalize(" " + peopleOther.prefix(10) + "-" + peopleOther.dropFirst(10) + " "), peopleOther)
        XCTAssertNil(People.normalize("short"))
        XCTAssertNil(People.normalize("f" + peopleOther))       // 65 hex: not exactly one id
        XCTAssertNil(People.normalize(peopleOther + "0"))
        XCTAssertEqual(People.normalize("x:f" + peopleOther.dropLast()), "f" + peopleOther.dropLast())
    }

    func testValidate() throws {
        let ok = try People.validate(["name": "  Ann ", "handle": " ANN_1 ", "about": " hi ", "findable": true])
        XCTAssertEqual(ok["name"] as? String, "Ann")
        XCTAssertEqual(ok["handle"] as? String, "ann_1")
        XCTAssertEqual(ok["about"] as? String, "hi")
        XCTAssertEqual(ok["findable"] as? Bool, true)
        let bare = try People.validate(["name": "B"])
        XCTAssertNil(bare["handle"]); XCTAssertNil(bare["about"]); XCTAssertEqual(bare["findable"] as? Bool, false)
        XCTAssertThrowsError(try People.validate([:])) { XCTAssertTrue($0.localizedDescription.contains("1 to 60")) }
        XCTAssertThrowsError(try People.validate(["name": "A", "handle": "a!"])) { XCTAssertTrue($0.localizedDescription.contains("handle")) }
        XCTAssertThrowsError(try People.validate(["name": "A", "about": String(repeating: "x", count: 281)])) { XCTAssertTrue($0.localizedDescription.contains("280")) }
    }

    // MARK: Calls

    func testProfileSaveAndDeletePersist() throws {
        let dir = TestEnv.tempDir("people")
        let p = people(dir)
        MockURL.on("users.test/v1/profile", method: "PUT") { r in
            XCTAssertEqual(MockURL.json(of: r)["name"] as? String, "Ann")
            XCTAssertNotNil(r.value(forHTTPHeaderField: "X-AIUI-Signature"))
            return .json(["handle": "ann", "updated": "2026-01-01T00:00:00Z", "about": NSNull()])
        }
        let st = try run { try await p.saveProfile(["name": "Ann", "handle": "ann"]) }.get()
        XCTAssertEqual((st["profile"] as? [String: Any])?["updated"] as? String, "2026-01-01T00:00:00Z")
        XCTAssertEqual(p.profile?["name"] as? String, "Ann")
        XCTAssertNil(p.profile?["about"])
        XCTAssertEqual(st["id"] as? String, AppIdentity.shared.id)
        XCTAssertEqual(st["base"] as? String, "https://users.test")
        // Reloaded from disk.
        XCTAssertEqual(People(dir: dir).profile?["handle"] as? String, "ann")

        MockURL.on("users.test/v1/profile", method: "DELETE", .json([:]))
        let gone = try run { try await p.deleteProfile() }.get()
        XCTAssertTrue(gone["profile"] is NSNull)
        XCTAssertNil(People(dir: dir).profile)
        XCTAssertNotNil(run { try await p.saveProfile([:]) }.failed)
    }

    func testFind() throws {
        let p = people()
        XCTAssertEqual((try run { try await p.find("  ") }.get()["profiles"] as? [Any])?.count, 0)

        MockURL.on("users.test/v1/find", .json(["profiles": [["id": peopleOther, "name": "Bo", "about": NSNull()]]]))
        let r = try run { try await p.find("bo") }.get()
        let first = (r["profiles"] as? [[String: Any]])?.first
        XCTAssertEqual(first?["short"] as? String, AppIdentity.short(peopleOther))
        XCTAssertNil(first?["about"])
        XCTAssertEqual(MockURL.seen.last?.url.query, "q=bo")
        MockURL.on("users.test/v1/find", .json(["items": [["name": "NoId"]]]))
        XCTAssertEqual((try run { try await p.find("x") }.get()["profiles"] as? [[String: Any]])?.first?["name"] as? String, "NoId")
        MockURL.on("users.test/v1/find", .json(["results": [["id": AppIdentity.shared.id!]]]))
        XCTAssertEqual((try run { try await p.find("me") }.get()["profiles"] as? [[String: Any]])?.first?["self"] as? Bool, true)
        MockURL.on("users.test/v1/find", .json([:]))
        XCTAssertEqual((try run { try await p.find("none") }.get()["profiles"] as? [Any])?.count, 0)

        // By id: an exact profile, or none.
        MockURL.on("users.test/v1/profiles/\(peopleOther)", .json(["id": peopleOther, "name": "Bo"]))
        let byId = try run { try await p.find("aiui:" + peopleOther) }.get()
        XCTAssertEqual(byId["id"] as? String, peopleOther)
        XCTAssertEqual((byId["profiles"] as? [[String: Any]])?.first?["name"] as? String, "Bo")
        MockURL.on("users.test/v1/profiles/\(peopleOther)", .json(["error": "no"], status: 404))
        XCTAssertEqual((try run { try await p.find(peopleOther) }.get()["profiles"] as? [Any])?.count, 0)
        MockURL.on("users.test/v1/profiles/\(peopleOther)", .json(["error": "down"], status: 500))
        XCTAssertEqual(run { try await p.find(peopleOther) }.failed?.localizedDescription, "down")
    }

    func testAddRemoveRefresh() throws {
        let dir = TestEnv.tempDir("people")
        let p = people(dir)
        XCTAssertTrue(run { try await p.add("nope", note: nil) }.failed?.localizedDescription.contains("64 hexadecimal") == true)
        XCTAssertTrue(run { try await p.add(AppIdentity.shared.id!, note: nil) }.failed?.localizedDescription.contains("own id") == true)

        var contacts: [[String: Any]] = [["id": peopleOther, "state": "pending", "name": "Bo"]]
        MockURL.on("users.test/v1/contacts", method: "GET") { _ in .json(["contacts": contacts]) }
        MockURL.on("users.test/v1/contacts", method: "POST") { r in
            let b = MockURL.json(of: r)
            contacts.append(["id": b["id"]!, "state": "pending", "note": b["note"] ?? NSNull()])
            return .json(["ok": true])
        }
        let st = try run { try await p.add(peopleThird.uppercased(), note: String(repeating: "n", count: 300)) }.get()
        let body = try JSONSerialization.jsonObject(with: MockURL.seen.first { $0.method == "POST" }!.body) as! [String: Any]
        XCTAssertEqual(body["id"] as? String, peopleThird)
        XCTAssertEqual((body["note"] as? String)?.count, 280)
        let list = st["contacts"] as! [[String: Any]]
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list.first { $0["id"] as? String == peopleThird }?["verified"] as? Bool, false)
        XCTAssertEqual((list.first { $0["id"] as? String == peopleThird }?["note"] as? String)?.count, 280)

        // A refresh keeps a known name when the server omits it; entries without id are dropped.
        contacts = [["id": peopleOther, "state": "mutual"], ["state": "x"]]
        let r = try run { try await p.refresh() }.get()
        let bo = (r["contacts"] as! [[String: Any]]).first!
        XCTAssertEqual(bo["name"] as? String, "Bo")
        XCTAssertEqual(bo["verified"] as? Bool, true)
        XCTAssertEqual(bo["state"] as? String, "mutual")
        XCTAssertEqual(p.contacts.count, 1)

        MockURL.on("users.test/v1/contacts/\(peopleOther)", method: "DELETE") { _ in contacts = []; return .json([:]) }
        XCTAssertEqual((try run { try await p.remove(peopleOther) }.get()["contacts"] as? [Any])?.count, 0)
        XCTAssertEqual(People(dir: dir).contacts.count, 0)

        // `items` instead of `contacts`; an empty note isn't sent.
        MockURL.on("users.test/v1/contacts", method: "GET", .json(["items": [["id": peopleOther]]]))
        _ = try run { try await p.add(peopleOther, note: "") }.get()
        let last = try JSONSerialization.jsonObject(with: MockURL.seen.last { $0.method == "POST" }!.body) as! [String: Any]
        XCTAssertNil(last["note"])
        XCTAssertEqual(p.contacts.count, 1)
        MockURL.on("users.test/v1/contacts", method: "GET", .json([:]))
        _ = try run { try await p.refresh() }.get()
        XCTAssertEqual(p.contacts.count, 0)
    }

    func testPollPagesNotifiesAndPersists() throws {
        let dir = TestEnv.tempDir("people")
        let p = people(dir)
        var emitted: [[String: Any]] = []
        p.emit = { emitted.append($0) }
        var page = 0
        MockURL.on("users.test/v1/router/inbox") { _ in
            page += 1
            if page == 1 {
                return .json(["events": [["type": "incoming", "id": peopleOther, "note": "hi", "at": "t1"],
                                         ["type": "bad"]], "more": true])
            }
            return .json(["items": [["type": "mutual", "id": peopleThird, "note": ""]], "more": false])
        }
        MockURL.on("users.test/v1/contacts", method: "GET", .json(["contacts": [["id": peopleOther, "name": "Bo", "state": "incoming"]]]))
        let st = try run { try await p.poll() }.get()
        XCTAssertEqual(page, 2)
        XCTAssertEqual((st["events"] as? [Any])?.count, 3)
        XCTAssertEqual(emitted.count, 2)
        XCTAssertEqual(emitted[0]["what"] as? String, "incoming")
        XCTAssertEqual(emitted[0]["name"] as? String, "Bo")
        XCTAssertEqual(emitted[0]["note"] as? String, "hi")
        XCTAssertEqual(emitted[0]["at"] as? String, "t1")
        XCTAssertEqual(emitted[1]["what"] as? String, "mutual")
        XCTAssertNil(emitted[1]["note"]); XCTAssertNil(emitted[1]["name"])
        XCTAssertNotNil(st["lastCheck"])
        XCTAssertEqual((st["recent"] as? [Any])?.count, 2)

        // Kept on disk: recent and the last check.
        let again = People(dir: dir)
        XCTAssertNotNil(again.lastCheck)
        XCTAssertEqual((again.status()["recent"] as? [Any])?.count, 2)

        // Recent holds at most 30; an empty inbox doesn't refresh.
        MockURL.on("users.test/v1/router/inbox", .json(["events": (0..<40).map { _ in ["type": "incoming", "id": peopleOther] }]))
        _ = try run { try await p.poll() }.get()
        XCTAssertEqual((People(dir: dir).status()["recent"] as? [Any])?.count, 10)  // status shows the last 10
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("people.json"))) as! [String: Any]
        XCTAssertEqual((saved["recent"] as? [Any])?.count, 30)
        let n = MockURL.seen.count
        MockURL.on("users.test/v1/router/inbox", .json([:]))
        _ = try run { try await p.poll() }.get()
        XCTAssertEqual(MockURL.seen.count, n + 1)
        // The poll stops after 20 pages even when the server keeps saying `more`.
        MockURL.on("users.test/v1/router/inbox", .json(["events": [], "more": true]))
        let before = MockURL.seen.count
        _ = try run { try await p.poll() }.get()
        XCTAssertEqual(MockURL.seen.count - before, 20)
    }

    func testStartPollsWhenActive() throws {
        MockURL.on("users.test/v1/router/inbox", .json([:]))
        // Inactive: neither the first poll nor the timer reach the service.
        let idle = people()
        idle.pollInterval = 0.05; idle.firstPollDelay = 0.01
        idle.start()
        spin(0.2)
        XCTAssertTrue(MockURL.seen.isEmpty)
        // Active (People was opened in an earlier run): polled soon after start...
        let dir = TestEnv.tempDir("people")
        try JSONSerialization.data(withJSONObject: ["active": true]).write(to: dir.appendingPathComponent("people.json"))
        let soon = People(dir: dir)
        soon.pollInterval = 1000; soon.firstPollDelay = 0.01
        soon.start()
        waitUntil { MockURL.seen.count == 1 }
        // ...and on the timer.
        let timed = People(dir: dir)
        timed.pollInterval = 0.05; timed.firstPollDelay = 1000
        timed.start()
        waitUntil { MockURL.seen.count >= 2 }
        XCTAssertTrue(MockURL.seen.allSatisfy { $0.url.path == "/v1/router/inbox" })
    }

    func testIdentityAndStatus() {
        let p = people()
        let id = p.identity()
        XCTAssertEqual(id["id"] as? String, AppIdentity.shared.id)
        XCTAssertEqual(id["short"] as? String, AppIdentity.short(AppIdentity.shared.id!))
        let st = p.status()
        XCTAssertTrue(st["profile"] is NSNull)
        XCTAssertNil(st["lastCheck"])
        XCTAssertEqual(p.describe(["name": "x"])["name"] as? String, "x")
    }

    func testLoadIgnoresBadFile() throws {
        let dir = TestEnv.tempDir("people")
        try Data("not json".utf8).write(to: dir.appendingPathComponent("people.json"))
        let p = People(dir: dir)
        XCTAssertNil(p.profile); XCTAssertTrue(p.contacts.isEmpty)
    }

    // MARK: The endpoint

    func testHandle() {
        let p = people()
        XCTAssertEqual(handle(p, ["op": "identity"]).sent?["id"] as? String, AppIdentity.shared.id)
        XCTAssertNotNil(handle(p, [:]).sent?["contacts"])
        XCTAssertEqual(handle(p, ["op": "nope"]).failed, "unknown op nope")

        // Open, offline: the status with the reason.
        let off = handle(p, ["op": "open"]).sent
        XCTAssertNotNil(off?["offline"])

        MockURL.on("users.test/v1/router/inbox", .json([:]))
        MockURL.on("users.test/v1/contacts", method: "GET", .json(["contacts": [["id": peopleOther, "state": "mutual"]]]))
        MockURL.on("users.test/v1/contacts", method: "POST", .json([:]))
        MockURL.on("users.test/v1/contacts/", method: "DELETE", .json([:]))
        MockURL.on("users.test/v1/profile", method: "PUT", .json([:]))
        MockURL.on("users.test/v1/profile", method: "DELETE", .json([:]))
        MockURL.on("users.test/v1/find", .json(["profiles": []]))
        XCTAssertEqual((handle(p, ["op": "open"]).sent?["contacts"] as? [Any])?.count, 1)
        XCTAssertEqual((handle(p, ["op": "profile", "profile": ["name": "Zed"]]).sent?["profile"] as? [String: Any])?["name"] as? String, "Zed")
        XCTAssertEqual((handle(p, ["op": "profile", "name": "Top"]).sent?["profile"] as? [String: Any])?["name"] as? String, "Top")
        XCTAssertTrue(handle(p, ["op": "deleteProfile"]).sent?["profile"] is NSNull)
        XCTAssertNotNil(handle(p, ["op": "find", "q": "z"]).sent?["profiles"])
        XCTAssertNotNil(handle(p, ["op": "add", "id": peopleThird, "note": "hey"]).sent?["contacts"])
        XCTAssertNotNil(handle(p, ["op": "remove", "id": peopleOther]).sent?["contacts"])
        XCTAssertNotNil(handle(p, ["op": "contacts"]).sent?["contacts"])
        XCTAssertNotNil(handle(p, ["op": "inbox"]).sent?["events"])
        XCTAssertNotNil(handle(p, ["op": "add"]).failed)
        XCTAssertTrue(MockURL.seen.contains { $0.method == "DELETE" && $0.url.path == "/v1/contacts/\(peopleOther)" })
    }
}
