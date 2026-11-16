import XCTest
@testable import AIUI

/// Helpers for the on-disk stores' tests: read and rewrite their JSON files the way another
/// device would (through iCloud).
enum StoreFiles {
    static func json(_ url: URL) -> Any? { (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) } }
    static func write(_ obj: Any, _ url: URL) {
        try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]).write(to: url, options: .atomic)
    }
    static func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
}

final class CacheTests: AIUITestCase {
    private func outcome(_ extra: [String: Any] = [:]) -> [String: Any] {
        ["kind": "screen", "title": "Weather", "circles": [["label": "a"], ["label": "b"]]].merging(extra) { $1 }
    }

    func testActionFromInputPicksTheIdentifyingParts() {
        let a = Cache.action(from: [
            "event": "open", "language": "uk", "path": ["Home", "News"], "target": ["label": "Sport"],
            "text": "hi", "data": ["x": 1],
            "screen": ["title": "News", "removed": ["z", "y"],
                       "circles": [["label": "b", "selected": true], ["label": "a", "selected": true],
                                   ["label": "v", "value": 3], ["value": 1], ["label": "n"]]],
        ])
        XCTAssertEqual(a["event"] as? String, "open")
        XCTAssertEqual(a["language"] as? String, "uk")
        XCTAssertEqual(a["path"] as? [String], ["Home", "News"])
        XCTAssertEqual(a["target"] as? String, "Sport")
        XCTAssertEqual(a["text"] as? String, "hi")
        XCTAssertEqual((a["data"] as? [String: Int])?["x"], 1)
        XCTAssertEqual(a["on"] as? String, "News")
        XCTAssertEqual(a["selected"] as? [String], ["a", "b"])
        XCTAssertEqual(a["values"] as? [String], ["v=3"])
        XCTAssertEqual(a["removed"] as? [String], ["y", "z"])

        let bare = Cache.action(from: ["text": "", "screen": ["circles": [], "removed": []]])
        XCTAssertEqual(bare["event"] as? String, "?")
        XCTAssertEqual(Set(bare.keys), ["event"])
    }

    func testKeyNormalizesText() {
        let k1 = Cache.key(for: ["event": "ask", "text": "  Hello "])
        let k2 = Cache.key(for: ["event": "ask", "text": "hello"])
        XCTAssertEqual(k1, k2)
        XCTAssertEqual(k1.count, 24)
        XCTAssertNotEqual(k1, Cache.key(for: ["event": "ask", "text": "bye"]))
    }

    func testLineDescribesAnAction() {
        XCTAssertEqual(Cache.line(action: [:]), "?")
        XCTAssertEqual(Cache.line(action: ["event": "open", "path": ["A", "B"], "target": "C", "selected": ["x", "y"], "text": "t"]),
                       "open A › B → C selected: x, y “t”")
        XCTAssertEqual(Cache.line(action: ["event": "open", "path": []]), "open")
    }

    func testStoreLookupOutcomeAndGenerations() {
        let dir = TestEnv.tempDir()
        let c = Cache(dir: dir, limitMB: 0)
        XCTAssertEqual(c.limitBytes, 1_048_576)
        c.generation = "g1"
        let action: [String: Any] = ["event": "open", "path": ["Home"], "target": "Weather"]
        c.store(key: "k1", action: action, flow: ["start"], outcome: outcome(["cacheable": true]))
        c.store(key: "k2", action: ["event": "ask", "text": "news"], flow: [], outcome: ["kind": "html", "note": "A news page"])

        let hit = c.lookup("k1")
        XCTAssertEqual(hit?["title"] as? String, "Weather")
        XCTAssertNil(hit?["cacheable"])
        XCTAssertNil(c.lookup("k2"), "not cacheable")
        XCTAssertNil(c.lookup("nope"))
        XCTAssertEqual(c.outcome("k2")?["kind"] as? String, "html")
        XCTAssertNil(c.outcome("nope"))

        c.generation = "g2"
        XCTAssertNil(c.lookup("k1"), "other generation is not replayed")
        XCTAssertNil(c.outcome("k2"), "an old-generation html screen is not reused")
        XCTAssertEqual(c.outcome("k1")?["title"] as? String, "Weather", "an old circles screen is reused")
        XCTAssertEqual(c.raw("k2")?["kind"] as? String, "html")
        XCTAssertNil(c.raw("nope"))
        XCTAssertEqual(c.flow("k1"), ["start"])
        XCTAssertEqual(c.flow("nope"), [])

        // Descriptions: the AI's note, or one made from the outcome.
        let s = c.search("")
        XCTAssertEqual(Set(s.compactMap { $0["description"] as? String }), ["screen “Weather” with 2 circles", "A news page"])
        XCTAssertEqual(c.search("news").first?["key"] as? String, "k2")
        XCTAssertEqual(c.search("news").first?["hits"] as? Int, 2)
        XCTAssertTrue(c.search("zzz").isEmpty)

        // The index text is written, newest first.
        let text = try? String(contentsOf: c.indexText)
        XCTAssertTrue(text?.hasPrefix("# aiui memory index") == true)
        XCTAssertTrue(text?.contains("[k1]") == true)

        let st = c.stats()
        XCTAssertEqual(st["entries"] as? Int, 2)
        XCTAssertEqual(st["bytes"] as? Int, c.totalBytes)
        XCTAssertGreaterThan(c.totalBytes, 0)
        XCTAssertEqual(st["dir"] as? String, dir.path)
    }

    func testDescribeWithoutTitleOrCircles() {
        let c = Cache(dir: TestEnv.tempDir(), limitMB: 1)
        c.store(key: "k", action: ["event": "x"], flow: [], outcome: [:])
        XCTAssertEqual(c.search("").first?["description"] as? String, "screen")
    }

    func testStoreSkipsWhatCannotBeEncoded() {
        let c = Cache(dir: TestEnv.tempDir(), limitMB: 1)
        c.store(key: "k", action: ["event": "x"], flow: [], outcome: ["bad": Double.nan])
        XCTAssertNil(c.raw("k"))
        XCTAssertEqual(c.stats()["entries"] as? Int, 0)
    }

    func testLikelyOverviewAndRelated() {
        let c = Cache(dir: TestEnv.tempDir(), limitMB: 1)
        c.store(key: "a", action: ["event": "open", "path": ["Home"], "target": "Weather"], flow: [], outcome: outcome())
        c.store(key: "b", action: ["event": "open", "path": ["Home"], "target": "News"], flow: ["x"], outcome: outcome(["note": "news list"]))
        c.store(key: "b", action: ["event": "open", "path": ["Home"], "target": "News"], flow: ["x"], outcome: outcome(["note": "news list"]))
        c.store(key: "c", action: ["event": "ask", "text": "weather today"], flow: [], outcome: outcome())
        XCTAssertEqual(c.likely(path: ["Home"]), "News")
        XCTAssertNil(c.likely(path: ["Other"]))
        // Equal hits: the most recent wins.
        c.store(key: "d", action: ["event": "open", "path": ["P"], "target": "One"], flow: [], outcome: outcome())
        c.store(key: "e", action: ["event": "open", "path": ["P"], "target": "Two"], flow: [], outcome: outcome())
        XCTAssertEqual(c.likely(path: ["P"]), "Two")

        let ov = c.overview(limit: 3)
        XCTAssertEqual(ov.count, 3)
        XCTAssertTrue(ov.contains { $0.contains("×2 [b]") && $0.hasPrefix("x ⟶ open Home → News") })

        XCTAssertTrue(c.related([]).isEmpty)
        XCTAssertTrue(c.related(["a", "of"]).isEmpty, "short words are ignored")
        let r = c.related(["Weather", "today"], limit: 2)
        XCTAssertEqual(r.first?["key"] as? String, "c")
        XCTAssertEqual(r.count, 2)
        XCTAssertTrue(c.related(["zebra"]).isEmpty)
    }

    func testReplaceInvalidateClear() {
        let dir = TestEnv.tempDir()
        let c = Cache(dir: dir, limitMB: 1)
        c.store(key: "k", action: ["event": "open"], flow: ["f"], outcome: outcome())
        c.replace("missing", with: ["title": "x"])
        XCTAssertNil(c.raw("missing"))
        c.replace("k", with: ["title": "Better"])
        XCTAssertEqual(c.raw("k")?["title"] as? String, "Better")
        XCTAssertEqual(c.flow("k"), ["f"])
        c.invalidate("k")
        XCTAssertNil(c.raw("k"))
        XCTAssertEqual(c.stats()["entries"] as? Int, 0)
        c.store(key: "k2", action: ["event": "open"], flow: [], outcome: outcome())
        c.clear()
        XCTAssertEqual(c.stats()["entries"] as? Int, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("entries").path))
        XCTAssertNil(c.raw("k2"))
    }

    func testEvictsLeastRecentlyUsed() {
        let c = Cache(dir: TestEnv.tempDir(), limitMB: 1)
        let big = String(repeating: "x", count: 400_000)
        c.store(key: "old", action: ["event": "1"], flow: [], outcome: ["blob": big])
        c.store(key: "mid", action: ["event": "2"], flow: [], outcome: ["blob": big])
        XCTAssertNotNil(c.raw("old"))
        c.store(key: "new", action: ["event": "3"], flow: [], outcome: ["blob": big])
        XCTAssertNil(c.raw("old"), "the oldest goes first")
        XCTAssertNotNil(c.raw("mid"), "eviction stops once under 90% of the limit")
        XCTAssertNotNil(c.raw("new"))
        XCTAssertLessThanOrEqual(c.totalBytes, c.limitBytes)
    }

    func testInitLoadsIndexAndDropsOrphansAndOldRows() {
        let dir = TestEnv.tempDir()
        let a = Cache(dir: dir, limitMB: 1)
        a.store(key: "keep", action: ["event": "open"], flow: [], outcome: outcome())
        a.store(key: "gone", action: ["event": "open"], flow: [], outcome: outcome())
        let entries = dir.appendingPathComponent("entries")
        try? FileManager.default.removeItem(at: entries.appendingPathComponent("gone.json"))
        try? Data("{}".utf8).write(to: entries.appendingPathComponent("orphan.json"))
        // A row in an older format is not loaded (and its entry file goes with it).
        var rows = StoreFiles.json(dir.appendingPathComponent("index.json")) as? [[String: Any]] ?? []
        var old = rows.first { $0["key"] as? String == "keep" }!
        old["key"] = "old"; old["v"] = 1
        rows.append(old)
        StoreFiles.write(rows, dir.appendingPathComponent("index.json"))
        try? Data("{}".utf8).write(to: entries.appendingPathComponent("old.json"))

        let b = Cache(dir: dir, limitMB: 1)
        XCTAssertEqual(b.stats()["entries"] as? Int, 1)
        XCTAssertNotNil(b.raw("keep"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: entries.appendingPathComponent("orphan.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: entries.appendingPathComponent("old.json").path))
    }

    func testReloadMergesAnotherDevicesRows() {
        let dir = TestEnv.tempDir()
        let a = Cache(dir: dir, limitMB: 1)
        a.store(key: "mine", action: ["event": "open", "target": "A"], flow: [], outcome: outcome())
        a.store(key: "shared", action: ["event": "open", "target": "S"], flow: [], outcome: outcome())
        a.store(key: "shared", action: ["event": "open", "target": "S"], flow: [], outcome: outcome())
        a.store(key: "older", action: ["event": "open", "target": "O"], flow: [], outcome: outcome())

        // Another device: adds a row, uses "shared" later (with fewer hits), its "older" row is stale,
        // deleted "mine", and lists a row whose entry file has not arrived yet.
        let b = Cache(dir: dir, limitMB: 1)
        b.store(key: "theirs", action: ["event": "open", "target": "T"], flow: [], outcome: outcome())
        let url = dir.appendingPathComponent("index.json")
        var rows = StoreFiles.json(url) as? [[String: Any]] ?? []
        for i in rows.indices {
            switch rows[i]["key"] as? String {
            case "shared": rows[i]["lastUsed"] = StoreFiles.iso(Date().addingTimeInterval(3600)); rows[i]["hits"] = 1; rows[i]["description"] = "from b"
            case "older": rows[i]["lastUsed"] = StoreFiles.iso(Date().addingTimeInterval(-3600)); rows[i]["description"] = "stale"
            default: break
            }
        }
        var pending = rows[0]; pending["key"] = "pending"
        rows.append(pending)
        StoreFiles.write(rows, url)
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("entries/mine.json"))

        a.reload()
        XCTAssertNotNil(a.raw("theirs"))
        XCTAssertEqual(a.search("").count, 3)
        let shared = a.search("from b").first
        XCTAssertEqual(shared?["key"] as? String, "shared")
        XCTAssertEqual(shared?["hits"] as? Int, 2, "hits are the larger of the two")
        XCTAssertTrue(a.search("stale").isEmpty, "my newer row is kept")
        XCTAssertTrue(a.search("").allSatisfy { $0["key"] as? String != "mine" }, "deleted on the other device")
        XCTAssertTrue(a.search("").allSatisfy { $0["key"] as? String != "pending" })
    }

    func testAnyCodableRoundTrips() throws {
        let value: [String: Any] = ["b": true, "i": 3, "d": 1.5, "s": "x", "a": [1, "y"], "o": ["k": false], "n": NSNull(), "date": Date()]
        let data = try JSONEncoder().encode(AnyCodable(value))
        let back = try JSONDecoder().decode(AnyCodable.self, from: data).value as? [String: Any]
        XCTAssertEqual(back?["b"] as? Bool, true)
        XCTAssertEqual(back?["i"] as? Int, 3)
        XCTAssertEqual(back?["d"] as? Double, 1.5)
        XCTAssertEqual(back?["s"] as? String, "x")
        XCTAssertEqual((back?["a"] as? [Any])?.count, 2)
        XCTAssertEqual((back?["o"] as? [String: Any])?["k"] as? Bool, false)
        XCTAssertTrue(back?["n"] is NSNull)
        XCTAssertTrue(back?["date"] is NSNull, "values JSON can't hold are written as null")
        // NSNumber booleans (from JSONSerialization) stay booleans.
        let nsBool = try JSONEncoder().encode(AnyCodable(NSNumber(value: true)))
        XCTAssertEqual(String(data: nsBool, encoding: .utf8), "true")
    }

    func testAnyCodableDecodesUnknownValuesAsNull() throws {
        // A property list can hold data, which none of the JSON shapes decode.
        let plist = try PropertyListEncoder().encode(["x": Data([1, 2, 3])])
        let back = try PropertyListDecoder().decode([String: AnyCodable].self, from: plist)
        XCTAssertTrue(back["x"]?.value is NSNull)
    }
}
