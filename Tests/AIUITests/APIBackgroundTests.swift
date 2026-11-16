import XCTest
@testable import AIUI

/// Background work: applet and component improvements, the retrospective, the unity pass, sync.
final class APIBackgroundTests: APITestCase {
    // MARK: Applet improvements

    func testImproveSuccessReplacesTheScene() {
        makeAPI()
        let key = scene("Game", html: "<div>v1</div>")
        try? Data([0xFF, 0xD8]).write(to: api.usage.shot(key))
        api.hints.applyRetro(["hints": [["text": "Bigger buttons", "scope": "html"]]])
        let improver = fake(api.improver)
        improver.succeed(["kind": "html", "html": "<div>v2</div>", "title": "Game",
                          "publish": [["name": "board", "path": ["games"], "code": "export const board = 1"]],
                          "improve": ["every": 600, "curve": "constant"]])
        api.improveTick()
        XCTAssertEqual(improver.prompts.count, 1)
        let input = improver.lastInput
        XCTAssertEqual((input["scene"] as? [String: Any])?["html"] as? String, "<div>v1</div>")
        XCTAssertEqual((input["usage"] as? [String: Any])?["opens"] as? Int, 1)
        XCTAssertEqual(input["screenshot"] as? String, api.usage.shot(key).path)
        XCTAssertEqual(input["hints"] as? [String], ["Bigger buttons (html, ×1)"])
        XCTAssertTrue(improver.prompts[0].contains("Look at the live screenshot at \(api.usage.shot(key).path)"))

        let stored = api.cache.raw(key)
        XCTAssertEqual(stored?["html"] as? String, "<div>v2</div>")
        XCTAssertNil(stored?["publish"])
        XCTAssertEqual(api.utilities.count, 1)
        XCTAssertEqual(api.usage.scene(key)?.improves, 1)
        XCTAssertEqual(api.usage.scene(key)?.schedule?.curve, "constant")
        XCTAssertEqual(events("improved").first?["key"] as? String, key)
        let act = events("activity").filter { $0["id"] as? String == "improve" }
        XCTAssertEqual(act.map { $0["done"] as? Bool }, [false, true])
        XCTAssertEqual(act.first?["detail"] as? String, "v2")
        XCTAssertEqual(act.first?["actions"] as? [String], ["cancel", "pause"])
        // Not due any more.
        api.improveIfDue()
        XCTAssertEqual(improver.prompts.count, 1)
    }

    func testImproveFailureDefers() {
        makeAPI()
        let key = scene("Notes")
        let improver = fake(api.improver)
        improver.failWith("busy")
        api.improveIfDue()
        XCTAssertEqual(improver.prompts.count, 1)
        XCTAssertFalse(improver.prompts[0].contains("screenshot"))
        XCTAssertGreaterThan(api.usage.scene(key)?.nextImprove ?? .distantPast, Date())
        XCTAssertEqual(api.cache.raw(key)?["html"] as? String, "<div>app</div>")
        XCTAssertTrue(events("improved").isEmpty)
        // A non-HTML answer counts as a failure too.
        api.usage.improveNow(key)
        improver.succeed(["kind": "circles"])
        api.improveIfDue()
        XCTAssertEqual(api.usage.scene(key)?.improves, 0)
    }

    func testImproveWaitsForTheRunningOneAndSkipsNonApplets() {
        makeAPI()
        scene("Menu", kind: "circles")
        let improver = fake(api.improver)
        api.improveIfDue()
        XCTAssertTrue(improver.prompts.isEmpty)        // not an applet
        let game = scene("Game")
        api.usage.record(["key": game, "opened": true])   // used more: most due
        api.improveIfDue()
        api.improveIfDue()                             // the first is still running
        XCTAssertEqual(improver.prompts.count, 1)
        API.paused = true
        improver.answer(.failure(aiError("x")))
        api.usage.improveNow(game)
        api.improveTick()                              // paused: nothing
        XCTAssertEqual(improver.prompts.count, 1)
    }

    func testImproveWithoutAI() {
        TestEnv.removeFake("claude")
        makeAPI()
        scene("Game")
        api.improveIfDue()
        api.improveComponentIfDue()
        api.retrospectIfDue(force: true)
        api.reviewLibraryIfDue(force: true)
        XCTAssertTrue(events("activity").isEmpty)
    }

    // MARK: Component improvements

    private func dueModule() -> String {
        let id = api.utilities.publish(from: ["publish": [["name": "button", "path": ["ui"], "code": "export const b = 1"]]])[0]
        _ = api.utilities.bundle([id])                 // first use: due now
        return id
    }

    func testComponentImprovement() {
        makeAPI()
        let id = dueModule()
        let ci = fake(api.componentImprover)
        ci.succeed(["code": "export const b = 2 // better and longer", "changes": "rounder"])
        api.improveTick()
        XCTAssertEqual(ci.lastInput["id"] as? String, id)
        XCTAssertEqual(api.utilities.module(id)?.version, 2)
        XCTAssertEqual(api.utilities.module(id)?.code, "export const b = 2 // better and longer")
        let ev = events("componentImproved").first
        XCTAssertEqual(ev?["changes"] as? String, "rounder")
        XCTAssertEqual(ev?["name"] as? String, "button")
        XCTAssertEqual(events("activity").filter { $0["id"] as? String == "component" }.count, 2)
        XCTAssertNil(api.utilities.dueForImprovement())
    }

    func testComponentImprovementFailureReschedules() {
        makeAPI()
        let id = dueModule()
        let ci = fake(api.componentImprover)
        api.improveComponentIfDue()
        api.improveComponentIfDue()                    // one at a time
        XCTAssertEqual(ci.prompts.count, 1)
        ci.answer(.failure(aiError("no")))
        XCTAssertEqual(api.utilities.module(id)?.version, 1)
        XCTAssertNil(api.utilities.dueForImprovement())
        XCTAssertTrue(events("componentImproved").isEmpty)
    }

    // MARK: Retrospective

    func testRetrospective() {
        makeAPI()
        let retro = fake(api.retro)
        api.retrospectIfDue()
        XCTAssertTrue(retro.prompts.isEmpty)          // nothing went wrong yet
        for i in 0..<14 { api.hints.add(kind: "issue", scene: "s\(i)", detail: "broken \(i)") }
        retro.succeed(["hints": [["text": "Check links", "scope": "all"]], "summary": "links break"])
        XCTAssertEqual(call("journal", ["kind": "issue", "scene": "s", "detail": "last"]).json["ok"] as? Bool, true)
        XCTAssertEqual(retro.prompts.count, 1)
        XCTAssertEqual((retro.lastInput["incidents"] as? [Any])?.count, 15)
        XCTAssertEqual(api.hints.lastSummary, "links break")
        XCTAssertEqual(events("activity").filter { $0["id"] as? String == "retro" }.count, 2)

        // Forced from the hints endpoint; one at a time; a failure changes nothing.
        api.retrospectIfDue(force: true)
        api.retrospectIfDue(force: true)
        XCTAssertEqual(retro.prompts.count, 2)
        retro.answer(.failure(aiError("x")))
        XCTAssertEqual(api.hints.lastSummary, "links break")
        retro.succeed(["summary": "again"])
        let h = call("hints", ["op": "retro"])
        XCTAssertEqual(h.json["summary"] as? String, "again")
        XCTAssertEqual(call("hints").json["summary"] as? String, "again")
        XCTAssertEqual(retro.prompts.count, 3)
    }

    // MARK: The unity pass

    func testUnityPassAppliesMergesAndRewrites() {
        makeAPI()
        let a = scene("Timer A", html: String(repeating: "a", count: 100))
        let b = scene("Timer B", html: String(repeating: "b", count: 100))
        scene("Menu", kind: "circles")
        let lib = fake(api.librarian)
        let newHTML = "<div>" + String(repeating: "shared ", count: 10) + "</div>"
        lib.succeed(["integration": 140, "remaining": "two timers",
                     "sceneMerges": [["from": a, "into": b, "why": "same purpose"],
                                     ["from": "unknown", "into": b], ["from": b, "into": b]],
                     "scenes": [["key": b, "html": newHTML, "uses": ["ui/timer"], "changes": "uses the shared timer"],
                                ["key": b, "html": "short"], ["key": "unknown", "html": newHTML]]])
        XCTAssertEqual(call("utilities", ["op": "review"]).json["ok"] as? Bool, true)
        let input = lib.lastInput
        XCTAssertEqual(Set((input["scenes"] as? [[String: Any]] ?? []).compactMap { $0["key"] as? String }), [a, b])
        XCTAssertNotNil(input["modules"])
        XCTAssertNotNil(input["categories"])

        let d = UserDefaults.standard
        XCTAssertEqual(d.double(forKey: "integration"), 100)
        XCTAssertEqual(d.string(forKey: "integrationRemaining"), "two timers")
        XCTAssertEqual(Set((d.dictionary(forKey: "integratedScenes") ?? [:]).keys), [a, b])
        XCTAssertEqual(api.usage.scene(a)?.mergedInto, b)
        XCTAssertEqual(api.cache.raw(b)?["html"] as? String, newHTML)
        XCTAssertEqual(api.cache.raw(b)?["uses"] as? [String], ["ui/timer"])
        XCTAssertEqual(events("merged").count, 1)
        let improved = events("improved")
        XCTAssertEqual(improved.count, 1)
        XCTAssertEqual(improved.first?["title"] as? String, "Timer B")
        XCTAssertEqual(improved.first?["changes"] as? String, "uses the shared timer")
        let started = { self.events("activity").filter { $0["id"] as? String == "librarian" && $0["done"] as? Bool == false } }
        XCTAssertTrue(started().first?["detail"] is NSNull)   // no level known yet
        api.reviewLibraryIfDue()                       // just ran
        XCTAssertEqual(lib.prompts.count, 1)
        // The next pass shows the integration level.
        lib.succeed([:])
        api.reviewLibraryIfDue(force: true)
        XCTAssertEqual(started().last?["detail"] as? String, "100%")
    }

    func testUnityPassWhenDueAndOneAtATime() {
        makeAPI()
        let lib = fake(api.librarian)
        api.reviewLibraryIfDue()
        XCTAssertTrue(lib.prompts.isEmpty)             // fewer than two applets or modules
        scene("One"); scene("Two")
        // The least recently integrated go first; a scene without stored HTML is left out.
        UserDefaults.standard.set([Cache.key(for: ["event": "open", "path": ["One"], "language": api.language]): 5.0], forKey: "integratedScenes")
        api.usage.record(["key": "nohtml", "title": "Ghost"])
        api.reviewLibraryIfDue()
        api.reviewLibraryIfDue()                       // already running
        XCTAssertEqual(lib.prompts.count, 1)
        let keys = (lib.lastInput["scenes"] as? [[String: Any]] ?? []).compactMap { $0["title"] as? String }
        XCTAssertEqual(keys, ["Two", "One"])
        lib.answer(.failure(aiError("x")))
        XCTAssertNil(UserDefaults.standard.object(forKey: "integration"))
        api.reviewLibraryIfDue()                       // just ran (10 minutes apart while integrating)
        XCTAssertEqual(lib.prompts.count, 1)
        UserDefaults.standard.set(Date.distantPast, forKey: "lastUnityPass")
        api.reviewLibraryIfDue()
        XCTAssertEqual(lib.prompts.count, 2)
    }

    // MARK: Sync

    func testSyncNowRunsBackgroundWorkUnlessPaused() {
        makeAPI()
        for i in 0..<15 { api.hints.add(kind: "issue", scene: "s", detail: "\(i)") }
        scene("Game")
        let retro = fake(api.retro), improver = fake(api.improver)
        API.paused = true
        api.syncNow()
        XCTAssertTrue(retro.prompts.isEmpty)
        XCTAssertTrue(improver.prompts.isEmpty)
        API.paused = false
        api.syncNow()
        XCTAssertEqual(retro.prompts.count, 1)
        XCTAssertEqual(improver.prompts.count, 1)
    }

    func testSyncNowReloadsWhatOtherDevicesWrote() {
        makeAPI()
        API.paused = true
        let other = AppStore(dir: support.appendingPathComponent("app", isDirectory: true))
        other.set("theme", "dark")
        api.syncNow()
        XCTAssertEqual(api.appStore.get("theme") as? String, "dark")
        let ev = events("appChanged")
        XCTAssertEqual(ev.first?["key"] as? String, "theme")
        XCTAssertEqual(ev.first?["value"] as? String, "dark")
    }

    func testResetAndShutdown() {
        makeAPI()
        api.resetSession()
        XCTAssertEqual(fake(api.claude).resets, 1)
        XCTAssertEqual([api.pager, api.suggester, api.scout, api.refiner].map { fake($0).cancels }, [1, 1, 1, 1])
        XCTAssertEqual(call("reset").json["ok"] as? Bool, true)
        XCTAssertEqual(fake(api.claude).resets, 2)
        api.shutdown()
        XCTAssertEqual(fake(api.console).cancels, 1)
        XCTAssertEqual(fake(api.claude).cancels, 1)
    }
}
