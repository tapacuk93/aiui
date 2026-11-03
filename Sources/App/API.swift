import Foundation

/// Native endpoints behind the page's /api/<name> calls (Mac: aiui:// scheme in CEF; iOS: the
/// WebKit message bridge). Platform pieces live in Sources/Mac and Sources/iOS.
final class API: NSObject {
    /// HTTP-like reply: status, MIME type, body.
    typealias Reply = (Int, String, Data) -> Void
    /// Runs JavaScript in the page; set by the host (CEF on the Mac, WKWebView on iOS).
    static var evalJS: (String) -> Void = { _ in }
    /// Puts the app window in or out of full screen (Mac); nil where the app is always full screen.
    static var setFullScreen: ((Bool) -> Void)?
    let cache: Cache
    let utilities: Utilities
    let profile: Profile
    /// The AI behind screens (persistent session) and the stateless background pager.
    /// nil until a CLI is detected or an API key is given.
    private(set) var claude: AIEngine?
    private(set) var pager: AIEngine?
    /// Live suggestions while the user types (stateless, separate so it never cancels paging).
    private(set) var suggester: AIEngine?
    /// Prefetches the screen the cursor is heading for; refines live circles; translates UI text.
    private(set) var scout: AIEngine?
    private(set) var refiner: AIEngine?
    private(set) var translator: AIEngine?
    private(set) var profiler: AIEngine?
    private(set) var librarian: AIEngine?
    /// Fast interim screens when the full answer takes long.
    private(set) var quick: AIEngine?
    private var reviewing = false
    /// The user's system language (BCP 47), sent with every event.
    let language = Locale.preferredLanguages.first ?? "en"
    private(set) var engineID: String?   // cli id, or "key"
    private let systemPrompt: String
    private let pagerPrompt: String
    private let suggestPrompt: String
    /// Actions answered from the cache since the AI last heard from us.
    private var replayed: [[String: Any]] = []
    /// The user's current flow: earlier actions along the path to the current screen.
    private var flow: [(depth: Int, line: String)] = []

    /// Updates the flow for a new action and returns the steps that led to it. An action taken
    /// on a screen at depth d (path length) follows the earlier steps at depths < d.
    private func advanceFlow(_ action: [String: Any]) -> [String] {
        let depth = (action["path"] as? [Any])?.count ?? 0
        let before = flow.filter { $0.depth < depth }
        flow = before + [(depth, Cache.line(action: action))]
        return before.suffix(10).map(\.line)
    }

    init(support: URL) {
        let mb = Int(ProcessInfo.processInfo.environment["AIUI_CACHE_MB"] ?? "") ?? 64
        cache = Cache(dir: support.appendingPathComponent("cache", isDirectory: true), limitMB: mb)
        utilities = Utilities(dir: support.appendingPathComponent("utilities", isDirectory: true))
        profile = Profile(dir: support.appendingPathComponent("profile", isDirectory: true))
        let memory = Prompts.memory(index: cache.indexText.path)
        systemPrompt = Prompts.system + memory
        pagerPrompt = Prompts.system + memory + Prompts.pager
        suggestPrompt = Prompts.system + memory + Prompts.suggest
        super.init()
        // Saved choice, else the first agent CLI found, else a saved API key.
        let saved = UserDefaults.standard.string(forKey: "engine")
        let env = ProcessInfo.processInfo.environment["AIUI_ENGINE"]
        let clis = Provider.detectedCLIs()
        if let want = env ?? saved, use(want) { return }
        if let first = clis.first { _ = use(first) } else if !use("key") { _ = use("aicoin") }
    }

    /// Switches the AI to a detected CLI ("claude", "codex", "gemini") or the saved API key ("key").
    @discardableResult
    func use(_ id: String) -> Bool {
        let make: (Bool, String, String) -> AIEngine
        switch id {
        #if os(macOS)
        case "claude":
            guard Shell.which("claude") != nil else { return false }
            make = { Claude(persistent: $0, systemPrompt: $1, schema: $2) }
        case "codex", "gemini":
            guard Shell.which(id) != nil else { return false }
            let name = Provider.clis.first { $0.id == id }?.name ?? id
            make = { AgentCLI(id: id, label: name, persistent: $0, systemPrompt: $1, schema: $2) }
        #endif
        case "aicoin":
            guard let key = AICoin.shared.key() else { return false }
            make = { APIEngine(key: key, persistent: $0, systemPrompt: $1, schema: $2) }
        case "key":
            guard let key = Provider.loadKey() else { return false }
            make = { APIEngine(key: key, persistent: $0, systemPrompt: $1, schema: $2) }
        default:
            return false
        }
        claude?.cancel(); pager?.cancel(); suggester?.cancel(); scout?.cancel(); refiner?.cancel()
        claude = make(true, systemPrompt, Prompts.screenSchema)
        pager = make(false, pagerPrompt, Prompts.pageSchema)
        suggester = make(false, suggestPrompt, Prompts.suggestSchema)
        scout = make(false, systemPrompt + Prompts.scout, Prompts.screenSchema)
        refiner = make(false, systemPrompt + Prompts.refine, Prompts.patchSchema)
        translator = make(false, Prompts.translate, Prompts.translateSchema)
        profiler = make(false, systemPrompt + Prompts.profiler, Prompts.profileSchema)
        librarian = make(false, systemPrompt + Prompts.librarian, Prompts.librarySchema)
        let q = make(false, systemPrompt + Prompts.quick, Prompts.screenSchema)
        #if os(macOS)
        if let c = q as? Claude { c.model = "haiku" }      // the fast model for interim screens
        #endif
        if let a = q as? APIEngine { a.effort = "low" }
        quick = q
        engineID = id
        UserDefaults.standard.set(id, forKey: "engine")
        return true
    }

    func engineStatus() -> [String: Any] {
        var options: [[String: Any]] = Provider.detectedCLIs().map { id in
            ["id": id, "label": Provider.clis.first { $0.id == id }?.name ?? id, "kind": "cli"]
        }
        if AICoin.available {
            var o: [String: Any] = ["id": "aicoin", "label": "AICoin", "kind": "aicoin"]
            if let b = AICoin.shared.lastBalance { o["balance"] = b }
            options.append(o)
        }
        if let k = Provider.loadKey() { options.append(["id": "key", "label": "\(k.name) · \(k.model)", "kind": "key"]) }
        var out: [String: Any] = ["options": options]
        if let claude, let engineID { out["active"] = ["id": engineID, "label": claude.label] }
        return out
    }

    /// The librarian reviews the utility library after several publishes, or daily.
    func reviewLibraryIfDue(force: Bool = false) {
        guard let librarian, !reviewing, force || utilities.needsReview else { return }
        reviewing = true
        let data = (try? JSONSerialization.data(withJSONObject: ["modules": utilities.reviewInput(),
                                                                   "categories": utilities.categories],
                                                options: [.prettyPrinted, .sortedKeys])) ?? Data()
        librarian.next(prompt: "Review the utility library:\n```json\n\(String(decoding: data, as: UTF8.self))\n```",
                       progress: { _ in }, done: { [weak self] r in
            guard let self else { return }
            self.reviewing = false
            if case .success(let result) = r { self.utilities.applyReview(result) }
        })
    }

    /// Pulls in what other devices wrote (called when the app becomes active, and every minute).
    func syncNow() {
        cache.reload(); utilities.reload(); profile.reload()
        AICoin.shared.refreshBalance()
    }

    func resetSession() { pager?.cancel(); suggester?.cancel(); scout?.cancel(); refiner?.cancel(); claude?.reset() }
    func shutdown() {
        for e in [pager, suggester, scout, refiner, translator, profiler, librarian, quick, claude] { e?.cancel() }
    }

    /// Runs a stateless side engine on `input` (plus flow index context) and replies with its JSON.
    private func side(_ engine: AIEngine?, _ intro: String, _ input: [String: Any],
                      send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        guard let engine else { return fail("no-ai") }
        var input = input
        input["language"] = language
        var words = (input["path"] as? [String]) ?? []
        if let t = (input["target"] as? [String: Any])?["label"] as? String { words.append(t) }
        if let t = (input["screen"] as? [String: Any])?["title"] as? String { words.append(t) }
        let related = cache.related(words)
        if !related.isEmpty { input["memory"] = related }
        let flows = cache.overview(limit: 10)
        if !flows.isEmpty { input["flows"] = flows }
        let data = (try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        engine.next(prompt: intro + "\n```json\n" + String(decoding: data, as: UTF8.self) + "\n```", progress: { _ in }, done: { r in
            switch r {
            case .success(let obj): send(obj)
            case .failure(let e): fail(e.localizedDescription)
            }
        })
    }

    /// Screens shown from a prefetch since the main AI last heard from us.
    private var prefetched: [[String: Any]] = []

    func handleAPI(_ path: String, body: Data, reply: @escaping Reply) {
        let input = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let send: ([String: Any]) -> Void = { obj in
            let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
            reply(200, "application/json", data)
        }
        let fail: (String) -> Void = { msg in
            let data = (try? JSONSerialization.data(withJSONObject: ["error": msg])) ?? Data()
            reply(500, "application/json", data)
        }

        switch path {
        case "info":
            send(["home": NSHomeDirectory(), "user": NSFullUserName(), "language": language,
                  "ai": claude?.label ?? "none", "engine": "CEF/Blink",
                  "macos": ProcessInfo.processInfo.operatingSystemVersionString])

        case "engine":
            switch input["op"] as? String ?? "status" {
            case "use":
                if !use(input["id"] as? String ?? "") { return fail("That AI is not available.") }
            case "key":
                guard let key = Provider.parse(input["text"] as? String ?? "") else {
                    return fail("Unrecognised key. Paste a key from Anthropic, OpenAI, Google, OpenRouter, Groq or xAI, or: <base-url> <key> [model]")
                }
                guard Provider.saveKey(key) else { return fail("Could not save the key to the Keychain.") }
                use("key")
            case "aicoin":
                // Set up the AICoin wallet (create, claim free coins, token) and switch to it.
                AICoin.shared.prepare { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .success: self.use("aicoin"); send(self.engineStatus())
                    case .failure(let e): fail(e.localizedDescription)
                    }
                }
                return
            case "forget":
                Provider.deleteKey()
                if engineID == "key" { claude = nil; pager = nil; engineID = nil; UserDefaults.standard.removeObject(forKey: "engine") }
            default: break
            }
            send(engineStatus())

        case "suggest":
            guard let suggester else { return fail("no-ai") }
            var input = input
            input["language"] = language
            var words = (input["path"] as? [String]) ?? []
            if let q = input["input"] as? String { words.append(q) }
            let related = cache.related(words)
            if !related.isEmpty { input["memory"] = related }
            let flows = cache.overview(limit: 10)
            if !flows.isEmpty { input["flows"] = flows }
            let data = (try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            let prompt = "The user is typing on this screen. Suggest circles for their input:\n```json\n\(String(decoding: data, as: UTF8.self))\n```"
            suggester.next(prompt: prompt, progress: { _ in }, done: { result in
                switch result {
                case .success(let r): send(r)
                case .failure(let e): fail(e.localizedDescription)
                }
            })

        case "quick":
            side(quick, "The full answer to this event is taking long. Give a quick interim screen now:", input, send: send, fail: fail)

        case "prefetch":
            side(scout, "The cursor is heading for this circle. Prepare the screen opening it would show:", input, send: send, fail: fail)

        case "refine":
            side(refiner, "Refine the circles of this screen with real data:", input, send: send, fail: fail)

        case "translate":
            guard let translator else { return fail("no-ai") }
            let data = (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])) ?? Data()
            translator.next(prompt: String(decoding: data, as: UTF8.self), progress: { _ in }, done: { r in
                switch r {
                case .success(let obj): send(obj)
                case .failure(let e): fail(e.localizedDescription)
                }
            })

        case "adopt":
            // A prefetched screen was opened: record it like a normal turn and tell the AI next time.
            var input = input
            input["language"] = language
            let action = Cache.action(from: input)
            let key = Cache.key(for: action)
            let steps = advanceFlow(action)
            if let screen = input["outcome"] as? [String: Any] {
                cache.store(key: key, action: action, flow: steps, outcome: screen)
                var note = action
                note["shown"] = screen["note"] ?? screen["title"] ?? ""
                prefetched.append(note)
                if prefetched.count > 10 { prefetched.removeFirst(prefetched.count - 10) }
            }
            send(["ok": true])

        case "ai":
            var input = input
            input["language"] = language
            guard let claude, let pager else { return fail("no-ai") }
            pager.cancel()
            suggester?.cancel()
            scout?.cancel()
            refiner?.cancel()
            let action = Cache.action(from: input)
            let key = Cache.key(for: action)
            let steps = advanceFlow(action)
            if (input["fresh"] as? Bool) != true, let screen = cache.lookup(key) {
                replayed.append(action)
                if replayed.count > 20 { replayed.removeFirst(replayed.count - 20) }
                send(["screen": screen, "cached": true])
                return
            }
            var event = input
            event["language"] = language
            if !replayed.isEmpty { event["replayed"] = replayed }
            if !prefetched.isEmpty { event["prefetched"] = prefetched }
            if !steps.isEmpty { event["flow"] = steps }
            // Related past flows and outcomes; the AI may reuse any by key.
            var words = (input["path"] as? [String]) ?? []
            if let t = (input["target"] as? [String: Any])?["label"] as? String { words.append(t) }
            if let t = input["text"] as? String { words.append(t) }
            let memory = cache.related(words)
            if !memory.isEmpty { event["memory"] = memory }
            let flows = cache.overview()
            if !flows.isEmpty { event["flows"] = flows }
            let lib = utilities.overview(words)
            if !lib.isEmpty {
                event["library"] = lib
                event["libraryCategories"] = utilities.categories
            }
            // Who the user is (unless a guest is using the app) and the page's behavioral check.
            var user: [String: Any] = [:]
            let guest = (input["guest"] as? Bool) == true
            if guest { user["guest"] = true } else {
                let traits = profile.overview()
                if !traits.isEmpty { user["profile"] = traits }
            }
            if let check = input["userCheck"] as? [String: Any] { user["check"] = check }
            event["guest"] = nil
            event["userCheck"] = nil
            if !user.isEmpty { event["user"] = user }
            let prompt = Self.prompt(for: event)
            claude.next(prompt: prompt, progress: { line in
                Self.emit(["type": "progress", "text": line])
            }, done: { [weak self] result in
                switch result {
                case .success(let screen):
                    guard let self else { return }
                    self.replayed.removeAll()
                    self.prefetched.removeAll()
                    var screen = screen
                    // `reuse`: the AI picked a stored outcome instead of rebuilding it.
                    if let rk = screen.removeValue(forKey: "reuse") as? String, !rk.isEmpty,
                       var stored = self.cache.outcome(rk) {
                        for k in ["title", "message", "go", "more", "back", "note", "cacheable"] {
                            if let v = screen[k] { stored[k] = v }
                        }
                        screen = stored
                    }
                    var stored = screen
                    if let pub = stored.removeValue(forKey: "publish") as? [[String: Any]], !pub.isEmpty {
                        let ids = pub.compactMap { m -> String? in
                            guard let n = m["name"] as? String else { return nil }
                            return Utilities.id(path: (m["path"] as? [String] ?? []).filter { !$0.isEmpty }.prefix(3).map { $0 }, name: n)
                        }
                        stored["uses"] = Array(Set(((stored["uses"] as? [String]) ?? []) + ids))
                    }
                    self.cache.store(key: key, action: action, flow: steps, outcome: stored)
                    var clean = screen
                    clean["note"] = nil
                    clean["cacheable"] = nil
                    var reply: [String: Any] = [:]
                    // Modules the screen published join the shared library (the cached screen
                    // keeps only `uses`, so replays resolve the current versions).
                    let published = self.utilities.publish(from: screen)
                    if !published.isEmpty { reply["published"] = published.count }
                    clean["publish"] = nil
                    if !published.isEmpty {
                        clean["uses"] = Array(Set(((clean["uses"] as? [String]) ?? []) + published))
                    }
                    reply["screen"] = clean
                    send(reply)
                    self.reviewLibraryIfDue()
                case .failure(let e): fail(e.localizedDescription)
                }
            })

        case "profile":
            switch input["op"] as? String ?? "get" {
            case "baseline":
                if let b = input["baseline"] as? [String: Any] {
                    profile.baseline = Profile.mergeBaseline(b, profile.baseline.mapValues(\.value)).mapValues(AnyCodable.init)
                    profile.persist()
                }
                send(["ok": true])
            case "learn":
                // Background: the profiler revises the characteristic tree from recent flows.
                guard let profiler else { return fail("no-ai") }
                let evidence: [String: Any] = [
                    "tree": profile.overview(limit: 80),
                    "flows": cache.overview(limit: 40),
                    "utilities": utilities.overview([], limit: 20),
                    "language": language,
                    "behavior": input["behavior"] ?? [:],
                ]
                let data = (try? JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])) ?? Data()
                profiler.next(prompt: "Update the user's characteristic tree from this evidence:\n```json\n\(String(decoding: data, as: UTF8.self))\n```",
                              progress: { _ in }, done: { [weak self] r in
                    guard let self else { return }
                    switch r {
                    case .success(let result): self.profile.merge(result); send(["traits": self.profile.overview()])
                    case .failure(let e): fail(e.localizedDescription)
                    }
                })
            case "tree":
                send(profile.tree(at: input["path"] as? [String] ?? []))
            case "remove":
                profile.remove(input["path"] as? [String] ?? [])
                send(profile.tree(at: Array((input["path"] as? [String] ?? []).dropLast())))
            default:
                send(["traits": profile.overview(), "baseline": profile.baseline.mapValues(\.value)])
            }

        case "window":
            DispatchQueue.main.async { Self.setFullScreen?((input["on"] as? Bool) ?? true) }
            send(["ok": true])

        case "utilities":
            switch input["op"] as? String ?? "tree" {
            case "bundle":
                send(utilities.bundle(input["ids"] as? [String] ?? []))
            case "review":
                reviewLibraryIfDue(force: true)
                send(["ok": true])
            case "delete":
                utilities.delete(input["id"] as? String ?? "")
                send(utilities.tree(at: input["path"] as? [String] ?? []))
            default:
                send(utilities.tree(at: input["path"] as? [String] ?? []))
            }

        case "cache":
            switch input["op"] as? String ?? "stats" {
            case "search": send(["results": cache.search(input["q"] as? String ?? "")])
            case "likely": send(["label": cache.likely(path: input["path"] as? [String] ?? []) ?? NSNull()])
            case "clear": cache.clear(); send(cache.stats())
            default: send(cache.stats())
            }

        case "more":
            guard let pager else { return fail("no-ai") }
            var input = input
            input["language"] = language
            var words = (input["path"] as? [String]) ?? []
            if let t = (input["screen"] as? [String: Any])?["title"] as? String { words.append(t) }
            let related = cache.related(words)
            if !related.isEmpty { input["memory"] = related }
            let flows = cache.overview()
            if !flows.isEmpty { input["flows"] = flows }
            let data = (try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            let prompt = """
            The user scrolled past the end of this screen. Continue its circles:
            ```json
            \(String(decoding: data, as: UTF8.self))
            ```
            """
            pager.next(prompt: prompt, progress: { _ in }, done: { result in
                switch result {
                case .success(let page): send(page)
                case .failure(let e): fail(e.localizedDescription)
                }
            })

        case "cancel":
            if (input["pager"] as? Bool) == true { pager?.cancel() }
            else if (input["suggest"] as? Bool) == true { suggester?.cancel() }
            else if (input["scout"] as? Bool) == true { scout?.cancel() }
            else if (input["refine"] as? Bool) == true { refiner?.cancel() }
            else if (input["quick"] as? Bool) == true { quick?.cancel() }
            else { claude?.cancel() }
            send(["ok": true])

        case "reset":
            resetSession()
            send(["ok": true])

        case "sys":
            Self.sys(input, send: send, fail: fail)

        default:
            reply(404, "application/json", Data(#"{"error":"unknown endpoint"}"#.utf8))
        }
    }

    /// Pushes an event into the page (window.aiui._event).
    static func emit(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        let js = "window.aiui && aiui._event(\(String(decoding: data, as: UTF8.self)))"
        DispatchQueue.main.async { evalJS(js) }
    }

    static func prompt(for input: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        return """
        UI event from aiui:
        ```json
        \(String(decoding: data, as: UTF8.self))
        ```
        Do what it needs, then return the next screen.
        """
    }

}
