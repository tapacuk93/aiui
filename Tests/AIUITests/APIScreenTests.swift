import XCTest
@testable import AIUI

/// The `ai` endpoint (the next screen) and `adopt` (a prefetched screen was opened).
final class APIScreenTests: APITestCase {
    private func key(_ body: [String: Any]) -> String {
        Cache.key(for: Cache.action(from: body.merging(["language": api.language]) { _, b in b }))
    }

    func testCachedScreensAreReplayed() {
        makeAPI()
        let k = scene("Music", kind: "circles", cacheable: true)
        let claude = fake(api.claude)
        for _ in 0..<21 {
            let a = call("ai", ["event": "open", "path": ["Music"]])
            XCTAssertEqual(a.json["cached"] as? Bool, true)
            XCTAssertEqual(a.json["key"] as? String, k)
            XCTAssertNil(a.json["visited"])
        }
        XCTAssertTrue(claude.prompts.isEmpty)
        XCTAssertEqual(fake(api.pager).cancels, 21)
        XCTAssertEqual(fake(api.suggester).cancels, 21)
        // The AI hears about the replays (the last 20) with the next real turn, then they are cleared.
        claude.succeed(["kind": "circles", "title": "Next", "circles": []])
        call("ai", ["event": "open", "path": ["Music"], "fresh": true])
        XCTAssertEqual((claude.lastInput["replayed"] as? [Any])?.count, 20)
        claude.succeed(["kind": "circles", "title": "Next", "circles": []])
        call("ai", ["event": "tap", "path": ["Other"]])
        XCTAssertNil(claude.lastInput["replayed"])
    }

    func testVisitedScreensAreShownAsTheyWere() {
        makeAPI()
        let circles = scene("Settings", kind: "circles")      // not cacheable
        let applet = scene("Paint")
        let a = call("ai", ["event": "open", "path": ["Settings"]]).json
        XCTAssertEqual(a["visited"] as? Bool, true)
        XCTAssertEqual(a["stale"] as? Bool, true)              // circles: revised in the background
        XCTAssertEqual(a["key"] as? String, circles)
        let b = call("ai", ["event": "open", "path": ["Paint"]]).json
        XCTAssertEqual(b["stale"] as? Bool, false)             // an applet keeps its version
        XCTAssertEqual(b["key"] as? String, applet)
        XCTAssertEqual(((b["screen"] as? [String: Any])?["html"]) as? String, "<div>app</div>")
        XCTAssertTrue(fake(api.claude).prompts.isEmpty)
        // A different event on the same path goes to the AI.
        let claude = fake(api.claude)
        claude.succeed(["kind": "circles", "circles": []])
        call("ai", ["event": "back", "path": ["Paint"]])
        XCTAssertEqual(claude.prompts.count, 1)
        XCTAssertEqual((claude.lastInput["replayed"] as? [Any])?.count, 2)
    }

    func testTheEventCarriesContext() {
        makeAPI()
        scene("Recipes soup", kind: "circles")
        scene("Recipe box")                                    // an applet
        api.avoid.record([["url": "https://cdn.bad/x.js", "reason": "403"]])
        api.hints.applyRetro(["hints": [["text": "Prefer photos", "scope": "all"]]])
        api.utilities.publish(from: ["publish": [["name": "card", "path": ["recipes"], "code": "export const c = 1"]]])
        api.profile.merge(["updates": [["path": ["Food"], "value": "vegetarian", "confidence": 0.9]]])
        // Earlier steps of the flow (shallower screens).
        let claude = fake(api.claude)
        claude.progressLines = ["thinking"]
        claude.succeed(["kind": "circles", "circles": []])
        call("ai", ["event": "open", "path": [], "target": ["label": "Recipes"]])
        claude.succeed(["kind": "circles", "circles": []])
        call("ai", ["event": "open", "path": ["Recipes"], "target": ["label": "Soup"], "text": "soup",
                    "userCheck": ["typing": "ok"]])
        let e = claude.lastInput
        XCTAssertEqual(e["language"] as? String, api.language)
        XCTAssertEqual((e["flow"] as? [String])?.count, 1)
        XCTAssertNotNil(e["memory"])
        XCTAssertNotNil(e["flows"])
        XCTAssertTrue((e["applets"] as? [[String: Any]] ?? []).contains { $0["title"] as? String == "Recipe box" })
        XCTAssertEqual((e["avoid"] as? [Any])?.count, 2)
        XCTAssertEqual(e["hints"] as? [String], ["Prefer photos (all, ×1)"])
        XCTAssertEqual((e["library"] as? [Any])?.count, 1)
        XCTAssertNotNil(e["libraryCategories"])
        XCTAssertNotNil(e["libraries"])
        XCTAssertNotNil(e["native"])
        let user = e["user"] as? [String: Any]
        XCTAssertEqual(user?["profile"] as? [String], ["Food: vegetarian (0.9)"])
        XCTAssertEqual((user?["check"] as? [String: Any])?["typing"] as? String, "ok")
        XCTAssertNil(e["userCheck"])
        XCTAssertNil(e["guest"])
        XCTAssertTrue(claude.prompts.last!.hasPrefix("UI event from aiui:"))
        XCTAssertEqual(events("progress").first?["text"] as? String, "thinking")

        // A guest: no profile.
        claude.succeed(["kind": "circles", "circles": []])
        call("ai", ["event": "tap", "path": ["X"], "guest": true])
        let guest = claude.lastInput["user"] as? [String: Any]
        XCTAssertEqual(guest?["guest"] as? Bool, true)
        XCTAssertNil(guest?["profile"])
    }

    func testEmptyContext() {
        makeAPI()
        let claude = fake(api.claude)
        claude.succeed(["kind": "circles", "circles": []])
        call("ai", ["event": "start"])
        let e = claude.lastInput
        for k in ["flow", "memory", "flows", "applets", "avoid", "hints", "library", "user", "replayed", "prefetched"] {
            XCTAssertNil(e[k], k)
        }
    }

    func testNewScreenIsStoredAndPublishes() {
        makeAPI()
        let claude = fake(api.claude)
        claude.succeed(["kind": "html", "title": "Calculator", "html": "<div>calc</div>", "note": "made a calculator",
                        "cacheable": true, "merge": "ignored", "uses": ["old"],
                        "publish": [["name": "keypad", "path": ["ui", ""], "code": "export const k = 1"], ["code": "no name"]]])
        let body: [String: Any] = ["event": "open", "path": ["Calculator"]]
        let a = call("ai", body)
        XCTAssertEqual(a.status, 200)
        let k = key(body)
        XCTAssertEqual(a.json["key"] as? String, k)
        XCTAssertEqual(a.json["published"] as? Int, 1)
        let screen = a.json["screen"] as? [String: Any] ?? [:]
        XCTAssertNil(screen["note"]); XCTAssertNil(screen["cacheable"]); XCTAssertNil(screen["publish"]); XCTAssertNil(screen["merge"])
        let id = Utilities.id(path: ["ui"], name: "keypad")
        XCTAssertEqual(Set(screen["uses"] as? [String] ?? []), ["old", id])
        let stored = api.cache.raw(k)
        XCTAssertEqual(Set(stored?["uses"] as? [String] ?? []), ["old", id])
        XCTAssertNil(stored?["publish"])
        XCTAssertNotNil(api.utilities.module(id))
        // Cacheable: replayed next time.
        XCTAssertEqual(call("ai", body).json["cached"] as? Bool, true)
    }

    func testReuseOfAStoredOutcome() {
        makeAPI()
        let stored = scene("Inbox", kind: "circles")
        let claude = fake(api.claude)
        claude.succeed(["reuse": stored, "title": "Mail", "note": "reused inbox"])
        let a = call("ai", ["event": "tap", "path": ["Home"], "text": "mail"]).json
        let screen = a["screen"] as? [String: Any] ?? [:]
        XCTAssertEqual(screen["title"] as? String, "Mail")                 // overridden
        XCTAssertEqual((screen["circles"] as? [Any])?.count, 1)            // from the stored outcome
        XCTAssertNil(screen["reuse"])
        XCTAssertNil(a["returned"])
        // An unknown key: the screen is used as it came.
        claude.succeed(["reuse": "missing", "kind": "circles", "title": "T"])
        let b = call("ai", ["event": "tap", "path": ["Home"], "text": "other"]).json
        XCTAssertEqual((b["screen"] as? [String: Any])?["title"] as? String, "T")
    }

    func testReturnsToAnExistingApplet() {
        makeAPI()
        let applet = scene("Timer", title: "Kitchen Timer")
        let claude = fake(api.claude)
        // The AI says so (`reuse` + `merge`).
        claude.succeed(["reuse": applet, "merge": "add a second timer"])
        let a = call("ai", ["event": "text", "text": "timer please"]).json
        XCTAssertEqual(a["returned"] as? Bool, true)
        XCTAssertEqual(a["key"] as? String, applet)
        let screen = a["screen"] as? [String: Any] ?? [:]
        XCTAssertEqual(screen["html"] as? String, "<div>app</div>")
        XCTAssertNil(screen["note"])
        XCTAssertEqual(api.usage.scene(applet)?.findings.first, "The user also asked for: add a second timer")
        // Same title as an existing applet: returned to it; the request is what was typed.
        claude.succeed(["kind": "html", "title": "kitchen timer!", "html": "<div>dup</div>"])
        let b = call("ai", ["event": "text", "text": "egg timer"]).json
        XCTAssertEqual(b["key"] as? String, applet)
        XCTAssertEqual(api.usage.scene(applet)?.findings.first, "The user also asked for: egg timer")
        // … or the circle's label.
        claude.succeed(["kind": "html", "title": "Kitchen Timer", "html": "<div>dup</div>"])
        call("ai", ["event": "tap", "target": ["label": "Timers"]])
        XCTAssertEqual(api.usage.scene(applet)?.findings.first, "The user also asked for: Timers")
        claude.succeed(["kind": "html", "title": "Kitchen Timer", "html": "<div>dup</div>"])
        call("ai", ["event": "tap"])
        XCTAssertEqual(api.usage.scene(applet)?.findings.first, "The user also asked for: Timers")   // nothing asked
        // The applet's own key: rebuilt as usual.
        claude.succeed(["kind": "html", "title": "Kitchen Timer", "html": "<div>v2</div>"])
        let c = call("ai", ["event": "open", "path": ["Timer"], "fresh": true]).json
        XCTAssertNil(c["returned"])
        XCTAssertEqual(api.cache.raw(applet)?["html"] as? String, "<div>v2</div>")
    }

    func testFailureAndProgress() {
        makeAPI()
        let claude = fake(api.claude)
        claude.failWith("The AI stopped.")
        let a = call("ai", ["event": "open", "path": ["X"]])
        XCTAssertEqual(a.status, 500)
        XCTAssertEqual(a.error, "The AI stopped.")
    }

    func testAdopt() {
        makeAPI()
        XCTAssertEqual(call("adopt", ["event": "open", "path": ["A"]]).json["ok"] as? Bool, true)
        XCTAssertNil(api.cache.raw(key(["event": "open", "path": ["A"]])))
        for i in 0..<12 {
            call("adopt", ["event": "open", "path": ["P\(i)"], "outcome": ["kind": "circles", "title": "T\(i)", "note": "n\(i)"]])
        }
        XCTAssertEqual(api.cache.raw(key(["event": "open", "path": ["P3"]]))?["title"] as? String, "T3")
        call("adopt", ["event": "open", "path": ["Q"], "outcome": ["kind": "circles", "title": "Titled"]])
        call("adopt", ["event": "open", "path": ["R"], "outcome": ["kind": "circles"]])
        let claude = fake(api.claude)
        claude.succeed(["kind": "circles", "circles": []])
        call("ai", ["event": "open", "path": ["Z"]])
        let pre = claude.lastInput["prefetched"] as? [[String: Any]] ?? []
        XCTAssertEqual(pre.count, 10)
        XCTAssertEqual(pre.suffix(2).map { $0["shown"] as? String }, ["Titled", ""])
        claude.succeed(["kind": "circles", "circles": []])
        call("ai", ["event": "open", "path": ["Z2"]])
        XCTAssertNil(claude.lastInput["prefetched"])                       // told once
    }
}
