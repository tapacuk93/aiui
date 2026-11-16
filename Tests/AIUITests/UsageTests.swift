import XCTest
@testable import AIUI

final class UsageTests: AIUITestCase {
    typealias Schedule = Usage.Schedule

    private func make() -> (Usage, URL) {
        let dir = TestEnv.tempDir()
        return (Usage(dir: dir.appendingPathComponent("usage"), shots: dir.appendingPathComponent("shots")), dir)
    }

    // MARK: - Schedules

    func testScheduleFromJSON() {
        XCTAssertNil(Schedule(nil))
        XCTAssertNil(Schedule(["every": 0]))
        XCTAssertNil(Schedule(["curve": "linear"]))
        let s = Schedule(["every": 60, "curve": "Linear", "factor": 0.5, "formula": "n", "max": 600, "why": "w"])
        XCTAssertEqual(s, Schedule(every: 60, curve: "linear", factor: 0.5, formula: "n", max: 600, why: "w"))
        XCTAssertEqual(Schedule(["every": 60])?.curve, "exponential")
        let j = s!.json
        XCTAssertEqual(j["every"] as? Double, 60)
        XCTAssertEqual(j["curve"] as? String, "linear")
        XCTAssertEqual(j["factor"] as? Double, 0.5)
        XCTAssertEqual(j["formula"] as? String, "n")
        XCTAssertEqual(j["max"] as? Double, 600)
        XCTAssertEqual(j["why"] as? String, "w")
        XCTAssertEqual(Set(Schedule(every: 1, curve: "c", factor: nil, formula: nil, max: nil, why: nil).json.keys), ["every", "curve"])
    }

    func testScheduleCurves() {
        func s(_ curve: String, factor: Double? = nil, formula: String? = nil, max: Double? = nil, every: Double = 100) -> Schedule {
            Schedule(every: every, curve: curve, factor: factor, formula: formula, max: max, why: nil)
        }
        XCTAssertEqual(s("constant").gap(5), 100)
        XCTAssertEqual(s("linear").gap(3), 400)
        XCTAssertEqual(s("linear", factor: 2).gap(3), 700)
        XCTAssertEqual(s("fibonacci").gap(0), 100)
        XCTAssertEqual(s("fibonacci").gap(5), 800)
        XCTAssertEqual(s("log").gap(0), 100)
        XCTAssertEqual(s("logarithmic", factor: 2).gap(1), 100 * (1 + 2 * log(2)), accuracy: 0.001)
        XCTAssertEqual(s("exponential").gap(3), 800)
        XCTAssertEqual(s("whatever", factor: 3).gap(2), 900)
        XCTAssertEqual(Schedule.fallback.gap(0), 300)
        XCTAssertEqual(Schedule.fallback.gap(20), 86_400, "capped at max")
        XCTAssertEqual(s("constant", every: 1).gap(0), Schedule.minGap, "at least the minimum gap")
        XCTAssertEqual(s("constant", max: -1).gap(0), 100, "a non-positive max is ignored")
        // Overflow: the max, or 30 days.
        XCTAssertEqual(s("exponential", factor: 1e300).gap(5), 86_400 * 30)
        XCTAssertEqual(s("exponential", factor: 1e300, max: 5000).gap(5), 5000)
    }

    func testScheduleFormula() {
        func f(_ formula: String?) -> Schedule { Schedule(every: 60, curve: "formula", factor: nil, formula: formula, max: nil, why: nil) }
        XCTAssertEqual(f("every * (n + 1)").gap(2), 180)
        XCTAssertEqual(f("every * pow(3, n)").gap(2), 540, "Math functions are in scope")
        XCTAssertEqual(f(nil).gap(2), 240, "no formula: doubling")
        XCTAssertEqual(f("").gap(1), 120)
        XCTAssertEqual(f(String(repeating: "1+", count: 200) + "1").gap(1), 120, "too long")
        XCTAssertEqual(f("((").gap(1), 120, "a syntax error")
        XCTAssertEqual(f("1/0").gap(1), 86_400 * 30, "infinite")
        XCTAssertEqual(f("'abc'").gap(1), 86_400 * 30, "NaN")
    }

    // MARK: - Recording and improving

    func testRecordAndList() {
        let (u, _) = make()
        u.record([:])
        u.record(["key": ""])
        XCTAssertTrue(u.list().isEmpty)
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0x01])
        u.record(["key": "a", "title": "Weather", "opened": true, "dwellMs": 120_000.0, "interactions": 3,
                  "findings": ["slow"], "screenshot": "data:image/jpeg;base64," + jpeg.base64EncodedString()])
        u.record(["key": "a", "title": "", "dwellMs": 60_000.0, "findings": [String]()])
        u.record(["key": "b", "screenshot": "nocomma"])
        let s = u.scene("a")!
        XCTAssertEqual(s.title, "Weather")
        XCTAssertEqual(s.opens, 1)
        XCTAssertEqual(s.usedSinceImprove, 1)
        XCTAssertEqual(s.dwellMs, 180_000)
        XCTAssertEqual(s.interactions, 3)
        XCTAssertEqual(s.findings, ["slow"])
        XCTAssertNotNil(s.firstUsed)
        XCTAssertNotNil(s.nextImprove)
        XCTAssertEqual(try? Data(contentsOf: u.shot("a")), jpeg)
        XCTAssertNil(u.scene("zzz"))

        let l = u.list()
        XCTAssertEqual(l.map { $0["key"] as? String }, ["b", "a"])
        let a = l[1]
        XCTAssertEqual(a["minutes"] as? Int, 3)
        XCTAssertEqual(a["findings"] as? Int, 1)
        XCTAssertEqual(a["shot"] as? String, "data:image/jpeg;base64," + jpeg.base64EncodedString())
        XCTAssertNotNil(a["nextImprove"] as? String)
        XCTAssertNil(l[0]["shot"])
    }

    func testDueImprovedDeferPauseAndImproveNow() {
        let (u, _) = make()
        XCTAssertNil(u.due())
        u.record(["key": "a", "opened": true])
        u.record(["key": "b", "opened": true])
        u.record(["key": "b", "opened": true])
        XCTAssertEqual(u.due()?.key, "b", "most used first")

        u.improved("zzz")
        u.improved("b")
        var b = u.scene("b")!
        XCTAssertEqual(b.improves, 1)
        XCTAssertEqual(b.usedSinceImprove, 0)
        XCTAssertNotNil(b.lastImproved)
        XCTAssertEqual(b.nextImprove!.timeIntervalSinceNow, 600, accuracy: 5)
        XCTAssertEqual(u.due()?.key, "a")

        u.deferImprove("zzz")
        u.deferImprove("a")
        XCTAssertEqual(u.scene("a")!.nextImprove!.timeIntervalSinceNow, 300, accuracy: 5)
        XCTAssertNil(u.due())
        u.setSchedule("a", ["every": 10, "curve": "constant"])
        u.deferImprove("a")
        XCTAssertEqual(u.scene("a")!.nextImprove!.timeIntervalSinceNow, 60, accuracy: 5, "at least a minute")

        u.improveNow("zzz")
        u.improveNow("b")
        XCTAssertEqual(u.due()?.key, "b")
        u.setPaused("zzz", true)
        u.setPaused("b", true)
        XCTAssertEqual(u.scene("b")?.paused, true)
        XCTAssertNil(u.due())
        u.setPaused("b", false)
        XCTAssertNil(u.scene("b")?.paused)
        XCTAssertEqual(u.due()?.key, "b", "an overdue improvement is due again at once")
        u.improved("b")
        u.setPaused("b", true)
        u.setPaused("b", false)
        XCTAssertGreaterThan(u.scene("b")!.nextImprove!.timeIntervalSinceNow, 500, "a future one stays planned")
        u.setPaused("b", true)
        u.improveNow("b")
        XCTAssertNil(u.scene("b")?.paused)
    }

    func testSetScheduleAndInfo() {
        let (u, _) = make()
        u.setSchedule("zzz", ["every": 60])
        XCTAssertNil(u.scheduleInfo("zzz"))
        u.record(["key": "a", "title": "A"])
        var info = u.scheduleInfo("a")!
        XCTAssertEqual(info["declared"] as? Bool, false)
        XCTAssertEqual(info["gap"] as? Double, 300)
        XCTAssertEqual((info["schedule"] as? [String: Any])?["curve"] as? String, "exponential")
        XCTAssertNotNil(info["next"])
        u.setSchedule("a", ["every": 0])
        XCTAssertNil(u.scene("a")?.schedule)
        u.setSchedule("a", ["every": 3600, "curve": "constant"])
        let first = u.scene("a")!.firstUsed!
        XCTAssertEqual(u.scene("a")!.nextImprove!.timeIntervalSince(first), 3600, accuracy: 0.01, "planned from first use")
        info = u.scheduleInfo("a")!
        XCTAssertEqual(info["declared"] as? Bool, true)
        XCTAssertEqual(info["gap"] as? Double, 3600)
        XCTAssertEqual(info["paused"] as? Bool, false)
        let before = u.scene("a")!.nextImprove
        u.setSchedule("a", ["every": 3600, "curve": "constant"])
        XCTAssertEqual(u.scene("a")!.nextImprove, before, "unchanged schedule")
        // After an improvement, a new schedule does not replan the next one.
        u.improved("a")
        let planned = u.scene("a")!.nextImprove
        u.setSchedule("a", ["every": 50, "curve": "constant"])
        XCTAssertEqual(u.scene("a")!.nextImprove, planned)
        XCTAssertEqual(u.scene("a")!.schedule?.every, 50)
    }

    func testSummary() {
        let (u, _) = make()
        XCTAssertEqual(u.summary()["applets"] as? Int, 0)
        XCTAssertNil(u.summary()["next"])
        u.record(["key": "a", "title": "A"])
        u.record(["key": "b", "title": "B"])
        u.record(["key": "c", "title": "C"])
        u.improved("a")
        u.setPaused("b", true)
        u.setSchedule("c", ["every": 60, "curve": "constant"])
        u.merge("c", into: "a")
        u.improved("a")
        let s = u.summary()
        XCTAssertEqual(s["applets"] as? Int, 2)
        XCTAssertEqual(s["improvements"] as? Int, 2)
        XCTAssertEqual(s["paused"] as? Int, 1)
        XCTAssertEqual(s["declared"] as? Int, 0)
        let next = s["next"] as? [String: Any]
        XCTAssertEqual(next?["key"] as? String, "a")
        XCTAssertEqual(next?["title"] as? String, "A")
        XCTAssertNotNil(next?["at"] as? Double)
    }

    func testAppletsTitlesCanonicalRequestAndMerge() {
        let (u, _) = make()
        u.record(["key": "a", "title": "My Weather!", "opened": true])
        u.record(["key": "b", "title": "my weather", "opened": true])
        u.record(["key": "b", "opened": true])
        u.record(["key": "c", "title": "News", "findings": ["one"]])
        u.record(["key": "untitled"])
        XCTAssertEqual(Usage.norm("My Weather!"), "myweather")
        XCTAssertNil(u.applet(titled: "!!"))
        XCTAssertEqual(u.applet(titled: "MY WEATHER"), "b")
        XCTAssertNil(u.applet(titled: "Other"))
        XCTAssertEqual(u.applets().map { $0["key"] as? String }.first, "b")
        XCTAssertEqual(u.applets(limit: 10).count, 3)
        XCTAssertEqual(u.applets(limit: 1).count, 1)

        u.request("zzz", "more")
        u.request("c", "")
        XCTAssertEqual(u.scene("c")?.findings, ["one"])
        u.request("c", "add sport")
        XCTAssertEqual(u.scene("c")?.findings, ["The user also asked for: add sport", "one"])
        XCTAssertEqual(u.scene("c")?.usedSinceImprove, 1)

        u.merge("a", into: "a")
        u.merge("a", into: "zzz")
        u.merge("zzz", into: "a")
        XCTAssertNil(u.scene("a")?.mergedInto)
        u.merge("c", into: "b")
        XCTAssertEqual(u.scene("c")?.mergedInto, "b")
        let b = u.scene("b")!
        XCTAssertEqual(b.opens, 2)
        XCTAssertEqual(b.findings, ["The user also asked for: add sport", "one"])
        u.merge("b", into: "a")
        XCTAssertEqual(u.canonical("c"), "a")
        XCTAssertEqual(u.canonical("a"), "a")
        XCTAssertEqual(u.canonical("zzz"), "zzz")
        XCTAssertEqual(u.applet(titled: "my weather"), "a")
        XCTAssertEqual(u.applets().map { $0["key"] as? String }, ["a"])
        XCTAssertEqual(u.scene("a")?.opens, 3)
    }

    func testCanonicalStopsOnLoops() {
        let (u, dir) = make()
        u.record(["key": "x"])
        u.record(["key": "y"])
        // Two devices merged each into the other: a loop is cut short.
        let url = dir.appendingPathComponent("usage/usage.json")
        var list = StoreFiles.json(url) as? [[String: Any]] ?? []
        let later = StoreFiles.iso(Date().addingTimeInterval(60))
        for i in list.indices {
            list[i]["mergedInto"] = list[i]["key"] as? String == "x" ? "y" : "x"
            list[i]["lastUsed"] = later
        }
        StoreFiles.write(list, url)
        u.reload()
        XCTAssertTrue(["x", "y"].contains(u.canonical("x")))
        XCTAssertEqual(u.scene("x")?.mergedInto, "y")
    }

    func testMergesDiskAndKeepsAtMost300() {
        let (u, dir) = make()
        u.record(["key": "mine", "title": "Mine"])
        u.record(["key": "shared", "title": "Here"])
        let url = dir.appendingPathComponent("usage/usage.json")
        var list = StoreFiles.json(url) as? [[String: Any]] ?? []
        for i in list.indices {
            if list[i]["key"] as? String == "shared" { list[i]["title"] = "There"; list[i]["lastUsed"] = StoreFiles.iso(Date().addingTimeInterval(60)) }
            if list[i]["key"] as? String == "mine" { list[i]["title"] = "Stale"; list[i]["lastUsed"] = StoreFiles.iso(Date().addingTimeInterval(-60)) }
        }
        var other = list[0]; other["key"] = "other"
        list.append(other)
        StoreFiles.write(list, url)
        u.reload()
        XCTAssertEqual(u.scene("shared")?.title, "There")
        XCTAssertEqual(u.scene("mine")?.title, "Mine")
        XCTAssertNotNil(u.scene("other"))
        let again = Usage(dir: dir.appendingPathComponent("usage"), shots: dir.appendingPathComponent("shots"))
        XCTAssertNotNil(again.scene("other"))

        // Unreadable file: ignored.
        try? Data("junk".utf8).write(to: url)
        u.reload()
        XCTAssertNotNil(u.scene("other"))

        // At most 300 scenes; the least recently used go, with their screenshots.
        let (big, _) = make()
        big.record(["key": "first", "screenshot": "data:image/jpeg;base64,AAAA"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: big.shot("first").path))
        for i in 0..<300 { big.record(["key": "s\(i)"]) }
        XCTAssertNil(big.scene("first"))
        XCTAssertNotNil(big.scene("s0"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: big.shot("first").path))
    }
}
