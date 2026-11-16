import XCTest
@testable import AIUI

final class UtilitiesTests: AIUITestCase {
    private func mod(_ path: [String], _ name: String, _ code: String = "function f(){ return 1 }", _ extra: [String: Any] = [:]) -> [String: Any] {
        ["path": path, "name": name, "code": code, "description": "does \(name)", "usage": "\(name)()"].merging(extra) { $1 }
    }

    func testPublishAndBundle() {
        let dir = TestEnv.tempDir()
        let u = Utilities(dir: dir)
        XCTAssertEqual(u.publish(from: [:]), [])
        let ids = u.publish(from: ["publish": [
            mod(["ui", "", "lists", "deep", "deeper"], "list", "ul{}", ["kind": "css", "role": "component"]),
            mod([], "fmt", "x", ["role": "util"]),
            mod(["a"], "plain"),
            ["name": "", "code": "x"], ["name": "nocode", "code": ""], ["code": "x"],
        ]])
        XCTAssertEqual(ids.count, 3)
        XCTAssertEqual(u.count, 3)
        XCTAssertEqual(u.publishesSinceReview, 3)
        XCTAssertEqual(ids[0], Utilities.id(path: ["ui", "lists", "deep"], name: "list"))
        XCTAssertEqual(u.module(ids[0])?.path, ["ui", "lists", "deep"])
        XCTAssertEqual(u.module(ids[0])?.kind, "css")
        XCTAssertEqual(u.module(ids[0])?.role, "component")
        XCTAssertEqual(u.module(ids[1])?.path, ["misc"])
        XCTAssertEqual(u.module(ids[1])?.role, "util")
        XCTAssertNil(u.module(ids[2])?.role)
        XCTAssertEqual(u.module(ids[2])?.kind, "js")

        // Republishing keeps what isn't given and bumps the version.
        u.publish(from: ["publish": [["path": ["ui", "lists", "deep"], "name": "list", "code": "ul{margin:0}"]]])
        let m = u.module(ids[0])
        XCTAssertEqual(m?.version, 2)
        XCTAssertEqual(m?.role, "component")
        XCTAssertEqual(m?.description, "does list")
        XCTAssertEqual(m?.usage, "list()")
        XCTAssertEqual(m?.kind, "js", "kind defaults to js")

        let b = u.bundle([ids[2], "ui/lists/deep/list", ids[2], "nope", "x/nope", ids[1]])
        XCTAssertEqual(b["ids"] as? [String], [ids[2], ids[0], ids[1]])
        XCTAssertEqual(b["missing"] as? [String], [ids[2], "nope", "x/nope"])
        XCTAssertTrue((b["js"] as? String)?.contains("/* a/plain v1 */\nfunction f(){ return 1 }") == true)
        XCTAssertTrue((b["js"] as? String)?.contains("\n;\n") == true)
        XCTAssertEqual(u.module(ids[2])?.uses, 1)
        XCTAssertEqual(u.module(ids[2])?.usedSinceImprove, 1)
        XCTAssertNotNil(u.module(ids[2])?.firstUsed)
        let b2 = u.bundle([ids[2]])
        XCTAssertEqual(u.module(ids[2])?.uses, 2)
        XCTAssertEqual(b2["css"] as? String, "")
        let css = u.bundle(["nothing"])
        XCTAssertEqual(css["ids"] as? [String], [])

        // Persisted: a new instance reads the same modules.
        let again = Utilities(dir: dir)
        XCTAssertEqual(again.count, 3)
        XCTAssertEqual(again.module(ids[2])?.uses, 2)
        XCTAssertEqual(Set(again.all.map(\.id)), Set(ids))
    }

    func testOverviewCategoriesTreeAndDelete() {
        let u = Utilities(dir: TestEnv.tempDir())
        let ids = u.publish(from: ["publish": [
            mod(["ui", "lists"], "list", "ul{}", ["kind": "css"]),
            mod(["ui"], "button", "x", ["role": "component", "usage": ""]),
            mod(["data"], "chart"),
            mod(["data"], "table"),
            mod([], "top"),
        ]])
        u.bundle([ids[2], ids[2], ids[3]])
        let ov = u.overview(["chart"], limit: 2)
        XCTAssertEqual(ov.count, 2)
        XCTAssertEqual(ov[0], "data › chart (util, js, v1) — does chart · usage: chart() [\(ids[2])]")
        let all = u.overview([])
        XCTAssertTrue(all.contains("ui › lists › list (component, css, v1) — does list · usage: list() [\(ids[0])]"))
        XCTAssertTrue(all.contains("ui › button (component, js, v1) — does button [\(ids[1])]"))
        XCTAssertEqual(u.categories, ["data", "misc", "ui", "ui › lists"])

        let root = u.tree(at: [])
        let cats = root["categories"] as? [[String: Any]] ?? []
        XCTAssertEqual(cats.map { $0["name"] as? String }, ["data", "misc", "ui"])
        XCTAssertEqual(cats.first?["count"] as? Int, 2)
        XCTAssertEqual(root["total"] as? Int, 5)
        XCTAssertEqual(root["lastReview"] as? String, "")
        let data = u.tree(at: ["data"])["utilities"] as? [[String: Any]] ?? []
        XCTAssertEqual(data.map { $0["name"] as? String }, ["chart", "table"])
        XCTAssertEqual(data.first?["icon"] as? String, "🔧")
        XCTAssertEqual(data.first?["description"] as? String, "v1 · does chart")
        let ui = u.tree(at: ["ui"])
        XCTAssertEqual((ui["utilities"] as? [[String: Any]])?.first?["icon"] as? String, "🧩")
        XCTAssertEqual((ui["categories"] as? [[String: Any]])?.first?["name"] as? String, "lists")
        let lists = u.tree(at: ["ui", "lists"])["utilities"] as? [[String: Any]] ?? []
        XCTAssertEqual(lists.first?["icon"] as? String, "🧩", "css counts as a component")
        // Equal-uses ties sort by name.
        let misc = u.tree(at: ["misc"])["utilities"] as? [[String: Any]] ?? []
        XCTAssertEqual(misc.count, 1)

        u.delete(ids[4])
        XCTAssertNil(u.module(ids[4]))
        XCTAssertEqual(u.count, 4)
    }

    func testCategoryTiesSortByName() {
        let u = Utilities(dir: TestEnv.tempDir())
        u.publish(from: ["publish": [mod(["b"], "x"), mod(["a"], "y"), mod(["c"], "z"), mod(["c"], "w")]])
        let cats = u.tree(at: [])["categories"] as? [[String: Any]] ?? []
        XCTAssertEqual(cats.map { $0["name"] as? String }, ["a", "b", "c"])
        let c = u.tree(at: ["c"])["utilities"] as? [[String: Any]] ?? []
        XCTAssertEqual(c.map { $0["name"] as? String }, ["w", "z"])
    }

    func testFeedbackAndImprovementSchedule() {
        let u = Utilities(dir: TestEnv.tempDir())
        let ids = u.publish(from: ["publish": [mod(["a"], "one"), mod(["a"], "two")]])
        XCTAssertNil(u.dueForImprovement(), "not used yet")
        u.bundle(ids)
        u.feedback([ids[0], "nope"], findings: ["slow"], scores: ["speed": 3])
        u.feedback([ids[0]], findings: ["ugly"], scores: ["speed": 6, "look": 1])
        let m = u.module(ids[0])
        XCTAssertEqual(m?.findings, ["slow", "ugly"])
        XCTAssertEqual(m?.scores?["speed"], 4)
        XCTAssertEqual(m?.scores?["look"], 1)
        XCTAssertEqual(u.dueForImprovement()?.id, ids[0], "findings weigh more")
        for _ in 0..<11 { u.bundle([ids[1]]) }
        XCTAssertEqual(u.dueForImprovement()?.id, ids[1])

        let input = u.moduleInput(m!)
        XCTAssertEqual(input["id"] as? String, ids[0])
        XCTAssertEqual(input["findings"] as? [String], ["slow", "ugly"])
        XCTAssertEqual((u.moduleInput(u.module(ids[1])!)["scores"] as? [String: Double])?.count, 0)

        u.applyImprovement("nope", ["code": String(repeating: "x", count: 30)])
        // Too short: not applied, but the schedule moves on.
        u.applyImprovement(ids[0], ["code": "short"])
        var after = u.module(ids[0])!
        XCTAssertEqual(after.version, 1)
        XCTAssertEqual(after.improves, 1)
        XCTAssertEqual(after.usedSinceImprove, 0)
        XCTAssertEqual(after.nextImprove!.timeIntervalSinceNow, 300, accuracy: 5)
        let code = "function better(){ return 42 }"
        u.applyImprovement(ids[0], ["code": code, "description": "better", "usage": "better()"])
        after = u.module(ids[0])!
        XCTAssertEqual(after.code, code)
        XCTAssertEqual(after.version, 2)
        XCTAssertEqual(after.description, "better")
        XCTAssertEqual(after.usage, "better()")
        XCTAssertEqual(after.findings, [])
        u.applyImprovement(ids[0], ["code": code + " ", "description": "", "usage": ""])
        XCTAssertEqual(u.module(ids[0])?.description, "better")
        u.applyImprovement(ids[0], nil)
        XCTAssertEqual(u.module(ids[0])?.improves, 4)
        // Not used yet: no first use to measure from.
        let fresh = u.publish(from: ["publish": [mod(["b"], "fresh")]])[0]
        u.applyImprovement(fresh, nil)
        XCTAssertEqual(u.module(fresh)!.nextImprove!.timeIntervalSinceNow, 300, accuracy: 5)
    }

    func testReview() {
        let u = Utilities(dir: TestEnv.tempDir())
        XCTAssertFalse(u.needsReview)
        let ids = u.publish(from: ["publish": [mod(["a"], "one"), mod(["a"], "two", "y", ["role": "util"]), mod(["a"], "three", "z", ["kind": "css"]),
                                               mod(["a"], "four"), mod(["a"], "five"), mod(["a"], "six"), mod(["a"], "seven")]])
        XCTAssertTrue(u.needsReview, "never reviewed")
        u.bundle([ids[0]])
        let input = u.reviewInput()
        XCTAssertEqual(input.count, 7)
        XCTAssertEqual(input.first?["id"] as? String, ids[0])

        let renamed = Utilities.id(path: ["b"], name: "uno")
        let merged = Utilities.id(path: ["a"], name: "pair")
        u.applyReview([
            "updates": [
                ["id": ids[0], "code": "new code", "description": "d", "usage": "u", "path": ["b", ""], "name": "uno"],
                ["id": ids[3], "code": "", "path": [String](), "name": ""],
                ["id": "missing"], ["code": "x"],
            ],
            "merge": [
                ["from": [ids[1], ids[2], "ghost", merged], "into": ["path": ["a"], "name": "pair", "code": "both", "kind": "css",
                                                           "description": "two in one", "usage": "pair()"]],
                ["from": [ids[4]], "into": ["path": [String](), "name": "solo", "code": "s"]],
                ["from": [ids[5]], "into": ["name": "nocode"]],
            ],
            "remove": [ids[6]],
        ])
        XCTAssertFalse(u.needsReview)
        XCTAssertNotNil(u.lastReview)
        XCTAssertEqual(u.publishesSinceReview, 0)
        let uno = u.module(renamed)
        XCTAssertEqual(uno?.code, "new code")
        XCTAssertEqual(uno?.version, 2)
        XCTAssertEqual(uno?.description, "d")
        XCTAssertEqual(uno?.usage, "u")
        XCTAssertEqual(u.module(ids[0])?.id, renamed, "the old id is an alias")
        XCTAssertEqual(u.module(ids[3])?.version, 1, "unchanged")
        let pair = u.module(merged)
        XCTAssertEqual(pair?.kind, "css")
        XCTAssertEqual(pair?.role, "util")
        XCTAssertEqual(pair?.version, 2)
        XCTAssertEqual(pair?.description, "two in one")
        XCTAssertEqual(u.module(ids[1])?.id, merged)
        XCTAssertEqual(u.module(ids[2])?.id, merged)
        let solo = u.module(Utilities.id(path: [], name: "solo"))
        XCTAssertEqual(solo?.path, ["misc"])
        XCTAssertEqual(solo?.version, 2)
        XCTAssertEqual(solo?.description, "")
        XCTAssertEqual(u.module(ids[4])?.id, solo?.id)
        XCTAssertNotNil(u.module(ids[5]), "a merge without code is skipped")
        XCTAssertNil(u.module(ids[6]))
        XCTAssertNotEqual(u.tree(at: [])["lastReview"] as? String, "")
        // An alias chain: the renamed module renamed again.
        u.applyReview(["updates": [["id": renamed, "name": "eins"]]])
        XCTAssertEqual(u.module(ids[0])?.name, "eins")
        XCTAssertEqual(u.bundle(["a/one"])["ids"] as? [String], [Utilities.id(path: ["b"], name: "eins")])
    }

    func testReviewInputIsBounded() {
        let u = Utilities(dir: TestEnv.tempDir())
        let big = String(repeating: "x", count: 70_000)
        u.publish(from: ["publish": [mod(["a"], "one", big), mod(["a"], "two", big), mod(["a"], "three", big)]])
        let input = u.reviewInput()
        XCTAssertEqual(input.count, 2)
        XCTAssertEqual((input.first?["code"] as? String)?.count, 12_000)
    }

    func testNeedsReviewAfterSixPublishesOrADay() {
        let dir = TestEnv.tempDir()
        let u = Utilities(dir: dir)
        u.publish(from: ["publish": [mod(["a"], "one"), mod(["a"], "two")]])
        u.applyReview([:])
        XCTAssertFalse(u.needsReview)
        for i in 0..<6 { u.publish(from: ["publish": [mod(["a"], "one", "v\(i)")]]) }
        XCTAssertTrue(u.needsReview)
        // A review a day ago (from another device's file).
        let url = dir.appendingPathComponent("library.json")
        var d = StoreFiles.json(url) as? [String: Any] ?? [:]
        d["lastReview"] = StoreFiles.iso(Date().addingTimeInterval(-2 * 86_400))
        d["publishesSinceReview"] = 0
        StoreFiles.write(d, url)
        let other = Utilities(dir: dir)
        XCTAssertTrue(other.needsReview)
    }

    func testAdopt() {
        let u = Utilities(dir: TestEnv.tempDir())
        let id = u.adopt(path: ["", "net", "a", "b", "c"], name: "fetch", kind: "js", role: "util", description: "d", usage: "u",
                         code: "x", origin: "g1", originVersion: 3)
        let m = u.module(id)
        XCTAssertEqual(m?.path, ["net", "a", "b"])
        XCTAssertEqual(m?.origin, "g1")
        XCTAssertEqual(m?.originVersion, 3)
        XCTAssertEqual(m?.version, 1)
        let again = u.adopt(path: [], name: "style", kind: "css", role: nil, description: "", usage: "", code: "y", origin: "g2", originVersion: 1)
        XCTAssertEqual(u.module(again)?.path, ["misc"])
        XCTAssertEqual(u.module(again)?.kind, "css")
        XCTAssertEqual(u.adopt(path: ["net", "a", "b"], name: "fetch", kind: "js", role: nil, description: "", usage: "", code: "z",
                               origin: "g1", originVersion: 4), id)
        XCTAssertEqual(u.module(id)?.version, 2)
        let row = (u.tree(at: ["net", "a", "b"])["utilities"] as? [[String: Any]])?.first
        XCTAssertEqual(row?["description"] as? String, "v2 · ↓ global v4 · ")
        XCTAssertEqual(row?["origin"] as? String, "g1")
    }

    func testTrimDropsLeastRecentlyUsedOverTheLimit() {
        let u = Utilities(dir: TestEnv.tempDir())
        let big = String(repeating: "x", count: 1_500_000)
        let ids = u.publish(from: ["publish": [mod(["a"], "one", big), mod(["a"], "two", big)]])
        u.publish(from: ["publish": [mod(["a"], "three", big)]])
        XCTAssertEqual(u.count, 2, "4 MB at most")
        XCTAssertNil(u.module(ids[0]))
        XCTAssertNotNil(u.module(ids[1]))
    }

    func testMergesAnotherDevicesFile() {
        let dir = TestEnv.tempDir()
        let u = Utilities(dir: dir)
        let ids = u.publish(from: ["publish": [mod(["a"], "mine"), mod(["a"], "shared"), mod(["a"], "doomed"), mod(["a"], "used")]])
        u.bundle([ids[3]])
        // The other device: a newer "shared", "doomed" deleted, an alias, an extra module, a later review,
        // an older copy of "used" with more uses, and a stale tombstone for "mine".
        let url = dir.appendingPathComponent("library.json")
        var d = StoreFiles.json(url) as? [String: Any] ?? [:]
        var mods = d["modules"] as? [[String: Any]] ?? []
        let future = StoreFiles.iso(Date().addingTimeInterval(3600)), past = StoreFiles.iso(Date().addingTimeInterval(-3600))
        for i in mods.indices {
            if mods[i]["id"] as? String == ids[1] { mods[i]["updated"] = future; mods[i]["code"] = "theirs" }
            if mods[i]["id"] as? String == ids[3] { mods[i]["updated"] = past; mods[i]["uses"] = 9; mods[i]["code"] = "old" }
        }
        var extra = mods[0]
        let extraID = Utilities.id(path: ["z"], name: "extra")
        extra["id"] = extraID; extra["path"] = ["z"]; extra["name"] = "extra"
        mods.append(extra)
        d["modules"] = mods
        d["deleted"] = [ids[2]: future, ids[0]: past]
        d["aliases"] = ["oldid": ids[1]]
        d["lastReview"] = future
        StoreFiles.write(d, url)

        u.reload()
        XCTAssertEqual(u.module(ids[1])?.code, "theirs")
        XCTAssertNil(u.module(ids[2]))
        XCTAssertNotNil(u.module(ids[0]), "my module is newer than its tombstone")
        XCTAssertEqual(u.module(ids[3])?.code, "function f(){ return 1 }")
        XCTAssertEqual(u.module(ids[3])?.uses, 9)
        XCTAssertNotNil(u.module(extraID))
        XCTAssertEqual(u.module("oldid")?.id, ids[1])
        XCTAssertNotNil(u.lastReview)
        XCTAssertEqual(u.publishesSinceReview, 0)
        // An older review on disk does not replace mine; a newer tombstone in memory survives a stale one on disk.
        d["lastReview"] = past
        d["deleted"] = [ids[2]: past]
        StoreFiles.write(d, url)
        let before = u.lastReview
        u.reload()
        XCTAssertEqual(u.lastReview, before)
        XCTAssertNil(u.module(ids[2]))

        // An unreadable file is ignored.
        try? Data("junk".utf8).write(to: url)
        u.reload()
        XCTAssertNotNil(u.module(ids[1]))
    }

    func testRepublishedInTheSameSecondAsItsDeletionSurvivesOnOtherDevices() {
        let dir = TestEnv.tempDir()
        let u = Utilities(dir: dir)
        let id = u.publish(from: ["publish": [mod(["a"], "back")]])[0]
        u.delete(id)
        _ = u.publish(from: ["publish": [mod(["a"], "back")]])          // within the same second
        XCTAssertNotNil(Utilities(dir: dir).module(id), "another device keeps the re-published module")
    }

    func testAfterDeletion() {
        let now = Date(timeIntervalSince1970: 1_800_000_000.4)
        XCTAssertEqual(afterDeletion(now, nil), now)
        XCTAssertEqual(afterDeletion(now, Date(timeIntervalSince1970: 1_800_000_000.1)).timeIntervalSince1970, 1_800_000_001)
        XCTAssertEqual(afterDeletion(now, Date(timeIntervalSince1970: 1_799_999_990)), now)
    }
}
