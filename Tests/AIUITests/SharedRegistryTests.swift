import CryptoKit
import XCTest
@testable import AIUI

final class SharedRegistryTests: AIUITestCase {
    private var dir: URL!
    private var utils: Utilities!
    private var reg: SharedRegistry!
    private var emitted: [[String: Any]] = []

    override func setUp() {
        super.setUp()
        dir = TestEnv.tempDir("shared")
        utils = Utilities(dir: dir.appendingPathComponent("lib"))
        reg = makeRegistry()
        emitted = []
    }

    private func makeRegistry() -> SharedRegistry {
        let r = SharedRegistry(dir: dir, utilities: utils)
        r.emit = { [weak self] in self?.emitted.append($0) }
        return r
    }

    private func run<T>(_ body: @escaping () async throws -> T) -> Result<T, Error> { SharedTestKit.wait(self, body) }

    private func handle(_ input: [String: Any]) -> (sent: [String: Any]?, failed: String?) {
        var sent: [String: Any]?, failed: String?
        reg.handle(input, send: { sent = $0 }, fail: { failed = $0 })
        waitUntil { sent != nil || failed != nil }
        return (sent, failed)
    }

    private static func sha(_ d: Data) -> String { AppIdentity.hex(SHA256.hash(data: d)) }
    private static func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) }

    /// Loads the index with these items (a full sync).
    private func index(_ items: [[String: Any]]) {
        MockURL.on("shared.test/v1/index", .json(["items": items, "generated": "g0"]))
        XCTAssertNotNil(run { try await self.reg.sync(full: true) }.succeeded)
    }

    @discardableResult
    private func publish(_ name: String, kind: String = "js", role: String? = nil, code: String = "export const x = 1", path: [String] = ["tools"]) -> String {
        var m: [String: Any] = ["name": name, "kind": kind, "code": code, "path": path, "description": "d " + name, "usage": "u"]
        if let role { m["role"] = role }
        return utils.publish(from: ["publish": [m]]).first!
    }

    // MARK: Sync

    func testSyncPagesThenIncremental() throws {
        MockURL.on("shared.test/v1/index") { r in
            let q = r.url!.query ?? ""
            if q.contains("since=g1") { return .json(["items": [["id": "c", "kind": "util", "version": 2]], "removed": ["a"]]) }
            if q.contains("next=opaque") { return .json(["items": [["id": "d", "kind": "applet"]]]) }
            if q.contains("cursor=3") { return .json(["items": [["kind": "noid"]], "next": "opaque"]) }
            if q.contains("cursor=2") { return .json(["items": [["id": "c", "kind": "util"]], "next": "https://shared.test/v1/index?cursor=3"]) }
            return .json(["items": [["id": "a", "kind": "util"], ["id": "b", "kind": "component"]], "generated": "g1", "next": "/v1/index?cursor=2"])
        }
        let st = try run { try await self.reg.sync() }.get()
        XCTAssertEqual(Set(reg.items.keys), ["a", "b", "c", "d"])
        XCTAssertEqual(st["count"] as? Int, 4)
        XCTAssertEqual((st["kinds"] as? [String: Int])?["util"], 2)
        XCTAssertNotNil(st["syncedAt"])
        XCTAssertEqual(emitted.last?["what"] as? String, "synced")
        XCTAssertEqual(emitted.last?["added"] as? Int, 5)        // as received (one without id)
        XCTAssertEqual(MockURL.seen.count, 4)

        // Since the last `generated`: changes and withdrawn ids.
        _ = try run { try await self.reg.sync() }.get()
        XCTAssertEqual(Set(reg.items.keys), ["b", "c", "d"])
        XCTAssertEqual(SharedRegistry.int(reg.items["c"]?["version"]), 2)
        XCTAssertEqual(emitted.last?["removed"] as? Int, 1)

        // Kept on disk.
        let again = makeRegistry()
        XCTAssertEqual(Set(again.items.keys), ["b", "c", "d"])
        XCTAssertNotNil(again.syncedAt)

        MockURL.on("shared.test/v1/index", .json(["error": "down"], status: 503))
        XCTAssertEqual(run { try await self.reg.sync() }.failed?.localizedDescription, "down")
    }

    func testSyncWhileSyncingAnswersStatus() throws {
        var first = true
        MockURL.on("shared.test/v1/index") { _ in
            defer { first = false }
            var r = MockURL.Response.json(["items": [["id": "a"]]])
            if first { r.delay = 0.3 }
            return r
        }
        let slow = SharedTestKit.SyncBox()
        Task.detached { _ = try? await self.reg.sync(); slow.done = true }
        waitUntil { MockURL.seen.count == 1 }
        let st = try run { try await self.reg.sync() }.get()
        XCTAssertEqual(st["syncing"] as? Bool, true)
        XCTAssertEqual(MockURL.seen.count, 1)
        waitUntil { slow.done }
        XCTAssertEqual(reg.items.count, 1)
    }

    func testSyncIfDueAndStart() throws {
        MockURL.on("shared.test/v1/index", .json(["items": [["id": "a"]]]))
        reg.paused = { true }
        reg.syncIfDue()
        spin(0.1)
        XCTAssertTrue(MockURL.seen.isEmpty)
        reg.paused = { false }
        reg.firstSyncDelay = 0.01
        reg.checkEvery = 1000
        reg.start()
        waitUntil { self.reg.syncedAt != nil }
        XCTAssertEqual(MockURL.seen.count, 1)
        reg.syncIfDue()                          // synced just now: not due
        spin(0.1)
        XCTAssertEqual(MockURL.seen.count, 1)

        // The periodic check: due again once the index is old.
        try JSONSerialization.data(withJSONObject: ["items": [], "syncedAt": "2000-01-01T00:00:00Z"]).write(to: dir.appendingPathComponent("shared.json"))
        let old = makeRegistry()
        old.firstSyncDelay = 1000
        old.checkEvery = 0.05
        old.start()
        waitUntil { old.syncedAt.map { $0 > Date().addingTimeInterval(-60) } == true }
    }

    // MARK: Browsing

    func testOverviewStatusListMineUpdates() {
        let me = AppIdentity.shared.id!
        index([
            ["id": "w", "kind": "util", "name": "weather", "path": ["net"], "description": "Weather forecast", "usage": "lib.weather()", "version": 1, "adoptions": 2],
            ["id": "g", "kind": "component", "name": "gameKit", "title": "Game kit", "description": "games", "usage": "", "version": "3", "adoptions": 9, "updated": "2026-01-02"],
            ["id": "h", "kind": "component", "name": "other", "description": "games too", "adoptions": 9, "updated": "2026-01-03"],
            ["id": "m", "kind": "util", "name": "mine", "author": me, "version": 1],
            ["id": "old", "kind": "util", "name": "adopted", "version": 5],
            ["kind": "util", "name": "noid"],
        ])
        utils.adopt(path: ["x"], name: "adopted", kind: "js", role: nil, description: "", usage: "", code: "1", origin: "old", originVersion: 4)
        utils.adopt(path: ["x"], name: "adopted2", kind: "js", role: nil, description: "", usage: "", code: "1", origin: "gone", originVersion: 1)

        let ov = reg.overview(["the weather?"])!
        let lines = ov["items"] as! [String]
        XCTAssertEqual(lines.count, 3)
        XCTAssertTrue(lines[0].hasPrefix("net › weather (util, v1, 2 adoptions) — Weather forecast · usage: lib.weather() [shared:w]"), lines[0])
        XCTAssertTrue(lines[1].contains("[shared:g]") || lines[1].contains("[shared:h]"))
        XCTAssertFalse(lines.joined().contains("usage: ·"))
        XCTAssertEqual(reg.overview([], limit: 1).map { ($0["items"] as! [String]).count }, 1)
        XCTAssertNil(makeRegistryEmpty().overview(["x"]))

        let st = reg.status()
        XCTAssertEqual(st["count"] as? Int, 5)
        XCTAssertEqual(st["mine"] as? Int, 1)
        XCTAssertEqual(st["base"] as? String, "https://shared.test")
        let ups = reg.updates()
        XCTAssertEqual(ups.count, 1)
        XCTAssertEqual(ups.first?["adoptedVersion"] as? Int, 4)
        XCTAssertEqual(ups.first?["updateAvailable"] as? Bool, true)
        XCTAssertEqual(reg.mineItems().first?["mine"] as? Bool, true)

        XCTAssertEqual(reg.list(kind: "component", q: nil).map { $0["id"] as! String }, ["h", "g"])   // same adoptions: newest first
        XCTAssertEqual(reg.list(kind: "", q: "GAME kit").map { $0["id"] as! String }, ["g"])
        XCTAssertEqual(reg.list(kind: nil, q: "net weather").map { $0["id"] as! String }, ["w"])
        XCTAssertEqual(reg.list(kind: nil, q: nil, limit: 2).count, 2)
        XCTAssertEqual(reg.list(kind: nil, q: nil).first?["id"] as? String, "h")
    }

    private func makeRegistryEmpty() -> SharedRegistry {
        SharedRegistry(dir: TestEnv.tempDir("empty"), utilities: Utilities(dir: TestEnv.tempDir("emptylib")))
    }

    // MARK: Adopting

    private func serve(_ id: String, payload: Data, item: [String: Any]? = nil, sha: String? = nil) {
        var it = item ?? ["id": id, "kind": "util", "name": "thing", "path": ["p"], "version": 3]
        it["sha256"] = sha ?? Self.sha(payload).uppercased()
        MockURL.on("shared.test/v1/items/\(id)", method: "GET", .json(it))
        MockURL.on("shared.test/v1/items/\(id)/payload", .init(status: 200, body: payload))
    }

    func testPrepareRefusals() {
        // No review wired.
        let ok = Self.json(["code": "fetch('x')"])
        serve("i1", payload: ok)
        XCTAssertEqual((run { try await self.reg.prepare("i1") }.failed as NSError?)?.code, 503)
        // No sha in the item.
        MockURL.on("shared.test/v1/items/i2", .json(["id": "i2"]))
        XCTAssertEqual((run { try await self.reg.prepare("i2") }.failed as NSError?)?.code, 502)
        // Mismatch.
        serve("i3", payload: ok, sha: String(repeating: "0", count: 64))
        let mm = run { try await self.reg.prepare("i3") }.failed as NSError?
        XCTAssertEqual(mm?.code, 422)
        XCTAssertTrue(mm?.localizedDescription.contains("does not match") == true)
        // Too large.
        let big = Data(repeating: 32, count: SharedRegistry.payloadLimit + 1)
        serve("i4", payload: big)
        XCTAssertEqual((run { try await self.reg.prepare("i4") }.failed as NSError?)?.code, 413)
        // Not a JSON object.
        serve("i5", payload: Data("[1]".utf8))
        XCTAssertTrue((run { try await self.reg.prepare("i5") }.failed)?.localizedDescription.contains("not a JSON object") == true)
        // The review fails.
        reg.review = { _, done in done(.failure(Services.error(500, "AI down"))) }
        XCTAssertEqual(run { try await self.reg.prepare("i1") }.failed?.localizedDescription, "AI down")
    }

    func testPrepareAndAdoptModules() throws {
        var reviewed: [String: Any]?
        reg.review = { input, done in reviewed = input; done(.success(["verdict": "safe"])) }
        // A js + css module, found in the synced index without sha (fetched again).
        index([["id": "both", "kind": "component", "name": "card"]])
        let both = Self.json(["code": "export const card = 1", "css": ".card{}"])
        serve("both", payload: both, item: ["id": "both", "kind": "component", "name": "card", "path": ["ui"], "version": 2, "description": "Cards", "usage": "lib.card()"])
        let prep = try run { try await self.reg.prepare("both") }.get()
        XCTAssertEqual(prep["verified"] as? Bool, true)
        XCTAssertEqual(prep["size"] as? Int, both.count)
        XCTAssertEqual((prep["review"] as? [String: Any])?["verdict"] as? String, "safe")
        XCTAssertEqual(prep["code"] as? String, "export const card = 1\n\n/* css */\n.card{}")
        XCTAssertEqual((reviewed?["item"] as? [String: Any])?["name"] as? String, "card")
        XCTAssertEqual(reviewed?["truncated"] as? Bool, false)
        let sha = prep["sha256"] as! String

        XCTAssertEqual((run { try await self.reg.adopt("both", sha: "0") }.failed as NSError?)?.code, 409)
        MockURL.on("shared.test/v1/items/both/adopted", method: "POST", .json(["ok": true]))
        let out = try run { try await self.reg.adopt("both", sha: sha.uppercased()) }.get()
        let ids = out["ids"] as! [String]
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(utils.module(ids[0])?.role, "component")
        XCTAssertEqual(utils.module(ids[0])?.origin, "both")
        XCTAssertEqual(utils.module(ids[0])?.originVersion, 2)
        XCTAssertEqual(utils.module(ids[1])?.name, "cardCss")
        XCTAssertEqual(utils.module(ids[1])?.kind, "css")
        XCTAssertNotNil(MockURL.seen.first { $0.url.path == "/v1/items/both/adopted" }?.headers["X-AIUI-Signature"])
        XCTAssertEqual(emitted.last?["what"] as? String, "adopted")
        XCTAssertEqual((run { try await self.reg.adopt("both", sha: sha) }.failed as NSError?)?.code, 409)   // used up
        XCTAssertEqual(reg.describe(["id": "both", "version": 2])["adoptedVersion"] as? Int, 2)
        XCTAssertNil(reg.describe(["id": "both", "version": 2])["updateAvailable"])

        // A css-only util (the code only a comment) and a plain util; the adopted count may fail.
        let cssOnly = Self.json(["code": SharedRegistry.cssOnly, "css": ".x{}"])
        serve("css", payload: cssOnly, item: ["id": "css", "kind": "util", "version": 1])
        let p2 = try run { try await self.reg.prepare("css") }.get()
        let o2 = try run { try await self.reg.adopt("css", sha: p2["sha256"] as! String) }.get()
        XCTAssertEqual((o2["ids"] as! [String]).count, 1)
        XCTAssertEqual(utils.module((o2["ids"] as! [String])[0])?.name, "shared")
        XCTAssertEqual(utils.module((o2["ids"] as! [String])[0])?.kind, "css")

        let js = Self.json(["code": "function f(){}"])
        serve("js", payload: js, item: ["id": "js", "kind": "util", "name": "f", "version": 1])
        let p3 = try run { try await self.reg.prepare("js") }.get()
        let o3 = try run { try await self.reg.adopt("js", sha: p3["sha256"] as! String) }.get()
        XCTAssertEqual(utils.module((o3["ids"] as! [String])[0])?.role, "util")

        // No code at all.
        let none = Self.json(["code": "  /* */ "])
        serve("none", payload: none)
        let p4 = try run { try await self.reg.prepare("none") }.get()
        XCTAssertEqual((run { try await self.reg.adopt("none", sha: p4["sha256"] as! String) }.failed as NSError?)?.code, 422)
    }

    func testAdoptApplet() throws {
        reg.review = { input, done in
            XCTAssertEqual(input["code"] as? String, "<b>hi</b>")
            done(.success([:]))
        }
        var stored: (String, [String: Any], String)?
        reg.storeApplet = { t, s, o in stored = (t, s, o); return "k1" }
        let payload = Self.json(["html": "<b>hi</b>", "state": ["secret": 1], "message": "m"])
        serve("ap", payload: payload, item: ["id": "ap", "kind": "applet", "name": "hello", "title": "Hello", "version": 4])
        let p = try run { try await self.reg.prepare("ap") }.get()
        let out = try run { try await self.reg.adopt("ap", sha: p["sha256"] as! String) }.get()
        XCTAssertEqual(out["key"] as? String, "k1")
        XCTAssertEqual(out["title"] as? String, "Hello")
        XCTAssertEqual(stored?.0, "Hello")
        XCTAssertEqual(stored?.2, "ap")
        XCTAssertEqual(stored?.1["kind"] as? String, "html")
        XCTAssertNil(stored?.1["state"])
        // Remembered: an update is offered, and shareable() skips the adopted applet.
        let again = makeRegistry()
        again.storeApplet = reg.storeApplet
        XCTAssertEqual(again.describe(["id": "ap", "version": 5])["updateAvailable"] as? Bool, true)
        again.appletList = { [["key": "k1"], ["key": "k2"], ["key": "k3"]] }
        again.appletScreen = { $0 == "k3" ? nil : ["kind": "html"] }
        XCTAssertEqual((again.shareable()["applets"] as? [[String: Any]])?.map { $0["key"] as! String }, ["k2"])

        // An applet without a title takes the item's name.
        let p2 = Self.json(["html": "<i>x</i>"])
        reg.review = { _, done in done(.success([:])) }
        serve("ap2", payload: p2, item: ["id": "ap2", "kind": "applet", "name": "plain", "version": 1])
        let pp = try run { try await self.reg.prepare("ap2") }.get()
        XCTAssertEqual(try run { try await self.reg.adopt("ap2", sha: pp["sha256"] as! String) }.get()["title"] as? String, "plain")
    }

    func testAdoptRefusesChangedPayload() {
        let payload = Data("{}".utf8)
        reg.pending["x"] = (1, String(repeating: "a", count: 64), payload, [:])
        let e = run { try await self.reg.adopt("x", sha: String(repeating: "a", count: 64)) }.failed
        XCTAssertTrue(e?.localizedDescription.contains("no longer matches") == true)
    }

    func testReviewTruncatesLongCode() throws {
        var truncated: Bool?
        reg.review = { input, done in truncated = input["truncated"] as? Bool; done(.success([:])) }
        let payload = Self.json(["code": String(repeating: "x", count: 90_000)])
        serve("long", payload: payload)
        _ = try run { try await self.reg.prepare("long") }.get()
        XCTAssertEqual(truncated, true)
    }

    // MARK: Sharing

    func testShareableAndPreviewModules() throws {
        let a = publish("alpha")
        _ = utils.bundle([a, a])
        let css = publish("cardStyle", kind: "css", code: ".c{}", path: ["ui kit!"])
        let comp = publish("widget", role: "component")
        utils.adopt(path: ["x"], name: "theirs", kind: "js", role: nil, description: "", usage: "", code: "1", origin: "o1", originVersion: 1)
        reg.appletList = { [["key": "k"]] }
        reg.appletScreen = { _ in ["kind": "html", "html": "<p>"] }

        let sh = reg.shareable()
        let mods = sh["modules"] as! [[String: Any]]
        XCTAssertEqual(mods.count, 3)
        XCTAssertEqual(mods.first?["id"] as? String, a)               // most used first
        XCTAssertEqual(mods.first { $0["id"] as? String == css }?["role"] as? String, "component")
        XCTAssertEqual(mods.first { $0["id"] as? String == a }?["role"] as? String, "util")
        XCTAssertEqual((sh["applets"] as? [Any])?.count, 1)

        let pv = try reg.preview(["module": css])
        let body = pv["body"] as! [String: Any]
        XCTAssertEqual(body["kind"] as? String, "component")
        XCTAssertEqual(body["path"] as? [String], ["ui-kit"])
        XCTAssertEqual(body["title"] as? String, "Card Style")
        XCTAssertEqual((body["payload"] as? [String: Any])?["code"] as? String, SharedRegistry.cssOnly)
        XCTAssertEqual((body["payload"] as? [String: Any])?["css"] as? String, ".c{}")
        XCTAssertEqual(pv["author"] as? String, AppIdentity.shared.id)
        XCTAssertEqual((pv["warnings"] as? [String])?.count, 0)
        XCTAssertEqual((pv["strip"] as? [String])?.count, 0)
        XCTAssertEqual(pv["digest"] as? String, Self.sha(Self.json(body)))
        XCTAssertTrue((pv["json"] as? String)?.contains("\"kind\" : \"component\"") == true)
        XCTAssertEqual(try reg.preview(["module": comp])["body"].flatMap { ($0 as? [String: Any])?["kind"] as? String }, "component")
        XCTAssertEqual(((try reg.preview(["module": a])["body"] as? [String: Any])?["payload"] as? [String: Any])?["code"] as? String, "export const x = 1")

        // Refusals.
        XCTAssertThrowsError(try reg.preview(["module": "missing"])) { XCTAssertEqual(($0 as NSError).code, 404) }
        let theirs = utils.all.first { $0.origin == "o1" }!.id
        XCTAssertThrowsError(try reg.preview(["module": theirs])) { XCTAssertEqual(($0 as NSError).code, 403) }
        XCTAssertThrowsError(try reg.preview([:])) { XCTAssertEqual(($0 as NSError).code, 400) }
        XCTAssertThrowsError(try reg.preview(["scene": ["kind": "text", "html": "<p>"]])) { XCTAssertEqual(($0 as NSError).code, 404) }
        XCTAssertThrowsError(try reg.preview(["scene": ["kind": "html"]])) { XCTAssertEqual(($0 as NSError).code, 404) }

        // Too large: a warning in the preview, refused by share.
        let huge = publish("huge", code: String(repeating: "x", count: SharedRegistry.payloadLimit + 10))
        let hp = try reg.preview(["module": huge])
        XCTAssertTrue((hp["warnings"] as? [String])?.first?.contains("512 KB") == true)
        var input: [String: Any] = ["module": huge, "digest": hp["digest"]!]
        XCTAssertEqual((run { try await self.reg.share(input) }.failed as NSError?)?.code, 413)
        input["digest"] = "stale"
        XCTAssertEqual((run { try await self.reg.share(input) }.failed as NSError?)?.code, 409)
    }

    func testPreviewAndShareApplet() throws {
        let own = publish("ownHelper")
        let other = publish("sharedHelper")
        let adopted = utils.adopt(path: ["x"], name: "fromAfar", kind: "js", role: nil, description: "", usage: "", code: "1", origin: "G1", originVersion: 1)
        // `sharedHelper` was shared before: known as M1.
        MockURL.on("shared.test/v1/items", method: "POST") { r in
            let b = MockURL.json(of: r)
            return .json(["id": b["kind"] as? String == "applet" ? "A1" : "M1", "kind": b["kind"]!, "version": 1])
        }
        let mp = try reg.preview(["module": other])
        _ = try run { try await self.reg.share(["module": other, "digest": mp["digest"]!]) }.get()

        let screen: [String: Any] = ["kind": "html", "html": "<p>hi</p>", "state": ["x": 1], "libs": ["d3"],
                                     "uses": [own, other, adopted, "nowhere/x"], "shareable": ["strip": ["state"]]]
        reg.appletScreen = { $0 == "k" ? screen : nil }
        reg.appletList = { [["key": "k", "title": "My Tool!"]] }
        let pv = try reg.preview(["applet": "k"])
        let body = pv["body"] as! [String: Any]
        XCTAssertEqual(body["kind"] as? String, "applet")
        XCTAssertEqual(body["name"] as? String, "my-tool")
        XCTAssertEqual(body["title"] as? String, "My Tool!")
        XCTAssertEqual(body["description"] as? String, "My Tool!")
        XCTAssertEqual(body["libs"] as? [String], ["d3"])
        XCTAssertEqual(Set(body["uses"] as! [String]), ["M1", "G1"])
        XCTAssertNil(body["_unshared"])
        let payload = body["payload"] as! [String: Any]
        XCTAssertNil(payload["state"])
        XCTAssertEqual(payload["uses"] as? [String], ["tools/ownHelper", "tools/sharedHelper", "x/fromAfar", "nowhere/x"])
        XCTAssertEqual(pv["strip"] as? [String], ["state"])
        XCTAssertTrue((pv["warnings"] as? [String])?.first?.contains("tools/ownHelper") == true)

        let item = try run { try await self.reg.share(["applet": "k", "digest": pv["digest"]!]) }.get()
        XCTAssertEqual(item["mine"] as? Bool, true)
        let sent = try JSONSerialization.jsonObject(with: MockURL.seen.last { $0.method == "POST" }!.body) as! [String: Any]
        XCTAssertNil(sent["_unshared"])
        XCTAssertEqual(emitted.last?["what"] as? String, "shared")
        XCTAssertEqual(reg.mineItems().count, 2)

        // A scene on display (not stored), titled by its own title, described by the input.
        reg.appletList = { [] }
        let scene: [String: Any] = ["kind": "html", "html": "<p>", "title": "Live", "message": "msg"]
        let sp = try reg.preview(["scene": scene, "description": "desc"])
        XCTAssertEqual((sp["body"] as? [String: Any])?["description"] as? String, "desc")
        XCTAssertEqual(((try reg.preview(["scene": scene]))["body"] as? [String: Any])?["description"] as? String, "msg")
        XCTAssertEqual(((try reg.preview(["scene": ["kind": "html", "html": "<p>"]]))["body"] as? [String: Any])?["title"] as? String, "Applet")
        _ = try run { try await self.reg.share(["scene": scene, "description": "desc", "digest": sp["digest"]!]) }.get()

        // The server answers without an id: nothing recorded.
        MockURL.on("shared.test/v1/items", method: "POST", .json(["ok": true]))
        let n = reg.mineItems().count
        _ = try run { try await self.reg.share(["scene": scene, "description": "desc", "digest": sp["digest"]!]) }.get()
        XCTAssertEqual(reg.mineItems().count, n)
        XCTAssertEqual(emitted.last?["id"] as? String, "")
        // The module card shows what it was shared as.
        XCTAssertEqual(handle(["op": "module", "id": other]).sent?["sharedAs"] as? String, "M1")
    }

    func testWithdrawAndReport() throws {
        index([["id": "z", "kind": "util"]])
        MockURL.on("shared.test/v1/items/z", method: "DELETE", .json([:]))
        XCTAssertEqual(try run { try await self.reg.withdraw("z") }.get()["ok"] as? Bool, true)
        XCTAssertNil(reg.items["z"])
        XCTAssertNil(makeRegistry().items["z"])
        XCTAssertNotNil(MockURL.seen.last?.headers["X-AIUI-Signature"])

        XCTAssertEqual((run { try await self.reg.report("z", reason: "  ") }.failed as NSError?)?.code, 400)
        MockURL.on("shared.test/v1/items/z/report", method: "POST", .json([:]))
        XCTAssertEqual(try run { try await self.reg.report("z", reason: " " + String(repeating: "r", count: 1200)) }.get()["ok"] as? Bool, true)
        let body = try JSONSerialization.jsonObject(with: MockURL.seen.last!.body) as! [String: Any]
        XCTAssertEqual((body["reason"] as? String)?.count, 1000)
    }

    // MARK: Helpers

    func testHelpers() {
        XCTAssertEqual(Set(SharedRegistry.stripApplet(["kind": 1, "state": 2, "html": 3, "timeouts": 4]).keys), ["kind", "html", "timeouts"])
        XCTAssertEqual(SharedRegistry.readable(kind: "applet", ["html": "<p>"]), "<p>")
        XCTAssertEqual(SharedRegistry.readable(kind: "applet", [:]), "")
        XCTAssertEqual(SharedRegistry.readable(kind: "util", ["code": "", "css": ""]), "")
        XCTAssertEqual(SharedRegistry.readable(kind: "util", ["css": "a"]), "/* css */\na")
        XCTAssertEqual(SharedRegistry.scan("let a = 1"), [])
        XCTAssertEqual(SharedRegistry.scan("fetch ('https://x'); aiui.sys('ls'); eval(s); localStorage; parent.x; atob(y)"),
                       ["network requests", "external URLs or scripts", "system access (aiui.sys: shell, files, AppleScript)",
                        "runs generated code (eval / new Function)", "reads or writes browser storage", "talks to the hosting page",
                        "encoded or obfuscated strings"])
        XCTAssertEqual(SharedRegistry.safeName("my cool$tool!!"), "my-cool$tool")
        XCTAssertEqual(SharedRegistry.safeName("!!!"), "item")
        XCTAssertEqual(SharedRegistry.safeName(String(repeating: "a", count: 100)).count, 80)
        XCTAssertEqual(SharedRegistry.safePath([]), ["misc"])
        XCTAssertEqual(SharedRegistry.safePath(["!!", "a b", String(repeating: "c", count: 50)]), ["a-b", String(repeating: "c", count: 40)])
        XCTAssertEqual(SharedRegistry.safePath((0..<10).map { "s\($0)" }).count, 8)
        XCTAssertEqual(SharedRegistry.title("gameKitPro"), "Game Kit Pro")
        XCTAssertEqual(SharedRegistry.title(""), "")
        XCTAssertEqual(SharedRegistry.int(NSNumber(value: 3)), 3)
        XCTAssertEqual(SharedRegistry.int("7"), 7)
        XCTAssertEqual(SharedRegistry.int("x"), 0)
        XCTAssertEqual(SharedRegistry.int(nil), 0)
        XCTAssertTrue(Prompts.sharedReview.contains("verdict"))
        XCTAssertTrue(Prompts.sharedReviewSchema.contains("\"verdict\""))
    }

    func testLoadIgnoresBadFile() throws {
        try Data("nope".utf8).write(to: dir.appendingPathComponent("shared.json"))
        XCTAssertTrue(makeRegistry().items.isEmpty)
    }

    // MARK: The endpoint

    func testHandle() throws {
        index([["id": "a", "kind": "util", "name": "alpha", "version": 1]])
        XCTAssertEqual(handle([:]).sent?["count"] as? Int, 1)
        XCTAssertEqual(handle(["op": "nope"]).failed, "unknown op nope")
        MockURL.on("shared.test/v1/index", .json(["items": [["id": "b"]]]))
        XCTAssertEqual(handle(["op": "sync", "full": true]).sent?["count"] as? Int, 1)
        index([["id": "a", "kind": "util", "name": "alpha", "version": 1]])
        XCTAssertEqual((handle(["op": "list", "kind": "util", "q": "alp"]).sent?["items"] as? [Any])?.count, 1)
        XCTAssertNotNil(handle(["op": "mine"]).sent?["items"])
        XCTAssertNotNil(handle(["op": "updates"]).sent?["items"])

        // Search: remote, else the local index.
        MockURL.on("shared.test/v1/search", .json(["items": [["id": "r"]]]))
        let remote = handle(["op": "search", "q": "x", "kind": "util"]).sent!
        XCTAssertEqual(remote["remote"] as? Bool, true)
        XCTAssertEqual(MockURL.seen.last?.url.query, "kind=util&q=x")
        MockURL.on("shared.test/v1/search", .json([:]))
        XCTAssertEqual((handle(["op": "search", "q": "x", "kind": ""]).sent?["items"] as? [Any])?.count, 0)
        XCTAssertEqual(MockURL.seen.last?.url.query, "q=x")
        MockURL.on("shared.test/v1/search", .json(["error": "down"], status: 500))
        let local = handle(["op": "search", "q": "alpha"]).sent!
        XCTAssertEqual(local["remote"] as? Bool, false)
        XCTAssertEqual(local["error"] as? String, "down")
        XCTAssertEqual((local["items"] as? [Any])?.count, 1)

        // Item: from the index, else fetched.
        XCTAssertEqual((handle(["op": "item", "id": "a"]).sent?["item"] as? [String: Any])?["name"] as? String, "alpha")
        MockURL.on("shared.test/v1/items/q", .json(["id": "q", "name": "remote"]))
        XCTAssertEqual((handle(["op": "item", "id": "q"]).sent?["item"] as? [String: Any])?["name"] as? String, "remote")
        XCTAssertNotNil(handle(["op": "item", "id": "missing"]).failed)

        XCTAssertNotNil(handle(["op": "prepare", "id": "missing"]).failed)
        XCTAssertNotNil(handle(["op": "adopt", "id": "a"]).failed)
        XCTAssertNotNil(handle(["op": "shareable"]).sent?["modules"])

        // A module's card.
        XCTAssertEqual(handle(["op": "module", "id": "nope"]).failed, "That module is not in the library.")
        let own = publish("own", kind: "css", code: ".o{}")
        let card = handle(["op": "module", "id": own]).sent!
        XCTAssertEqual(card["role"] as? String, "component")
        XCTAssertEqual(card["code"] as? String, ".o{}")
        XCTAssertNil(card["origin"])
        let ad = utils.adopt(path: ["x"], name: "ad", kind: "js", role: "util", description: "", usage: "", code: "1", origin: "a", originVersion: 1)
        let adCard = handle(["op": "module", "id": ad]).sent!
        XCTAssertEqual(adCard["origin"] as? String, "a")
        XCTAssertEqual(adCard["originVersion"] as? Int, 1)
        XCTAssertEqual((adCard["originItem"] as? [String: Any])?["name"] as? String, "alpha")
        let ad2 = utils.adopt(path: ["x"], name: "ad2", kind: "js", role: nil, description: "", usage: "", code: "1", origin: "zz", originVersion: 1)
        XCTAssertNil(handle(["op": "module", "id": ad2]).sent?["originItem"])
        XCTAssertEqual(handle(["op": "module", "id": ad2]).sent?["role"] as? String, "util")

        // Preview, share, withdraw, report.
        let pv = handle(["op": "preview", "module": own]).sent!
        XCTAssertNotNil(pv["digest"])
        XCTAssertNotNil(handle(["op": "preview"]).failed)
        MockURL.on("shared.test/v1/items", method: "POST", .json(["id": "S"]))
        XCTAssertEqual(handle(["op": "share", "module": own, "digest": pv["digest"]!]).sent?["id"] as? String, "S")
        MockURL.on("shared.test/v1/items/S", method: "DELETE", .json([:]))
        XCTAssertEqual(handle(["op": "withdraw", "id": "S"]).sent?["ok"] as? Bool, true)
        XCTAssertEqual(handle(["op": "report", "id": "S"]).failed, "Say what is wrong with it.")
    }
}

extension SharedTestKit {
    final class SyncBox: @unchecked Sendable { var done = false }
}
