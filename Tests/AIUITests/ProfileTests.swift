import XCTest
@testable import AIUI

final class ProfileTests: AIUITestCase {
    func testMergeAddsRevisesAndRemoves() {
        let dir = TestEnv.tempDir("profile")
        let p = Profile(dir: dir)
        p.merge(["updates": [
            ["path": ["Interests", "Games", "Puzzles"], "value": "likes", "confidence": 1.7],   // clamped to 1
            ["path": ["Language"], "value": "uk"],                                             // default 0.5
            ["path": [], "value": "skipped"],
            ["path": ["No value"]],
        ]])
        XCTAssertEqual(p.traits.count, 2)
        XCTAssertEqual(p.traits["interests › games › puzzles"]?.confidence, 1)
        XCTAssertEqual(p.traits["language"]?.confidence, 0.5)
        // Revision: value replaced, confidence blended, evidence accumulates; key is case-insensitive.
        p.merge(["updates": [["path": ["language"], "value": "en", "confidence": 0.0]]])
        let t = p.traits["language"]!
        XCTAssertEqual(t.value, "en")
        XCTAssertEqual(t.confidence, 0.3, accuracy: 1e-9)
        XCTAssertEqual(t.evidence, 2)
        // Removal sticks even though the trait was already saved (a tombstone).
        p.merge(["remove": [["Interests", "Games", "Puzzles"]]])
        XCTAssertNil(p.traits["interests › games › puzzles"])
        XCTAssertEqual(p.traits.count, 1)
        XCTAssertEqual(Profile(dir: dir).traits.count, 1)
    }

    func testMergeKeepsTheStrongestWithinLimit() {
        let dir = TestEnv.tempDir("profile")
        let p = Profile(dir: dir)
        p.merge(["updates": [["path": ["Weak"], "value": "v", "confidence": 0.01]]])   // saved first
        var ups: [[String: Any]] = (0..<p.limit).map { ["path": ["T\($0)"], "value": "v", "confidence": 0.9] }
        ups.append(["path": ["Weaker"], "value": "v", "confidence": 0.0])
        p.merge(["updates": ups])
        XCTAssertEqual(p.traits.count, p.limit)
        XCTAssertNil(p.traits["weak"])
        XCTAssertNil(p.traits["weaker"])
        XCTAssertEqual(Profile(dir: dir).traits.count, p.limit)
    }

    func testOverviewAndTree() {
        let p = Profile(dir: TestEnv.tempDir("profile"))
        p.merge(["updates": [
            ["path": ["Interests", "Games", "Puzzles"], "value": "daily", "confidence": 0.9],
            ["path": ["Interests", "Games", "Chess"], "value": "sometimes", "confidence": 0.4],
            ["path": ["Interests", "Music", "Jazz"], "value": "yes", "confidence": 0.7],
            ["path": ["Interests", "Reading"], "value": "novels", "confidence": 0.8],
            ["path": ["Interests", "Cooking"], "value": "rarely", "confidence": 0.2],
        ]])
        let o = p.overview(limit: 2)
        XCTAssertEqual(o, ["Interests › Games › Puzzles: daily (0.9)", "Interests › Reading: novels (0.8)"])
        XCTAssertEqual(p.overview().count, 5)

        let root = p.tree(at: [])
        XCTAssertEqual(root["total"] as? Int, 5)
        XCTAssertEqual((root["branches"] as? [[String: Any]])?.first?["name"] as? String, "Interests")
        let interests = p.tree(at: ["interests"])
        let branches = interests["branches"] as? [[String: Any]] ?? []
        XCTAssertEqual(branches.map { $0["name"] as? String }, ["Games", "Music"])   // by count, then name
        XCTAssertEqual(branches.map { $0["count"] as? Int }, [2, 1])
        let here = interests["traits"] as? [[String: Any]] ?? []
        XCTAssertEqual(here.map { $0["name"] as? String }, ["Reading", "Cooking"])   // most confident first
        XCTAssertEqual(here.first?["path"] as? [String], ["Interests", "Reading"])
    }

    func testPersistReloadAndTombstones() {
        let dir = TestEnv.tempDir("profile")
        let a = Profile(dir: dir)
        a.merge(["updates": [["path": ["A"], "value": "1"], ["path": ["B"], "value": "2"]]])
        a.baseline = ["typing": AnyCodable(["n": 3.0, "mean": 120.0])]
        a.persist()

        let b = Profile(dir: dir), c = Profile(dir: dir)
        XCTAssertEqual(Set(b.traits.keys), ["a", "b"])
        XCTAssertEqual(((b.baseline["typing"]?.value as? [String: Any])?["n"] as? NSNumber)?.doubleValue, 3)
        b.remove(["A"])                                      // tombstone written
        // Another device revised B later (dates on disk have whole seconds: write a clearly later one).
        let file = dir.appendingPathComponent("profile.json")
        var disk = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        disk["traits"] = (disk["traits"] as? [[String: Any]] ?? []).map { t in
            var t = t
            if (t["path"] as? [String]) == ["B"] { t["value"] = "newer"; t["updated"] = "2100-01-01T00:00:00Z" }
            return t
        }
        try? JSONSerialization.data(withJSONObject: disk).write(to: file)

        c.reload()                                           // takes the removal and the newer value
        XCTAssertNil(c.traits["a"])
        XCTAssertEqual(c.traits["b"]?.value, "newer")

    }

    func testCorruptFileIsIgnored() {
        let dir = TestEnv.tempDir("profile")
        try? Data("{".utf8).write(to: dir.appendingPathComponent("profile.json"))
        let p = Profile(dir: dir)
        XCTAssertTrue(p.traits.isEmpty)
    }

    /// Whole numbers read back from disk are Ints: they still compare as numbers.
    func testMergeBaselineAfterARoundTrip() {
        let dir = TestEnv.tempDir("profile")
        let a = Profile(dir: dir)
        a.baseline = ["typing": AnyCodable(["n": 3.0]), "hours": AnyCodable([2.0, 7.0])]
        a.persist()
        let m = Profile.mergeBaseline(["typing": ["n": 2.5], "hours": [4.0, 1.0]], Profile(dir: dir).baseline.mapValues(\.value))
        XCTAssertEqual(((m["typing"] as? [String: Any])?["n"] as? NSNumber)?.doubleValue, 3)
        XCTAssertEqual(m["hours"] as? [Double], [4, 7])
    }

    func testMergeBaseline() {
        let a: [String: Any] = [
            "typing": ["n": 5.0, "mean": 1.0],
            "pointer": ["n": 9.0, "mean": 2.0],
            "hours": [1.0, 5.0, 0.0],
            "screen": [1.0, 2.0],
            "lang": "uk",
        ]
        let b: [String: Any] = [
            "typing": ["n": 8.0, "mean": 3.0],    // more samples: wins
            "pointer": ["n": 2.0, "mean": 7.0],   // fewer: kept
            "hours": [2.0, 4.0, 3.0],             // element-wise max
            "screen": [9.0],                      // different shape: kept
            "lang": "en",                         // not mergeable: kept
            "new": 1,                             // added
        ]
        let m = Profile.mergeBaseline(a, b)
        XCTAssertEqual((m["typing"] as? [String: Any])?["mean"] as? Double, 3)
        XCTAssertEqual((m["pointer"] as? [String: Any])?["mean"] as? Double, 2)
        XCTAssertEqual(m["hours"] as? [Double], [2, 5, 3])
        XCTAssertEqual(m["screen"] as? [Double], [1, 2])
        XCTAssertEqual(m["lang"] as? String, "uk")
        XCTAssertEqual(m["new"] as? Int, 1)
    }
}
