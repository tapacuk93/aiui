import XCTest
@testable import AIUI

/// The /api/<name> endpoints other than `ai` and `engine`.
final class APIEndpointTests: APITestCase {
    func testInfo() {
        makeAPI()
        let j = call("info").json
        XCTAssertEqual(j["ai"] as? String, "Fake claude")
        XCTAssertEqual(j["engine"] as? String, "CEF/Blink")
        XCTAssertEqual(j["language"] as? String, api.language)
        XCTAssertEqual(j["home"] as? String, NSHomeDirectory())
    }

    func testUnknownEndpointAndBadBody() {
        makeAPI()
        let a = Answer()
        api.handleAPI("nope", body: Data("garbage".utf8)) { s, _, d in a.status = s; a.data = d }
        XCTAssertEqual(a.status, 404)
        XCTAssertEqual(a.error, "unknown endpoint")
    }

    func testDispatchToOtherModules() {
        makeAPI()
        XCTAssertEqual(call("shared").status, 200)
        XCTAssertEqual(call("people").status, 200)
        let sys = call("sys", ["op": "bogus"])
        XCTAssertEqual(sys.status, 500)
        XCTAssertEqual(sys.error, "unknown op bogus")
        XCTAssertEqual(call("native").status, 200)
    }

    // MARK: Side engines

    func testSideEnginesCarryContext() {
        makeAPI()
        scene("Weather forecast", kind: "circles")      // memory + flows
        api.avoid.record([["url": "https://bad.example/x.js", "reason": "403"]])
        api.hints.applyRetro(["hints": [["text": "Show units", "scope": "all"]]])
        let tester = fake(api.tester)
        tester.succeed(["tests": []])
        let a = call("tests", ["path": ["Weather"], "target": ["label": "forecast"], "screen": ["title": "Weather"]])
        XCTAssertEqual(a.status, 200)
        XCTAssertNotNil(a.json["tests"])
        let input = tester.lastInput
        XCTAssertTrue(tester.prompts[0].hasPrefix("What should be tested for this scene? Write its tests:"))
        XCTAssertEqual(input["language"] as? String, api.language)
        XCTAssertEqual((input["memory"] as? [Any])?.count, 1)
        XCTAssertEqual((input["flows"] as? [Any])?.count, 1)
        XCTAssertEqual((input["avoid"] as? [String])?.count, 2)
        XCTAssertNotNil(input["libraries"])
        XCTAssertNotNil(input["native"])
        XCTAssertEqual(input["hints"] as? [String], ["Show units (all, ×1)"])

        tester.failWith("boom")
        let f = call("tests", [:])
        XCTAssertEqual(f.status, 500)
        XCTAssertEqual(f.error, "boom")
    }

    func testSideEnginesWithEmptyContext() {
        makeAPI()
        for (path, engine, intro) in [("menus", api.menus, "Design the context menus"),
                                      ("quick", api.quick, "The full answer to this event is taking long"),
                                      ("prefetch", api.scout, "The cursor is heading for this circle"),
                                      ("refine", api.refiner, "Refine the circles")] {
            let e = fake(engine)
            e.succeed(["ok": path])
            XCTAssertEqual(call(path).json["ok"] as? String, path)
            XCTAssertTrue(e.prompts[0].hasPrefix(intro), path)
            XCTAssertNil(e.lastInput["memory"])
            XCTAssertNil(e.lastInput["flows"])
            XCTAssertNil(e.lastInput["avoid"])
            XCTAssertNil(e.lastInput["hints"])
        }
    }

    func testNoAI() {
        TestEnv.removeFake("claude")
        makeAPI()
        for p in ["suggest", "tests", "translate", "console", "more", "ai", "revise"] {
            let a = call(p)
            XCTAssertEqual(a.status, 500, p)
            XCTAssertEqual(a.error, "no-ai", p)
        }
        XCTAssertEqual(call("profile", ["op": "learn"]).error, "no-ai")
    }

    func testRevise() {
        makeAPI()
        let reviser = fake(api.reviser)
        let body: [String: Any] = ["event": "open", "path": ["News"]]
        reviser.succeed(["kind": "circles", "title": "News", "reuse": "x", "merge": "y", "publish": [], "circles": []])
        let a = call("revise", body)
        let key = a.json["key"] as? String
        XCTAssertEqual(key, Cache.key(for: Cache.action(from: body.merging(["language": api.language]) { _, b in b })))
        XCTAssertEqual((a.json["screen"] as? [String: Any])?["reuse"] as? String, "x")   // the page gets it as is
        let stored = api.cache.raw(key!)
        XCTAssertEqual(stored?["title"] as? String, "News")
        XCTAssertNil(stored?["reuse"]); XCTAssertNil(stored?["merge"]); XCTAssertNil(stored?["publish"])
        // Not a screen: not stored.
        reviser.succeed(["nothing": true])
        let b = call("revise", ["event": "open", "path": ["Other"]])
        XCTAssertNil(api.cache.raw(b.json["key"] as! String))
    }

    func testSuggest() {
        makeAPI()
        scene("Recipes pasta", kind: "circles")
        let s = fake(api.suggester)
        s.succeed(["circles": [["label": "pasta"]]])
        let a = call("suggest", ["path": ["Recipes"], "input": "pasta"])
        XCTAssertEqual((a.json["circles"] as? [Any])?.count, 1)
        XCTAssertTrue(s.prompts[0].hasPrefix("The user is typing on this screen."))
        XCTAssertNotNil(s.lastInput["memory"])
        XCTAssertNotNil(s.lastInput["flows"])
        s.failWith("slow")
        XCTAssertEqual(call("suggest").error, "slow")
        XCTAssertNil(s.lastInput["memory"])
    }

    func testTranslate() {
        makeAPI()
        let t = fake(api.translator)
        t.succeed(["texts": ["Привіт"]])
        XCTAssertEqual(call("translate", ["texts": ["Hello"], "to": "uk"]).json["texts"] as? [String], ["Привіт"])
        XCTAssertEqual(t.lastInput["to"] as? String, "uk")
        t.failWith("nope")
        XCTAssertEqual(call("translate").error, "nope")
    }

    func testConsole() {
        makeAPI()
        let c = fake(api.console)
        c.progressLines = ["reading"]
        c.succeed(["text": "done"])
        XCTAssertEqual(call("console", ["command": "ls"]).json["text"] as? String, "done")
        XCTAssertEqual(c.lastInput["command"] as? String, "ls")
        XCTAssertEqual(events("consoleProgress").first?["text"] as? String, "reading")
        c.failWith("bad")
        XCTAssertEqual(call("console").error, "bad")
    }

    func testMore() {
        makeAPI()
        scene("Movies list", kind: "circles")
        let p = fake(api.pager)
        p.succeed(["circles": [], "more": false])
        XCTAssertEqual(call("more", ["path": ["Movies"], "screen": ["title": "list"]]).json["more"] as? Bool, false)
        XCTAssertTrue(p.prompts[0].hasPrefix("The user scrolled past the end of this screen."))
        XCTAssertNotNil(p.lastInput["memory"])
        p.failWith("x")
        XCTAssertEqual(call("more").error, "x")
    }

    func testCancel() {
        makeAPI()
        let flags: [(String, AIEngine?)] = [("pager", api.pager), ("suggest", api.suggester), ("scout", api.scout),
                                            ("refine", api.refiner), ("reviser", api.reviser), ("quick", api.quick),
                                            ("tester", api.tester), ("menus", api.menus)]
        for (flag, e) in flags {
            let before = fake(e).cancels
            XCTAssertEqual(call("cancel", [flag: true]).json["ok"] as? Bool, true)
            XCTAssertEqual(fake(e).cancels, before + 1, flag)
        }
        call("cancel")
        XCTAssertEqual(fake(api.claude).cancels, 1)
    }

    // MARK: Profile

    func testProfileEndpoint() {
        makeAPI()
        XCTAssertEqual(call("profile", ["op": "baseline", "baseline": ["typing": ["n": 4.0]]]).json["ok"] as? Bool, true)
        XCTAssertEqual(call("profile", ["op": "baseline"]).json["ok"] as? Bool, true)   // nothing given
        XCTAssertEqual(((call("profile").json["baseline"] as? [String: Any])?["typing"] as? [String: Any])?["n"] as? Double, 4)

        let profiler = fake(api.profiler)
        profiler.succeed(["updates": [["path": ["Interests", "Chess"], "value": "plays", "confidence": 0.8]]])
        let learned = call("profile", ["op": "learn", "behavior": ["clicks": 3]])
        XCTAssertEqual(learned.json["traits"] as? [String], ["Interests › Chess: plays (0.8)"])
        XCTAssertEqual((profiler.lastInput["behavior"] as? [String: Any])?["clicks"] as? Int, 3)
        profiler.failWith("later")
        XCTAssertEqual(call("profile", ["op": "learn"]).error, "later")

        XCTAssertEqual(call("profile", ["op": "tree", "path": ["Interests"]]).json["total"] as? Int, 1)
        let afterRemove = call("profile", ["op": "remove", "path": ["Interests", "Chess"]]).json
        XCTAssertEqual(afterRemove["total"] as? Int, 0)
        XCTAssertEqual((call("profile").json["traits"] as? [Any])?.count, 0)
    }

    // MARK: State endpoints

    func testSystem() {
        makeAPI()
        let j = call("system").json
        XCTAssertEqual((j["app"] as? [String: Any])?["generation"] as? String, Prompts.generation)
        XCTAssertTrue(((j["app"] as? [String: Any])?["platform"] as? String)?.hasPrefix("macOS") ?? false)
        XCTAssertEqual(((j["ai"] as? [String: Any])?["active"] as? [String: Any])?["id"] as? String, "claude")
        XCTAssertEqual((j["storage"] as? [String: Any])?["root"] as? String, support.path)
        XCTAssertEqual((j["libraries"] as? [String: Any])?["installed"] as? Int, 0)
        for k in ["cache", "utilities", "profile", "avoid", "hints"] { XCTAssertNotNil(j[k], k) }
    }

    func testAppStoreEndpoint() {
        makeAPI()
        XCTAssertEqual(call("app", ["op": "set"]).error, "key required")
        XCTAssertEqual(call("app", ["op": "set", "key": "volume", "value": 0.7]).json["ok"] as? Bool, true)
        call("app", ["op": "set", "key": "cleared"])
        XCTAssertEqual(call("app", ["key": "volume"]).json["value"] as? Double, 0.7)
        XCTAssertTrue(call("app", ["key": "missing"]).json["value"] is NSNull)
        let all = call("app", ["op": "all"]).json["values"] as? [String: Any]
        XCTAssertEqual(all?["volume"] as? Double, 0.7)
        XCTAssertTrue(all?["cleared"] is NSNull)
    }

    func testUsageEndpoint() {
        makeAPI()
        let key = scene("Clock")
        api.cache.replace(key, with: ["kind": "html", "html": "<div>clock</div>", "improve": ["every": 120, "curve": "linear"]])
        // record: the schedule the applet declares is taken.
        XCTAssertEqual(call("usage", ["key": key, "dwellMs": 120_000.0, "interactions": 4]).json["ok"] as? Bool, true)
        XCTAssertEqual(api.usage.scene(key)?.schedule?.curve, "linear")
        call("usage", ["key": "unknown"])               // recorded, nothing cached for it
        XCTAssertEqual((call("usage", ["op": "list"]).json["scenes"] as? [Any])?.count, 2)
        XCTAssertEqual(((call("usage", ["op": "applets"]).json["applets"] as? [[String: Any]])?.first)?["title"] as? String, "Clock")
        let sch = call("usage", ["op": "schedule", "key": key]).json["schedule"] as? [String: Any]
        XCTAssertEqual(sch?["key"] as? String, key)
        XCTAssertTrue(call("usage", ["op": "schedule", "key": "nope"]).json["schedule"] is NSNull)
        XCTAssertEqual((call("usage", ["op": "outcome", "key": key]).json["screen"] as? [String: Any])?["html"] as? String, "<div>clock</div>")
        XCTAssertTrue(call("usage", ["op": "outcome"]).json["screen"] is NSNull)

        // improve now: runs the improver for it.
        let improver = fake(api.improver)
        api.usage.setPaused(key, true)
        XCTAssertEqual(call("usage", ["op": "improve", "key": key]).json["ok"] as? Bool, true)
        XCTAssertEqual(improver.prompts.count, 1)
        // pause while it is being improved: cancelled.
        XCTAssertEqual(call("usage", ["op": "pause", "key": key]).json["ok"] as? Bool, true)
        XCTAssertEqual(improver.cancels, 1)
        XCTAssertEqual(api.usage.scene(key)?.paused, true)
        call("usage", ["op": "pause", "key": key, "on": false])
        XCTAssertNil(api.usage.scene(key)?.paused)
        XCTAssertEqual(improver.cancels, 1)
        call("usage", ["op": "pause"])
        call("usage", ["op": "improve"])
    }

    func testNetworkEndpoint() {
        makeAPI()
        let net = NetworkControl.shared
        let savedRequest = net.requestLocation, savedAuth = net.authorization
        defer { net.requestLocation = savedRequest; net.authorization = savedAuth }
        var asked = 0
        net.requestLocation = { asked += 1 }
        net.authorization = { .authorizedAlways }
        XCTAssertEqual(call("network").json["wifi"] as? Bool, false)
        XCTAssertEqual(call("network", ["op": "scan"]).json["error"] as? String, "no Wi-Fi interface")
        XCTAssertEqual(call("network", ["op": "connect", "ssid": "x"]).json["error"] as? String, "no Wi-Fi interface")
        XCTAssertEqual(call("network", ["op": "power", "on": false]).json["ok"] as? Bool, true)
        XCTAssertEqual(call("network", ["op": "location"]).json["ok"] as? Bool, true)
        waitUntil { asked == 1 }
    }

    func testLive() {
        makeAPI()
        let key = scene("Stopwatch")
        api.cache.replace(key, with: ["kind": "html", "html": "<div/>", "improve": ["every": 60, "curve": "constant"]])
        UserDefaults.standard.set(42.0, forKey: "integration")
        let j = call("live").json
        XCTAssertEqual(j["engine"] as? String, "claude")
        XCTAssertEqual(j["integration"] as? Double, 42)
        XCTAssertEqual(j["paused"] as? Bool, false)
        XCTAssertNil(j["scene"])
        XCTAssertNotNil(j["process"])
        let scene = call("live", ["key": key]).json["scene"] as? [String: Any]
        XCTAssertEqual(scene?["opens"] as? Int, 1)
        XCTAssertEqual(scene?["findings"] as? Int, 0)
        XCTAssertEqual((scene?["schedule"] as? [String: Any])?["curve"] as? String, "constant")
        XCTAssertEqual((call("live", ["key": "unknown"]).json["scene"] as? [String: Any])?.count, 0)
        XCTAssertNil(call("live", ["key": ""]).json["scene"])
    }

    func testActivityQuickActions() {
        makeAPI()
        let key = scene("Game")
        api.improveIfDue()                              // held: improving `key`
        let pairs: [(String, String, AIEngine?)] = [("improve", "cancel", api.improver), ("component", "cancel", api.componentImprover),
                                                    ("retro", "cancel", api.retro), ("librarian", "cancel", api.librarian)]
        for (id, action, e) in pairs {
            XCTAssertEqual(call("activity", ["id": id, "action": action]).json["ok"] as? Bool, true)
            XCTAssertEqual(fake(e).cancels, 1, id)
        }
        call("activity", ["id": "improve", "action": "pause"])
        XCTAssertEqual(api.usage.scene(key)?.paused, true)
        XCTAssertEqual(fake(api.improver).cancels, 2)
        XCTAssertEqual(call("activity", ["id": "native-ffmpeg", "action": "cancel"]).json["ok"] as? Bool, true)
        XCTAssertEqual(call("activity", ["id": "other"]).json["ok"] as? Bool, true)
        fake(api.improver).answer(.failure(aiError("cancelled")))
        call("activity", ["id": "improve", "action": "pause"])   // nothing being improved
        XCTAssertEqual(fake(api.improver).cancels, 3)
    }

    func testLibrariesEndpoint() {
        makeAPI()
        API.paused = true                               // no catalog discovery during the test
        XCTAssertNotNil(call("libraries").json["libraries"])
        let tags = call("libraries", ["op": "ensure", "ids": ["left-pad"]]).json["tags"] as? [[String: String]]
        XCTAssertEqual(tags?.first?["src"], "https://cdn.jsdelivr.net/npm/left-pad")
        XCTAssertNotNil(call("libraries", ["op": "remove", "id": "x"]).json["libraries"])
        XCTAssertNotNil(call("libraries", ["op": "install", "id": "not-in-catalog"]).json["libraries"])
        XCTAssertNotNil(call("libraries", ["op": "maintain"]).json["budget"])
    }

    func testAvoidEndpoint() {
        makeAPI()
        XCTAssertEqual(call("avoid", ["op": "record", "items": [["url": "https://x.test/a.js", "reason": "dns"]]]).json["ok"] as? Bool, true)
        let list = call("avoid").json
        XCTAssertEqual((list["entries"] as? [Any])?.count, 2)
        XCTAssertEqual((list["active"] as? [Any])?.count, 2)
        XCTAssertEqual(call("avoid", ["op": "recheck"]).json["ok"] as? Bool, true)
        XCTAssertEqual(call("avoid", ["op": "clear"]).json["ok"] as? Bool, true)
        XCTAssertEqual((call("avoid").json["entries"] as? [Any])?.count, 0)
    }

    func testWindowEndpoint() {
        makeAPI()
        XCTAssertEqual(call("window", ["op": "address", "items": ["Home"]]).json["native"] as? Bool, false)
        var shown: ([String], [(String, String)])?
        API.setAddress = { shown = ($0, $1) }
        let a = call("window", ["op": "address", "items": ["Home", "Music"], "others": [["title": "Mail", "full": "Home › Mail"], [:]]])
        XCTAssertEqual(a.json["native"] as? Bool, true)
        waitUntil { shown != nil }
        XCTAssertEqual(shown?.0, ["Home", "Music"])
        XCTAssertEqual(shown?.1.map { $0.0 }, ["Mail", ""])
        XCTAssertEqual(shown?.1.map { $0.1 }, ["Home › Mail", ""])

        XCTAssertEqual(call("window", ["op": "pause"]).json["paused"] as? Bool, true)      // toggles
        XCTAssertTrue(API.paused)
        XCTAssertEqual(call("window", ["op": "pause", "on": false]).json["paused"] as? Bool, false)
        XCTAssertEqual(UserDefaults.standard.bool(forKey: "paused"), false)

        XCTAssertEqual(call("window", ["op": "budget", "gb": 3.5]).json["budgetGB"] as? Double, 3.5)
        XCTAssertEqual(call("window", ["op": "budget"]).json["budgetGB"] as? Double, 3.5)

        var full: Bool?
        API.setFullScreen = { full = $0 }
        XCTAssertEqual(call("window", ["on": false]).json["ok"] as? Bool, true)
        waitUntil { full == false }
        call("window")
        waitUntil { full == true }
    }

    func testUtilitiesEndpoint() {
        makeAPI()
        let id = api.utilities.publish(from: ["publish": [["name": "fmt", "path": ["text"], "code": "export const f = 1"]]])[0]
        let bundle = call("utilities", ["op": "bundle", "ids": [id]]).json
        XCTAssertFalse(bundle.isEmpty)
        XCTAssertEqual(call("utilities", ["op": "feedback", "ids": [id], "findings": ["slow"], "scores": ["speed": 2, "bad": "x"]]).json["ok"] as? Bool, true)
        XCTAssertEqual(api.utilities.module(id)?.findings ?? [], ["slow"])
        XCTAssertEqual(api.utilities.module(id)?.scores?["speed"], 2)
        XCTAssertNil(api.utilities.module(id)?.scores?["bad"])
        XCTAssertFalse(call("utilities", ["path": ["text"]]).json.isEmpty)
        call("utilities", ["op": "delete", "id": id])
        XCTAssertNil(api.utilities.module(id))
    }

    func testCacheEndpoint() {
        makeAPI()
        scene("Podcasts", kind: "circles")
        XCTAssertEqual((call("cache", ["op": "search", "q": "podcasts"]).json["results"] as? [Any])?.count, 1)
        XCTAssertTrue(call("cache", ["op": "likely", "path": ["Nowhere"]]).json["label"] is NSNull)
        XCTAssertEqual(call("cache").json["entries"] as? Int, 1)
        XCTAssertEqual(call("cache", ["op": "invalidate", "action": ["event": "open", "path": ["Podcasts"]]]).json["ok"] as? Bool, true)
        XCTAssertEqual(call("cache").json["entries"] as? Int, 0)
        scene("Again", kind: "circles")
        XCTAssertEqual(call("cache", ["op": "clear"]).json["entries"] as? Int, 0)
    }

    // MARK: Helpers

    func testEmitAndPrompt() {
        originalEvalJS("window.aiui && aiui._event({})")   // without a page: ignored
        API.emit(["type": "ok", "n": 1])
        XCTAssertEqual(events("ok").first?["n"] as? Int, 1)
        let p = API.prompt(for: ["b": 1, "a": 2])
        XCTAssertTrue(p.hasPrefix("UI event from aiui:\n```json\n{\n  \"a\" : 2,"))
        XCTAssertTrue(p.hasSuffix("Do what it needs, then return the next screen."))
    }
}
