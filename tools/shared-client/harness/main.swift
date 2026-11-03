import CryptoKit
import Foundation
import Security

// Tests of the app's client for the shared and users services (tools/shared-client/run.sh):
//   sign   — prints a signed request for a fixed key (verify-sign.mjs checks it with node:crypto)
//   flows  — runs every flow against the stub (stub.mjs): sync, search, adopt (sha mismatch refused),
//            share, withdraw, report, update offer, profile, find, add, mutual, inbox.

let args = CommandLine.arguments
var failures = 0
func check(_ ok: Bool, _ what: String) {
    print((ok ? "  ✓ " : "  ✗ ") + what)
    if !ok { failures += 1 }
}

if args.count > 1, args[1] == "sign" {
    let seed = Data((1...32).map { UInt8($0) })
    let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    let ident = AppIdentity(key: key)
    var out: [[String: Any]] = []
    let cases: [(String, String, String)] = [("POST", "/v1/items", #"{"kind":"util","name":"x"}"#), ("GET", "/v1/contacts", ""),
                                             ("DELETE", "/v1/items/01ABC?x=1", ""), ("PUT", "/v1/profile", #"{"name":"Ünïcode ✓"}"#)]
    for (i, c) in cases.enumerated() {
        let at = Date(timeIntervalSince1970: 1_700_000_000 + Double(i))
        let h = try! ident.headers(method: c.0, path: c.1, body: Data(c.2.utf8), now: at)
        out.append(["method": c.0, "path": c.1, "body": c.2, "headers": h,
                     "message": AppIdentity.message(method: c.0, path: c.1, time: Int64(h["X-AIUI-Time"]!)!, body: Data(c.2.utf8))])
    }
    let o: [String: Any] = ["seedHex": AppIdentity.hex(seed), "id": ident.id!, "cases": out]
    print(String(decoding: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), as: UTF8.self))
    exit(0)
}

let stub = ProcessInfo.processInfo.environment["AIUI_SHARED_URL"]!
/// `real`: against services/local-server.mjs (the backend) instead of stub.mjs; a second user
/// (its own key) seeds items and adds this app. Stub-only checks (a tampered payload, replay) are skipped.
let real = args.count > 2 && args[2] == "real"
let otherUser = AppIdentity(key: Curve25519.Signing.PrivateKey())
let otherIdReal = otherUser.id!
func otherShare(_ body: [String: Any]) async throws -> [String: Any] {
    try await Services.call(Services.sharedURL, "POST", "/v1/items", json: body, signed: true, identity: otherUser)
}
var hiddenId = String(repeating: "cd", count: 32)
func seedReal() async throws {
    _ = try await Services.call(Services.usersURL, "PUT", "/v1/profile", json: ["name": "Olga Tester", "handle": "olga", "findable": true], signed: true, identity: otherUser)
    let hidden = AppIdentity(key: Curve25519.Signing.PrivateKey())
    _ = try await Services.call(Services.usersURL, "PUT", "/v1/profile", json: ["name": "Hidden Hans", "handle": "hans", "findable": false], signed: true, identity: hidden)
    hiddenId = hidden.id!
    _ = try await otherShare(["kind": "util", "name": "formatBytes", "path": ["format", "numbers"], "title": "Format bytes",
        "description": "Turns a byte count into KB/MB/GB text.", "usage": "lib.formatBytes(n)", "libs": [String](), "uses": [String](),
        "payload": ["code": "lib.formatBytes = (n) => Math.round(n/1e3)+' KB';"]])
    _ = try await otherShare(["kind": "component", "name": "starRating", "path": ["ui", "input"], "title": "Star rating",
        "description": "A 1–5 star rating control.", "usage": "lib.starRating(el, o)", "libs": [String](), "uses": [String](),
        "payload": ["code": "lib.starRating = (el, o) => { el.textContent = '★'; };", "css": ".sr-star{color:gold}"]])
    _ = try await otherShare(["kind": "applet", "name": "pomodoro", "path": ["applets"], "title": "Pomodoro timer",
        "description": "A 25/5 focus timer.", "usage": "Open it as an applet.", "libs": [String](), "uses": [String](),
        "payload": ["kind": "html", "title": "Pomodoro timer", "html": "<h1>Pomodoro</h1><script>aiui.ready()</script>", "uses": [String](), "libs": [String]()]])
}
func otherAction(_ action: String, _ me: String) async throws -> String {
    if !real { return (try await test("/test/other", ["action": action, "id": me, "note": "hi from Olga"]))["otherId"] as? String ?? "" }
    switch action {
    case "add": _ = try await Services.call(Services.usersURL, "POST", "/v1/contacts", json: ["id": me, "note": "hi from Olga"], signed: true, identity: otherUser)
    case "remove": _ = try await Services.call(Services.usersURL, "DELETE", "/v1/contacts/\(me)", signed: true, identity: otherUser)
    default: break
    }
    return otherIdReal
}
func bump(_ id: String) async throws {
    if !real { _ = try await test("/test/bump", ["id": id]); return }
    _ = try await otherShare(["kind": "util", "name": "formatBytes", "path": ["format", "numbers"], "title": "Format bytes",
        "description": "Turns a byte count into KB/MB/GB text.", "usage": "lib.formatBytes(n)", "libs": [String](), "uses": [String](),
        "payload": ["code": "lib.formatBytes = (n) => Math.round(n/1e3)+' KB'; // v2"]])
}
func test(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
    var req = URLRequest(url: URL(string: stub + path)!)
    req.httpMethod = "POST"
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (d, _) = try await URLSession.shared.data(for: req)
    return (try JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
}
func stubLog() async throws -> [String: Any] {
    let (d, _) = try await URLSession.shared.data(from: URL(string: stub + "/test/log")!)
    return (try JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
}

let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("aiui-shared-test-\(UUID().uuidString)")
let utilities = Utilities(dir: tmp.appendingPathComponent("utilities"))
let registry = SharedRegistry(dir: tmp.appendingPathComponent("shared"), utilities: utilities)
let people = People(dir: tmp.appendingPathComponent("people"))
var events: [[String: Any]] = []
registry.emit = { events.append($0) }
people.emit = { events.append($0) }
var reviewed: [[String: Any]] = []
registry.review = { input, done in
    reviewed.append(input)
    done(.success(["summary": "test review", "network": "none", "system": "none", "suspicious": [], "verdict": "safe"]))
}
var applets: [String: [String: Any]] = ["app1": ["kind": "html", "title": "My notes", "html": "<p>notes</p>", "uses": ["m-local"],
                                                 "state": ["secret": "do not share"], "note": "cache bookkeeping", "message": "Quick notes"]]
registry.appletScreen = { applets[$0] }
registry.appletList = { applets.map { ["key": $0.key, "title": $0.value["title"] ?? "", "opens": 3] } }
registry.storeApplet = { title, screen, origin in applets["adopted-" + origin] = screen; return "adopted-" + origin }

func expectError(_ what: String, _ contains: String, _ f: () async throws -> Any) async {
    do { _ = try await f(); check(false, what + " (no error)") }
    catch { check(contains.isEmpty || error.localizedDescription.contains(contains), what + ": " + error.localizedDescription) }
}

Task {
    do {
        let me = AppIdentity.shared.id!
        print("app id \(me) (\(AppIdentity.short(me)))")
        check(me.count == 64 && me.allSatisfy(\.isHexDigit), "id is 64 hex")
        check(AppIdentity.shared.id == me, "id is stable (Keychain)")

        if real { try await seedReal() }
        print("— shared: sync, search")
        let st = try await registry.sync()
        check((st["count"] as? Int) == (real ? 3 : 4), "full index synced over pages: \(st["count"] ?? "?") items")
        check(events.contains { ($0["what"] as? String) == "synced" }, "synced event")
        let found = registry.list(kind: nil, q: "bytes")
        check(found.count == 1 && (found[0]["name"] as? String) == "formatBytes", "local search of the index")
        let remote = try await Services.call(Services.sharedURL, "GET", "/v1/search", query: ["q": "star"])
        check(((remote["items"] as? [[String: Any]]) ?? []).count == 1, "remote search")
        let ov = registry.overview(["bytes"])
        let ovItems = ov?["items"] as? [String] ?? []
        check(ovItems.first?.contains("formatBytes") == true && ovItems.first?.contains("[shared:") == true, "AI overview: relevant first — \(ovItems.first ?? "")")

        let byName = Dictionary(registry.list(kind: nil, q: nil).map { ($0["name"] as! String, $0["id"] as! String) }, uniquingKeysWith: { a, _ in a })

        print("— adopt")
        if !real { await expectError("sha mismatch refused", "does not match its sha256") { try await registry.prepare(byName["tampered"]!) } }
        check(reviewed.isEmpty, "a refused download never reaches the review")
        await expectError("adopt without review refused", "Review it first") { try await registry.adopt(byName["formatBytes"]!, sha: "00") }
        let prep = try await registry.prepare(byName["formatBytes"]!)
        check((prep["verified"] as? Bool) == true && reviewed.count == 1, "downloaded, sha256 verified, reviewed")
        check(((prep["review"] as? [String: Any])?["verdict"] as? String) == "safe", "review shown")
        let ad = try await registry.adopt(byName["formatBytes"]!, sha: prep["sha256"] as! String)
        let localId = (ad["ids"] as? [String])?.first ?? ""
        let mod = utilities.module(localId)
        check(mod?.origin == byName["formatBytes"] && mod?.originVersion == 1, "in the local library with origin id + version")
        check(registry.overview(["bytes"])?["items"].map { ($0 as? [String])?.contains { $0.contains("formatBytes") } } != true, "adopted item leaves the 'shared by others' overview")
        try await Task.sleep(nanoseconds: 200_000_000)
        var log: [String: Any] = real ? [:] : try await stubLog()
        let it = real ? try await Services.call(Services.sharedURL, "GET", "/v1/items/\(byName["formatBytes"]!)")
                      : (log["items"] as? [[String: Any]])?.first { ($0["name"] as? String) == "formatBytes" }
        check((it?["adoptions"] as? Int) == 1, "adoption counted (signed)")
        // A component with js + css.
        let p2 = try await registry.prepare(byName["starRating"]!)
        let a2 = try await registry.adopt(byName["starRating"]!, sha: p2["sha256"] as! String)
        check((a2["ids"] as? [String])?.count == 2, "component adopted as js + css modules")
        let p3 = try await registry.prepare(byName["pomodoro"]!)
        let a3 = try await registry.adopt(byName["pomodoro"]!, sha: p3["sha256"] as! String)
        check((applets[a3["key"] as? String ?? ""]?["html"] as? String)?.contains("Pomodoro") == true, "applet adopted as a local applet")

        print("— updates offered, not applied")
        try await bump(byName["formatBytes"]!)
        try await registry.sync()
        let ups = registry.updates()
        check(ups.count == 1 && (ups[0]["updateAvailable"] as? Bool) == true, "update to v2 offered")
        check(utilities.module(localId)?.originVersion == 1, "not auto-applied")
        let p4 = try await registry.prepare(byName["formatBytes"]!)
        _ = try await registry.adopt(byName["formatBytes"]!, sha: p4["sha256"] as! String)
        check(utilities.module(localId)?.originVersion == 2 && registry.updates().isEmpty, "update applied after review + confirmation")

        print("— share, withdraw, report")
        _ = utilities.publish(from: ["publish": [["path": ["text"], "name": "slugify", "kind": "js", "role": "util",
                                                   "description": "Turns text into a URL slug.", "usage": "lib.slugify(s)",
                                                   "code": "lib.slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');"]]])
        let mods = (registry.shareable()["modules"] as? [[String: Any]]) ?? []
        check(mods.count == 1 && (mods[0]["name"] as? String) == "slugify", "only own (not adopted) modules are shareable")
        let slug = mods[0]["id"] as! String
        let pv = try registry.preview(["module": slug])
        check((pv["json"] as? String)?.contains("lib.slugify") == true, "preview shows the exact body")
        await expectError("share with a stale digest refused", "changed since the preview") { try await registry.share(["module": slug, "digest": "x"]) }
        let shared = try await registry.share(["module": slug, "digest": pv["digest"] as! String])
        check((shared["author"] as? String) == me && (shared["version"] as? Int) == 1 && (shared["mine"] as? Bool) == true, "shared, signed by this app id")
        let shownBody = pv["body"] as? [String: Any]
        if real {
            let bytes = try await Services.raw(Services.sharedURL, "GET", "/v1/items/\(shared["id"] as! String)/payload")
            let stored = (try JSONSerialization.jsonObject(with: bytes)) as? [String: Any] ?? [:]
            check(NSDictionary(dictionary: stored).isEqual(to: shownBody?["payload"] as? [String: Any] ?? [:]) &&
                  (shared["name"] as? String) == (shownBody?["name"] as? String) && (shared["description"] as? String) == (shownBody?["description"] as? String),
                  "what the server stored is exactly what the preview showed")
        } else {
            log = try await stubLog()
            let posted = (log["log"] as? [[String: Any]])?.last { ($0["kind"] as? String) == "shared" }?["body"] as? [String: Any]
            check(posted.map { NSDictionary(dictionary: $0).isEqual(to: shownBody ?? [:]) } == true, "what was posted is exactly what the preview showed")
        }
        // Applet: state stripped, local module refs as path/name.
        let apv = try registry.preview(["applet": "app1"])
        let ajson = apv["json"] as? String ?? ""
        check(!ajson.contains("do not share") && !ajson.contains("cache bookkeeping") && ajson.contains("notes"), "applet preview: state and bookkeeping stripped")
        let again = try await registry.share(["module": slug, "digest": pv["digest"] as! String])
        // The stub makes a new version; the backend returns the same item for an identical post.
        check((again["version"] as? Int) == (real ? 1 : 2) && (again["id"] as? String) == (shared["id"] as? String), "sharing the same again: \(real ? "unchanged item" : "a new version")")
        // A css-only module: the registry requires `code`, so it carries a marker; adopting makes one css module.
        let cssIds = utilities.publish(from: ["publish": [["path": ["ui", "cards"], "name": "cardStyle", "kind": "css", "role": "component",
                                                           "description": "Card look.", "code": ".cs-card{border-radius:12px}"]]])
        let cpv = try registry.preview(["module": cssIds[0]])
        let cshared = try await registry.share(["module": cssIds[0], "digest": cpv["digest"] as! String])
        let cid = cshared["id"] as! String
        let cprep = try await registry.prepare(cid)
        let cad = try await registry.adopt(cid, sha: cprep["sha256"] as! String)
        let cids = cad["ids"] as? [String] ?? []
        check(cids.count == 1 && utilities.module(cids[0])?.kind == "css", "css-only module: shared and adopted as one css module")
        _ = try await registry.withdraw(cid)
        let sid = shared["id"] as! String
        _ = try await registry.report(byName["starRating"]!, reason: "broken in dark mode")
        if real { check(true, "report accepted (signed)") } else {
            log = try await stubLog()
            check((log["log"] as? [[String: Any]])?.contains { ($0["kind"] as? String) == "report" && ($0["by"] as? String) == me } == true, "report sent (signed)")
        }
        _ = try await registry.withdraw(sid)
        check(registry.list(kind: nil, q: "slugify").isEmpty, "withdrawn: gone locally")
        // Another user's item can't be withdrawn by this app.
        await expectError("withdrawing someone else's item refused", real ? "" : "not yours") { try await registry.withdraw(byName["starRating"]!) }
        try await registry.sync()
        check(registry.list(kind: nil, q: "slugify").isEmpty, "withdrawn: listed in `removed` on the next sync")

        print("— people")
        let other = try await otherAction("noop", me)
        await expectError("invalid handle refused locally", "handle") { try await people.saveProfile(["name": "Me", "handle": "No Caps!"]) }
        let ps = try await people.saveProfile(["name": "Taras Test", "handle": "taras_t", "about": "testing", "findable": true])
        check(((ps["profile"] as? [String: Any])?["handle"] as? String) == "taras_t", "profile saved (signed PUT)")
        let f = try await people.find("olga")
        let fp = (f["profiles"] as? [[String: Any]]) ?? []
        check(fp.count == 1 && (fp[0]["id"] as? String) == other, "find by handle")
        let hidden = try await people.find("hans")
        check(((hidden["profiles"] as? [[String: Any]]) ?? []).isEmpty, "not findable stays hidden")
        let byId = try await people.find(hiddenId)
        check(((byId["profiles"] as? [[String: Any]]) ?? []).isEmpty && byId["id"] != nil, "exact id of a hidden profile: 404, offered to add by id")
        await expectError("own id refused", "own id") { try await people.add(me, note: nil) }
        await expectError("malformed id refused", "64 hexadecimal") { try await people.add("abc", note: nil) }
        // Someone adds me → incoming; I add back → mutual (the router tells both).
        _ = try await otherAction("add", me)
        events.removeAll()
        let inbox = try await people.poll()
        check(events.contains { ($0["what"] as? String) == "incoming" && ($0["id"] as? String) == other && ($0["note"] as? String) == "hi from Olga" }, "inbox: incoming event, notified")
        check(((inbox["contacts"] as? [[String: Any]]) ?? []).contains { ($0["id"] as? String) == other && ($0["state"] as? String) == "incoming" }, "contacts: incoming")
        // Pasted with spaces and a prefix.
        let pasted = "aiui: " + other.prefix(32) + " " + other.dropFirst(32)
        let added = try await people.add(String(pasted), note: nil)
        let c = ((added["contacts"] as? [[String: Any]]) ?? []).first { ($0["id"] as? String) == other }
        check((c?["state"] as? String) == "mutual" && (c?["verified"] as? Bool) == true, "added back by pasted id → mutual, id verified")
        events.removeAll()
        _ = try await people.poll()
        check(events.contains { ($0["what"] as? String) == "mutual" && ($0["id"] as? String) == other }, "inbox: mutual event, notified")
        // Pending: I add a hidden user.
        let pend = try await people.add(hiddenId, note: "hello")
        check(((pend["contacts"] as? [[String: Any]]) ?? []).contains { ($0["state"] as? String) == "pending" }, "add a hidden user by id → pending")
        _ = try await otherAction("remove", me)
        events.removeAll()
        _ = try await people.poll()
        check(events.contains { ($0["what"] as? String) == "removed" }, "inbox: removed event")
        let rm = try await people.remove(hiddenId)
        check(!((rm["contacts"] as? [[String: Any]]) ?? []).contains { ($0["id"] as? String) == hiddenId }, "contact removed")
        if !real {
            let rp = try await test("/test/other", ["action": "replay", "id": me])
            check((rp["status"] as? [Int]) == [200, 409], "stub refuses a replayed signed request (409)")
        }
        let del = try await people.deleteProfile()
        check(del["profile"] is NSNull, "profile removed")

        if real { throw CancellationError() }
        log = try await stubLog()
        let bad = (log["log"] as? [[String: Any]])?.filter { ($0["kind"] as? String) == "badSignature" } ?? []
        let ok = (log["log"] as? [[String: Any]])?.filter { ($0["kind"] as? String) == "verified" && ($0["id"] as? String) == me } ?? []
        check(bad.isEmpty, "no request failed signature verification")
        print("  \(ok.count) signed requests from this app verified by node:crypto")
    } catch is CancellationError {
    } catch {
        check(false, "unexpected error: \(error.localizedDescription)")
    }
    // Clean up the test identity.
    SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                   kSecAttrService as String: ProcessInfo.processInfo.environment["AIUI_IDENTITY_SERVICE"]!,
                   kSecAttrAccount as String: "app-id-seed"] as CFDictionary)
    try? FileManager.default.removeItem(at: tmp)
    print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
    exit(failures == 0 ? 0 : 1)
}
dispatchMain()
