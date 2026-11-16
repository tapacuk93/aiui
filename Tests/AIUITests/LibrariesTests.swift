import XCTest
@testable import AIUI

final class LibrariesTests: AIUITestCase {
    var dir: URL!
    var src: URL!
    private var savedCapacity = Libraries.availableCapacity

    override func setUp() {
        super.setUp()
        dir = TestEnv.tempDir("libs")
        src = TestEnv.tempDir("libsrc")
        savedCapacity = Libraries.availableCapacity
        Libraries.availableCapacity = { 105_000_000_000 }   // a 10 GB shared budget
        API.paused = false
    }

    override func tearDown() {
        Libraries.availableCapacity = savedCapacity
        API.paused = false
        super.tearDown()
    }

    // MARK: helpers

    func lib(_ id: String, priority: Int = 50, bytes: Int = 100, global: String? = "G", category: String = "charts",
             desc: String = "a library", type: String = "js", files: [[String: Any]]? = nil) -> [String: Any] {
        var e: [String: Any] = ["id": id, "version": "1.0", "category": category, "description": desc, "priority": priority, "bytes": bytes,
                                "files": files ?? [["url": "https://cdn.test/\(id)/\(Libraries.folder(id)).\(type)",
                                                    "name": "\(Libraries.folder(id)).\(type)", "type": type, "bytes": bytes]]]
        if let global { e["global"] = global }
        return e
    }

    func url(_ e: [String: Any]) -> String { ((e["files"] as! [[String: Any]])[0]["url"] as! String) }

    func serve(_ e: [String: Any], _ text: String = "window.x = 1;", delay: TimeInterval = 0) {
        MockURL.on(url(e), MockURL.Response(body: Data(text.utf8), delay: delay))
    }

    func catalogFile(_ libs: [[String: Any]]) -> URL {
        let f = src.appendingPathComponent("libraries-\(UUID().uuidString).json")
        try! JSONSerialization.data(withJSONObject: ["libraries": libs]).write(to: f)
        return f
    }

    func make(_ libs: [[String: Any]]) -> Libraries { Libraries(dir: dir, catalogFile: catalogFile(libs)) }

    func install(_ l: Libraries, _ id: String, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        var result: Bool?
        l.install(id) { result = $0 }
        waitUntil(10, file: file, line: line) { result != nil }
        return result ?? false
    }

    func ensure(_ l: Libraries, _ ids: [String]) -> [[String: String]] {
        var tags: [[String: String]]?
        l.ensure(ids) { tags = $0 }
        waitUntil(10) { tags != nil }
        return tags ?? []
    }

    func rows(_ l: Libraries) -> [String: [String: Any]] {
        Dictionary(uniqueKeysWithValues: (l.list()["libraries"] as! [[String: Any]]).map { ($0["id"] as! String, $0) })
    }

    func writeState(_ list: [Libraries.Installed]) {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        try! enc.encode(list).write(to: dir.appendingPathComponent("installed.json"))
        for i in list { try? FileManager.default.createDirectory(at: dir.appendingPathComponent(Libraries.folder(i.id)), withIntermediateDirectories: true) }
    }

    static func installed(_ id: String, bytes: Int = 100, lastUsed: Date = Date()) -> Libraries.Installed {
        .init(id: id, version: "1.0", files: ["\(id).js"], bytes: bytes, installed: Date(), lastUsed: lastUsed, uses: 0)
    }

    // MARK: catalog and housekeeping

    func testInitMergesExtrasDropsJunkAndLeftovers() throws {
        let fm = FileManager.default
        let catalog = [lib("chart"), lib("@scope/pkg"), lib("google-analytics"), lib("nice", desc: "tracking pixels")]
        try JSONSerialization.data(withJSONObject: [lib("chart", desc: "duplicate"), lib("extra1")])
            .write(to: dir.appendingPathComponent("catalog-extra.json"))
        writeState([Self.installed("chart"), Self.installed("@scope/pkg"), Self.installed("dropped")])
        let staleState = Self.installed("extra1")   // in the state, but its folder is gone
        var all = try JSONDecoder.iso.decode([Libraries.Installed].self, from: Data(contentsOf: dir.appendingPathComponent("installed.json")))
        all.append(staleState)
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        try enc.encode(all).write(to: dir.appendingPathComponent("installed.json"))
        for leftover in [".chart-123", "@old"] { try fm.createDirectory(at: dir.appendingPathComponent(leftover), withIntermediateDirectories: true) }

        let l = make(catalog)
        let r = rows(l)
        XCTAssertEqual(Set(r.keys), ["chart", "@scope/pkg", "extra1"])
        XCTAssertEqual(r["chart"]?["description"] as? String, "a library")   // the bundled entry wins
        XCTAssertEqual(r["chart"]?["installed"] as? Bool, true)
        XCTAssertEqual(r["@scope/pkg"]?["installed"] as? Bool, true)
        XCTAssertEqual(r["extra1"]?["installed"] as? Bool, false)
        XCTAssertFalse(fm.fileExists(atPath: dir.appendingPathComponent("dropped").path))
        XCTAssertFalse(fm.fileExists(atPath: dir.appendingPathComponent(".chart-123").path))
        XCTAssertFalse(fm.fileExists(atPath: dir.appendingPathComponent("@old").path))
        // Regression: a scoped package's flat folder survives a relaunch with its files.
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("@scope__pkg").path))
        XCTAssertEqual(make(catalog).list()["used"] as? Int, 200)

        XCTAssertTrue((Libraries(dir: TestEnv.tempDir(), catalogFile: nil).list()["libraries"] as! [Any]).isEmpty)
        let junkFile = src.appendingPathComponent("bad.json")
        try "nope".write(to: junkFile, atomically: true, encoding: .utf8)
        XCTAssertTrue((Libraries(dir: TestEnv.tempDir(), catalogFile: junkFile).list()["libraries"] as! [Any]).isEmpty)
    }

    func testStatics() {
        XCTAssertTrue(Libraries.isJunk("Google Analytics helper"))
        XCTAssertTrue(Libraries.isJunk("ads"))
        XCTAssertFalse(Libraries.isJunk("three.js 3D scenes"))
        XCTAssertEqual(Libraries.folder("@scope/name"), "@scope__name")
        XCTAssertEqual(Libraries.folder("plain"), "plain")
        XCTAssertGreaterThanOrEqual(savedCapacity(), 0)   // the real volume query
        Libraries.availableCapacity = { 4_999_999_999 }
        XCTAssertEqual(Libraries.sharedBudget, 0)
        Libraries.availableCapacity = { 25_000_000_000 }
        XCTAssertEqual(Libraries.sharedBudget, 2_000_000_000)
        Libraries.availableCapacity = { 500_000_000_000 }
        XCTAssertEqual(Libraries.sharedBudget, 10_000_000_000)
    }

    func testBudget() {
        let l = make([])
        XCTAssertEqual(l.budget, 10_000_000_000)
        l.cacheBytes = { 1_000 }
        XCTAssertEqual(l.budget, 9_999_999_000)
        UserDefaults.standard.set(2.0, forKey: "budgetGB")
        XCTAssertEqual(l.budget, 1_999_999_000)
        l.cacheBytes = { 50_000_000_000 }
        XCTAssertEqual(l.budget, 0)
        XCTAssertEqual(l.list()["budget"] as? Int, 0)
    }

    // MARK: install / remove

    func testInstallRemoveAndFilePath() {
        let chart = lib("chart"), nofiles: [String: Any] = ["id": "nofiles", "description": "x"]
        let l = make([chart, nofiles])
        serve(chart, "window.Chart = {};")
        var a: Bool?, b: Bool?
        l.install("chart") { a = $0 }
        l.install("chart") { b = $0 }
        XCTAssertEqual(l.list()["installing"] as? [String], ["chart"])
        waitUntil { a != nil && b != nil }
        XCTAssertEqual(a, true); XCTAssertEqual(b, true)
        XCTAssertEqual(MockURL.seen.filter { $0.url.absoluteString == self.url(chart) }.count, 1)
        XCTAssertEqual(MockURL.seen.first?.headers["User-Agent"], "aiui")
        let file = dir.appendingPathComponent("chart/chart.js")
        XCTAssertEqual(try? String(contentsOf: file, encoding: .utf8), "window.Chart = {};")
        XCTAssertEqual(l.used, 18)
        XCTAssertEqual(rows(l)["chart"]?["installed"] as? Bool, true)
        XCTAssertEqual(rows(l)["chart"]?["uses"] as? Int, 0)
        XCTAssertNotNil(rows(l)["chart"]?["lastUsed"] as? String)
        XCTAssertTrue(install(l, "chart"))   // already there
        XCTAssertFalse(install(l, "unknown"))
        XCTAssertFalse(install(l, "nofiles"))
        // Persisted.
        XCTAssertEqual(make([chart]).used, 18)

        XCTAssertEqual(l.filePath("chart/chart.js")?.path, file.standardizedFileURL.path)
        XCTAssertNil(l.filePath("../outside.js"))

        l.remove("chart")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("chart").path))
        XCTAssertEqual(rows(l)["chart"]?["installed"] as? Bool, false)
        XCTAssertEqual(make([chart]).used, 0)
    }

    func testInstallFailures() {
        let missing = lib("missing")
        let noName = lib("noname", files: [["url": "https://cdn.test/noname.js"]])
        let badName = lib("badname", files: [["url": "https://cdn.test/badname.js", "name": "sub/x.js"]])
        let second = lib("second", files: [["url": "https://cdn.test/s1.js", "name": "s1.js"], ["url": "https://cdn.test/s2.js", "name": "s2.js"]])
        let l = make([missing, noName, badName, second])
        MockURL.on(url(missing), .text("", status: 404))
        MockURL.on("cdn.test/badname.js", .text("x"))
        MockURL.on("cdn.test/s1.js", .text("x"))
        MockURL.on("cdn.test/s2.js", .fail())
        for id in ["missing", "noname", "badname", "second"] {
            XCTAssertFalse(install(l, id), id)
            XCTAssertEqual(rows(l)[id]?["installed"] as? Bool, false)
        }
        let left = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        XCTAssertEqual(left.filter { $0 != "installed.json" }, [])
    }

    // MARK: ensure

    func testEnsureTags() {
        writeState([Self.installed("have")])
        let have = lib("have"), get = lib("get", type: "css"), fail = lib("fail"), nofiles: [String: Any] = ["id": "nofiles"]
        let l = make([have, get, fail, nofiles])
        serve(get)
        MockURL.on(url(fail), .text("", status: 500))

        XCTAssertEqual(ensure(l, ["some-npm", "@a/b", "bad name!"]), [["type": "js", "src": "https://cdn.jsdelivr.net/npm/some-npm"],
                                                                      ["type": "js", "src": "https://cdn.jsdelivr.net/npm/@a/b"]])
        let tags = ensure(l, ["have", "get", "fail", "nofiles", "other-npm"])
        XCTAssertEqual(tags, [["type": "js", "src": "aiui://app/vendor/have/have.js"],
                              ["type": "css", "src": "aiui://app/vendor/get/get.css"],
                              ["type": "js", "src": url(fail)],
                              ["type": "js", "src": "https://cdn.jsdelivr.net/npm/other-npm"]])
        XCTAssertEqual(rows(l)["have"]?["uses"] as? Int, 1)
        XCTAssertEqual(rows(l)["get"]?["uses"] as? Int, 1)
    }

    func testEnsureDoesNotWaitLongForAnInstall() {
        let slow = lib("slow")
        let l = make([slow])
        l.ensureTimeout = 0.1
        serve(slow, delay: 1.5)
        XCTAssertEqual(ensure(l, ["slow"]), [["type": "js", "src": url(slow)]])
        waitUntil { self.rows(l)["slow"]?["installed"] as? Bool == true }
        XCTAssertEqual(ensure(l, ["slow"]), [["type": "js", "src": "aiui://app/vendor/slow/slow.js"]])
    }

    // MARK: maintenance

    func testMaintainEvictsLeastRecentlyUsed() {
        writeState([Self.installed("old", lastUsed: Date().addingTimeInterval(-2 * 86400)), Self.installed("recent")])
        let l = make([lib("old"), lib("recent")])
        MockURL.on("data.jsdelivr.com", .json([Any]()))
        l.cacheBytes = { 50_000_000_000 }
        API.paused = true
        l.maintain()   // paused: nothing happens
        XCTAssertEqual(rows(l)["old"]?["installed"] as? Bool, true)
        API.paused = false
        l.maintain()
        XCTAssertEqual(rows(l)["old"]?["installed"] as? Bool, false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("old").path))
        XCTAssertEqual(rows(l)["recent"]?["installed"] as? Bool, true)   // used within the hour
        waitUntil { FileManager.default.fileExists(atPath: self.dir.appendingPathComponent("discover-page.txt").path) }
    }

    func testMaintainInstallsByPriorityWhileThereIsRoom() {
        let a = lib("aa", priority: 90), b = lib("bb", priority: 10), huge = lib("huge", priority: 99, bytes: 50_000_000_000)
        let l = make([a, b, huge])
        serve(a); serve(b)
        MockURL.on("data.jsdelivr.com", .json([Any]()))
        l.maintain()
        l.maintain()   // busy installing: returns
        waitUntil { self.rows(l)["aa"]?["installed"] as? Bool == true && self.rows(l)["bb"]?["installed"] as? Bool == true }
        XCTAssertEqual(rows(l)["huge"]?["installed"] as? Bool, false)
        let order = MockURL.seen.map(\.url.absoluteString).filter { $0.contains("cdn.test") }
        XCTAssertEqual(order, [url(a), url(b)])
        l.maintain()   // nothing left that fits
        spin(0.1)
        XCTAssertEqual(MockURL.seen.filter { $0.url.absoluteString.contains("data.jsdelivr.com") }.count, 1)   // discovery once per 6 h
    }

    func testDiscoverMoreFindsPlainBrowserBundles() throws {
        API.paused = true   // the maintenance pass after discovery stays out of the way
        let l = make([lib("known-lib")])
        let pkg = { (name: String, obj: [String: Any]) in MockURL.on("cdn.jsdelivr.net/npm/\(name)/package.json", .json(obj)) }
        MockURL.on("page=81", .json(["known-lib", "good", "tracker-x", "nopkg", "esm", "mjs", "badrange", "junkdesc", "plain"].map { ["name": $0] }))
        MockURL.on("page=82", .json([Any]()))
        pkg("good", ["version": "1.0.0", "jsdelivr": "./dist/good.js", "description": "Good things"])
        MockURL.on("npm/good@1.0.0/dist/good.js", MockURL.Response(status: 206, body: Data("(function (global, factory) { global.Good = factory(); })".utf8),
                                                                   headers: ["Content-Range": "bytes 0-4095/12345"]))
        MockURL.on("npm/nopkg/package.json", .text("missing", status: 404))
        pkg("esm", ["version": "1.0.0", "browser": "/index.js"])
        MockURL.on("npm/esm@1.0.0/index.js", .text("// x\nimport x from 'y'\n"))
        pkg("mjs", ["version": "1.0.0", "unpkg": "x.mjs"])
        pkg("badrange", ["version": "1.0.0", "browser": "b.js"])
        MockURL.on("npm/badrange@1.0.0/b.js", .text("", status: 500))
        pkg("junkdesc", ["version": "1.0.0", "browser": "j.js", "description": "analytics helper"])
        MockURL.on("npm/junkdesc@1.0.0/j.js", .text("var j = 1;"))
        pkg("plain", ["version": "2.0.0", "browser": "plain.js"])
        MockURL.on("npm/plain@2.0.0/plain.js", .text("var plain = 1;"))

        l.discoverMore()
        l.discoverMore()   // already discovering: ignored
        let cursor = dir.appendingPathComponent("discover-page.txt")
        waitUntil { (try? String(contentsOf: cursor, encoding: .utf8)) == "82" }
        let r = rows(l)
        XCTAssertEqual(Set(r.keys), ["known-lib", "good", "plain"])
        XCTAssertEqual(r["good"]?["bytes"] as? Int, 12345)
        XCTAssertEqual(r["good"]?["category"] as? String, "npm")
        XCTAssertEqual(r["plain"]?["bytes"] as? Int, 0)
        let ov = l.overview(["good"])["installable"] as? [String] ?? []
        XCTAssertEqual(ov.first, "good 1.0.0 (Good) — Good things")
        XCTAssertTrue(ov.contains("plain 2.0.0 ((UMD)) — "))
        XCTAssertEqual(MockURL.seen.first { $0.url.absoluteString.hasSuffix("good.js") }?.headers["Range"], "bytes=0-4095")
        XCTAssertEqual(MockURL.seen.filter { $0.url.absoluteString.contains("data.jsdelivr.com") }.count, 2)
        XCTAssertFalse(MockURL.seen.contains { $0.url.absoluteString.contains("tracker-x") || $0.url.absoluteString.contains("known-lib") })

        let extra = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("catalog-extra.json"))) as? [[String: Any]]
        XCTAssertEqual(Set(extra?.compactMap { $0["id"] as? String } ?? []), ["good", "plain"])
        let good = extra?.first { $0["id"] as? String == "good" }
        XCTAssertEqual(good?["priority"] as? Int, 1)
        XCTAssertEqual((good?["files"] as? [[String: Any]])?.first?["url"] as? String, "https://cdn.jsdelivr.net/npm/good@1.0.0/dist/good.js")
        XCTAssertEqual(Set(rows(make([lib("known-lib")])).keys), ["known-lib", "good", "plain"])   // kept across launches

        // The next round starts where this one stopped and finds nothing new.
        l.discoverMore(pages: 1)
        waitUntil { MockURL.seen.filter { $0.url.absoluteString.contains("page=82") }.count == 2 }
        spin(0.1)
        XCTAssertEqual(try? String(contentsOf: cursor, encoding: .utf8), "82")
        XCTAssertEqual(rows(l).count, 3)
    }

    // MARK: overview / list

    func testOverviewRanksByWordsUseAndPriority() {
        writeState([Self.installed("map"), Self.installed("chart")])
        let l = make([lib("chart", priority: 90, category: "charts", desc: "Charts: line, bar"),
                      lib("map", priority: 10, global: "", category: "maps", desc: "Maps and tiles"),
                      lib("three", priority: 95, global: nil, category: "3d", desc: "3D scenes"),
                      lib("tone", priority: 20, category: "audio", desc: "Audio synthesis")])
        _ = ensure(l, ["map"])
        let o = l.overview(["Show maps!", "of"])
        XCTAssertEqual(o["installed"] as? [String], ["map 1.0 (CSS) — Maps and tiles", "chart 1.0 (G) — Charts: line, bar"])
        XCTAssertEqual(o["installable"] as? [String], ["three 1.0 () — 3D scenes", "tone 1.0 (G) — Audio synthesis"])
        let totals = o["totals"] as? [String: Any]
        XCTAssertEqual(totals?["installed"] as? Int, 2)
        XCTAssertEqual(totals?["catalog"] as? Int, 4)
        XCTAssertEqual(totals?["byCategory"] as? [String: Int], ["charts": 1, "maps": 1])
        XCTAssertNotNil(o["note"])
        XCTAssertEqual(l.overview()["installed"] as? [String], ["chart 1.0 (G) — Charts: line, bar", "map 1.0 (CSS) — Maps and tiles"])
        let list = l.list()
        XCTAssertEqual(list["used"] as? Int, 200)
        XCTAssertEqual(list["installing"] as? [String], [])
        XCTAssertEqual(rows(l)["map"]?["uses"] as? Int, 1)
    }
}

private extension JSONDecoder {
    static var iso: JSONDecoder { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }
}
