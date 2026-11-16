import XCTest
@testable import AIUI

final class HintsTests: AIUITestCase {
    private func file(_ dir: URL) -> URL { dir.appendingPathComponent("hints.json") }

    func testJournalAndRetroDue() {
        let dir = TestEnv.tempDir()
        let h = Hints(dir: dir)
        XCTAssertFalse(h.retroDue)
        h.add(kind: "repair", scene: String(repeating: "s", count: 100), detail: String(repeating: "d", count: 500))
        h.add(kind: "timeout", scene: "b", detail: "2")
        XCTAssertFalse(h.retroDue, "fewer than 3")
        h.add(kind: "qa", scene: "c", detail: "3")
        XCTAssertTrue(h.retroDue, "3, and never a retrospective")
        let st = h.status()
        XCTAssertEqual(st["journal"] as? Int, 3)
        XCTAssertEqual(st["sinceRetro"] as? Int, 3)
        XCTAssertEqual(st["lastRetro"] as? String, "")
        let recent = st["recent"] as? [[String: String]] ?? []
        XCTAssertEqual(recent.first?["kind"], "qa")
        XCTAssertEqual(recent.last?["scene"]?.count, 80)
        XCTAssertEqual(recent.last?["detail"]?.count, 400)

        let input = h.retroInput()
        XCTAssertEqual((input["incidents"] as? [[String: Any]])?.count, 3)
        XCTAssertEqual((input["incidents"] as? [[String: Any]])?.first?["kind"] as? String, "repair")

        h.applyRetro(["summary": "ok"])
        XCTAssertFalse(h.retroDue)
        XCTAssertEqual(h.lastSummary, "ok")
        for i in 0..<14 { h.add(kind: "error", scene: "x", detail: "e\(i)") }
        XCTAssertFalse(h.retroDue, "3+ but within 6 hours")
        h.add(kind: "error", scene: "x", detail: "e14")
        XCTAssertTrue(h.retroDue, "15 new incidents")

        // Another device's file: a retrospective 7 hours ago with 3 incidents since.
        let other = TestEnv.tempDir()
        let old = Date().addingTimeInterval(-7 * 3600)
        StoreFiles.write(["journal": [["at": StoreFiles.iso(old.addingTimeInterval(-10)), "kind": "a", "scene": "", "detail": "before"]],
                          "hints": [], "retired": [:], "lastRetro": StoreFiles.iso(old)], file(other))
        let o = Hints(dir: other)
        XCTAssertEqual(o.lastSummary, "", "no summary in the file keeps mine")
        for i in 0..<3 { o.add(kind: "k", scene: "s", detail: "\(i)") }
        XCTAssertTrue(o.retroDue)
        XCTAssertEqual((o.retroInput()["incidents"] as? [Any])?.count, 3)
    }

    func testJournalKeepsTheLast300() {
        let dir = TestEnv.tempDir()
        let h = Hints(dir: dir)
        for i in 0..<301 { h.add(kind: "k", scene: "s", detail: "d\(i)") }
        XCTAssertEqual(h.status()["journal"] as? Int, 300)
        let again = Hints(dir: dir)
        XCTAssertEqual(again.status()["journal"] as? Int, 300)
        let recent = again.status()["recent"] as? [[String: String]] ?? []
        XCTAssertEqual(recent.first?["detail"], "d300")
    }

    func testApplyRetroLearnsAndRetires() {
        let dir = TestEnv.tempDir()
        let h = Hints(dir: dir)
        h.applyRetro(["hints": [
            ["text": "Use https images", "scope": "html", "why": "mixed content", "confidence": 0.9],
            ["text": "Keep labels short", "scope": "circles", "confidence": 5.0],
            ["text": "Avoid weather.test", "scope": "weather"],
            ["text": "General", "confidence": -1.0],
            ["text": ""], ["scope": "all"],
        ], "summary": "learned"])
        var hints = h.status()["hints"] as? [[String: Any]] ?? []
        XCTAssertEqual(hints.count, 4)
        XCTAssertEqual(hints.first?["text"] as? String, "Keep labels short")
        XCTAssertEqual(hints.first?["confidence"] as? Double ?? -1, 1, accuracy: 1e-9)
        XCTAssertEqual(hints.last?["confidence"] as? Double ?? -1, 0, accuracy: 1e-9)
        let general = hints.last!
        XCTAssertEqual(general["scope"] as? String, "all")
        XCTAssertEqual(general["why"] as? String, "")
        let weather = hints.first { $0["text"] as? String == "Avoid weather.test" }
        XCTAssertEqual(weather?["confidence"] as? Double ?? 0, 0.6, accuracy: 1e-9)
        XCTAssertNotNil(h.lastRetro)
        XCTAssertEqual(h.status()["summary"] as? String, "learned")
        XCTAssertNotEqual(h.status()["lastRetro"] as? String, "")

        // Reconfirming by id updates the hint; an unknown id makes a new one from the text.
        let ids = (h.retroInput()["hints"] as? [[String: Any]] ?? []).reduce(into: [String: String]()) {
            $0[$1["text"] as! String] = $1["id"] as? String
        }
        let wid = ids["Avoid weather.test"]!
        h.applyRetro(["hints": [["id": wid, "text": "Avoid weather.test images", "confidence": 0.2],
                                ["id": "unknown", "text": "Use https images"]]])
        hints = h.status()["hints"] as? [[String: Any]] ?? []
        XCTAssertEqual(hints.count, 4)
        let w = hints.first { $0["text"] as? String == "Avoid weather.test images" }
        XCTAssertEqual(w?["scope"] as? String, "weather")
        XCTAssertEqual(w?["evidence"] as? Int, 2)
        XCTAssertEqual(w?["confidence"] as? Double ?? 0, 0.6 * 0.7 + 0.2 * 0.3, accuracy: 1e-9)
        let https = hints.first { $0["text"] as? String == "Use https images" }
        XCTAssertEqual(https?["evidence"] as? Int, 2)
        XCTAssertEqual(https?["why"] as? String, "mixed content")
        XCTAssertEqual(h.lastSummary, "")

        h.applyRetro(["retire": [wid]])
        XCTAssertEqual((h.status()["hints"] as? [Any])?.count, 3)
        // A new instance agrees (the retired one stays retired).
        XCTAssertEqual((Hints(dir: dir).status()["hints"] as? [Any])?.count, 3)
        // Learned again: back.
        h.applyRetro(["hints": [["text": "Avoid weather.test"]]])
        XCTAssertEqual((h.status()["hints"] as? [Any])?.count, 4)
    }

    func testRelevant() {
        let h = Hints(dir: TestEnv.tempDir())
        h.applyRetro(["hints": [
            ["text": "Everywhere", "scope": "all", "confidence": 0.5],
            ["text": "For html", "scope": "html", "confidence": 0.9],
            ["text": "For circles", "scope": "circles", "confidence": 0.4],
            ["text": "Weather sources", "scope": "weather", "confidence": 1.0],
            ["text": "About maps tiles", "scope": "geo", "confidence": 0.3],
            ["text": "For charts", "scope": "chart", "confidence": 0.8],
        ]])
        let r = h.relevant(["Weather in Kyiv", "maps"], kind: "html")
        XCTAssertEqual(r.first, "Weather sources (weather, ×1)")
        XCTAssertTrue(r.contains("About maps tiles (geo, ×1)"), "matched by text")
        XCTAssertTrue(r.contains("For html (html, ×1)"))
        XCTAssertTrue(r.contains("For circles (circles, ×1)"))
        XCTAssertFalse(r.contains { $0.hasPrefix("For charts") })
        XCTAssertEqual(h.relevant([], kind: "chart").first, "For html (html, ×1)")
        XCTAssertTrue(h.relevant([], kind: "chart").contains("For charts (chart, ×1)"))
        XCTAssertEqual(h.relevant(["weather"], limit: 1), ["Weather sources (weather, ×1)"])
    }

    func testOldHintsFadeAndAtMost60Stay() {
        let dir = TestEnv.tempDir()
        let old = StoreFiles.iso(Date().addingTimeInterval(-40 * 86_400))
        StoreFiles.write(["journal": [], "retired": [:],
                          "hints": [["id": "hold", "text": "Old", "scope": "all", "why": "", "confidence": 0.9, "evidence": 3,
                                     "created": old, "updated": old]]], file(dir))
        let h = Hints(dir: dir)
        XCTAssertEqual((h.status()["hints"] as? [Any])?.count, 1)
        h.applyRetro([:])
        XCTAssertEqual((h.status()["hints"] as? [Any])?.count, 0, "not reconfirmed for 30 days")
        XCTAssertEqual((Hints(dir: dir).status()["hints"] as? [Any])?.count, 0)

        h.applyRetro(["hints": (0..<62).map { ["text": "hint \($0)", "confidence": Double($0) / 100] }])
        let hints = h.status()["hints"] as? [[String: Any]] ?? []
        XCTAssertEqual(hints.count, 60)
        XCTAssertEqual(hints.last?["text"] as? String, "hint 2", "the least certain go")
    }

    func testMergesAnotherDevicesFile() {
        let dir = TestEnv.tempDir()
        let h = Hints(dir: dir)
        h.add(kind: "mine", scene: "s", detail: "m")
        h.applyRetro(["hints": [["text": "Mine"], ["text": "Shared"], ["text": "Doomed"]], "summary": "here"])
        let ids = (h.retroInput()["hints"] as? [[String: Any]] ?? []).reduce(into: [String: String]()) {
            $0[$1["text"] as! String] = $1["id"] as? String
        }
        var d = StoreFiles.json(file(dir)) as? [String: Any] ?? [:]
        let future = StoreFiles.iso(Date().addingTimeInterval(3600)), past = StoreFiles.iso(Date().addingTimeInterval(-3600))
        var hints = d["hints"] as? [[String: Any]] ?? []
        for i in hints.indices {
            if hints[i]["id"] as? String == ids["Shared"] { hints[i]["text"] = "Shared, theirs"; hints[i]["updated"] = future }
            if hints[i]["id"] as? String == ids["Mine"] { hints[i]["text"] = "Mine, stale"; hints[i]["updated"] = past }
        }
        d["hints"] = hints
        d["retired"] = [ids["Doomed"]!: future, ids["Mine"]!: past]
        d["journal"] = (d["journal"] as? [Any] ?? []) + [["at": future, "kind": "theirs", "scene": "t", "detail": "t"]]
        d["lastRetro"] = future
        d["lastSummary"] = "there"
        StoreFiles.write(d, file(dir))

        h.reload()
        let texts = Set((h.status()["hints"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String })
        XCTAssertEqual(texts, ["Mine", "Shared, theirs"])
        XCTAssertEqual(h.status()["journal"] as? Int, 2, "merged without duplicates")
        XCTAssertEqual(h.lastSummary, "there")

        // An older retrospective and an older tombstone on disk change nothing.
        d["lastRetro"] = past
        d["lastSummary"] = "older"
        d["retired"] = [ids["Doomed"]!: past]
        StoreFiles.write(d, file(dir))
        h.reload()
        XCTAssertEqual(h.lastSummary, "there")
        XCTAssertEqual((h.status()["hints"] as? [Any])?.count, 2)

        try? Data("junk".utf8).write(to: file(dir))
        h.reload()
        XCTAssertEqual(h.status()["journal"] as? Int, 2)
    }

    func testRelearnedInTheSameSecondAsItsRetirementSurvivesOnOtherDevices() {
        let dir = TestEnv.tempDir()
        let h = Hints(dir: dir)
        h.applyRetro(["hints": [["text": "Comes back"]]])
        let id = (h.retroInput()["hints"] as? [[String: Any]])?.first?["id"] as? String
        h.applyRetro(["retire": [id!]])
        h.applyRetro(["hints": [["text": "Comes back"]]])                // within the same second
        let texts = (Hints(dir: dir).status()["hints"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
        XCTAssertEqual(texts, ["Comes back"])
    }
}
