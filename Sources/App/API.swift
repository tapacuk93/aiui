import Cocoa

/// Native endpoints behind the page's fetch("/api/<name>").
final class API: NSObject, AIUIHost {
    let cache: Cache
    /// The AI behind screens (persistent session) and the stateless background pager.
    /// nil until a CLI is detected or an API key is given.
    private(set) var claude: AIEngine?
    private(set) var pager: AIEngine?
    private(set) var engineID: String?   // cli id, or "key"
    private let systemPrompt: String
    private let pagerPrompt: String
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
        let memory = Prompts.memory(index: cache.indexText.path)
        systemPrompt = Prompts.system + memory
        pagerPrompt = Prompts.system + memory + Prompts.pager
        super.init()
        // Saved choice, else the first agent CLI found, else a saved API key.
        let saved = UserDefaults.standard.string(forKey: "engine")
        let env = ProcessInfo.processInfo.environment["AIUI_ENGINE"]
        let clis = Provider.detectedCLIs()
        if let want = env ?? saved, use(want) { return }
        if let first = clis.first { _ = use(first) } else { _ = use("key") }
    }

    /// Switches the AI to a detected CLI ("claude", "codex", "gemini") or the saved API key ("key").
    @discardableResult
    func use(_ id: String) -> Bool {
        let main: AIEngine, page: AIEngine
        switch id {
        case "claude":
            guard Shell.which("claude") != nil else { return false }
            main = Claude(persistent: true, systemPrompt: systemPrompt, schema: Prompts.screenSchema)
            page = Claude(persistent: false, systemPrompt: pagerPrompt, schema: Prompts.pageSchema)
        case "codex", "gemini":
            guard Shell.which(id) != nil else { return false }
            let name = Provider.clis.first { $0.id == id }?.name ?? id
            main = AgentCLI(id: id, label: name, persistent: true, systemPrompt: systemPrompt, schema: Prompts.screenSchema)
            page = AgentCLI(id: id, label: name, persistent: false, systemPrompt: pagerPrompt, schema: Prompts.pageSchema)
        case "key":
            guard let key = Provider.loadKey() else { return false }
            main = APIEngine(key: key, persistent: true, systemPrompt: systemPrompt, schema: Prompts.screenSchema)
            page = APIEngine(key: key, persistent: false, systemPrompt: pagerPrompt, schema: Prompts.pageSchema)
        default:
            return false
        }
        claude?.cancel(); pager?.cancel()
        claude = main; pager = page; engineID = id
        UserDefaults.standard.set(id, forKey: "engine")
        return true
    }

    func engineStatus() -> [String: Any] {
        var options: [[String: Any]] = Provider.clis.filter { Shell.which($0.id) != nil }.map {
            ["id": $0.id, "label": $0.name, "kind": "cli"]
        }
        if let k = Provider.loadKey() { options.append(["id": "key", "label": "\(k.name) · \(k.model)", "kind": "key"]) }
        var out: [String: Any] = ["options": options]
        if let claude, let engineID { out["active"] = ["id": engineID, "label": claude.label] }
        return out
    }

    func resetSession() { pager?.cancel(); claude?.reset() }
    func shutdown() { pager?.cancel(); claude?.cancel() }

    func handleAPI(_ path: String, body: Data, reply: @escaping AIUIReply) {
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
            send(["home": NSHomeDirectory(), "user": NSFullUserName(),
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
            case "forget":
                Provider.deleteKey()
                if engineID == "key" { claude = nil; pager = nil; engineID = nil; UserDefaults.standard.removeObject(forKey: "engine") }
            default: break
            }
            send(engineStatus())

        case "ai":
            guard let claude, let pager else { return fail("no-ai") }
            pager.cancel()
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
            if !replayed.isEmpty { event["replayed"] = replayed }
            if !steps.isEmpty { event["flow"] = steps }
            // Related past flows and outcomes; the AI may reuse any by key.
            var words = (input["path"] as? [String]) ?? []
            if let t = (input["target"] as? [String: Any])?["label"] as? String { words.append(t) }
            if let t = input["text"] as? String { words.append(t) }
            let memory = cache.related(words)
            if !memory.isEmpty { event["memory"] = memory }
            let flows = cache.overview()
            if !flows.isEmpty { event["flows"] = flows }
            let prompt = Self.prompt(for: event)
            claude.next(prompt: prompt, progress: { line in
                Self.emit(["type": "progress", "text": line])
            }, done: { [weak self] result in
                switch result {
                case .success(let screen):
                    guard let self else { return }
                    self.replayed.removeAll()
                    var screen = screen
                    // `reuse`: the AI picked a stored outcome instead of rebuilding it.
                    if let rk = screen.removeValue(forKey: "reuse") as? String, !rk.isEmpty,
                       var stored = self.cache.outcome(rk) {
                        for k in ["title", "message", "go", "more", "back", "note", "cacheable"] {
                            if let v = screen[k] { stored[k] = v }
                        }
                        screen = stored
                    }
                    self.cache.store(key: key, action: action, flow: steps, outcome: screen)
                    var clean = screen
                    clean["note"] = nil
                    clean["cacheable"] = nil
                    send(["screen": clean])
                case .failure(let e): fail(e.localizedDescription)
                }
            })

        case "cache":
            switch input["op"] as? String ?? "stats" {
            case "search": send(["results": cache.search(input["q"] as? String ?? "")])
            case "clear": cache.clear(); send(cache.stats())
            default: send(cache.stats())
            }

        case "more":
            guard let pager else { return fail("no-ai") }
            var input = input
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
            if (input["pager"] as? Bool) == true { pager?.cancel() } else { claude?.cancel() }
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
        AIUICef.evalJS("window.aiui && aiui._event(\(String(decoding: data, as: UTF8.self)))")
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

    // MARK: - System access for the page and AI-generated views

    static func sys(_ input: [String: Any], send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        let op = input["op"] as? String ?? ""
        let shellResult: (Shell.Result) -> Void = { r in
            send(["code": Int(r.code), "stdout": r.stdout, "stderr": r.stderr])
        }
        switch op {
        case "shell":
            guard let cmd = input["cmd"] as? String else { return fail("cmd required") }
            Shell.run("/bin/zsh", ["-lc", cmd], completion: shellResult)
        case "jxa":
            guard let script = input["script"] as? String else { return fail("script required") }
            Shell.run("/usr/bin/osascript", ["-l", "JavaScript", "-"], stdin: script, completion: shellResult)
        case "applescript":
            guard let script = input["script"] as? String else { return fail("script required") }
            Shell.run("/usr/bin/osascript", ["-"], stdin: script, completion: shellResult)
        case "open":
            guard let target = input["target"] as? String else { return fail("target required") }
            if let url = URL(string: target), url.scheme != nil, !target.hasPrefix("/") {
                NSWorkspace.shared.open(url)
            } else if FileManager.default.fileExists(atPath: (target as NSString).expandingTildeInPath) {
                NSWorkspace.shared.open(URL(fileURLWithPath: (target as NSString).expandingTildeInPath))
            } else {
                Shell.run("/usr/bin/open", ["-a", target]) { r in
                    if r.code != 0 { fail(r.stderr) } else { send(["ok": true]) }
                }
                return
            }
            send(["ok": true])
        case "read":
            guard let path = input["path"] as? String else { return fail("path required") }
            let full = (path as NSString).expandingTildeInPath
            guard let text = try? String(contentsOfFile: full, encoding: .utf8) else { return fail("cannot read \(path)") }
            send(["text": text])
        case "write":
            guard let path = input["path"] as? String, let text = input["text"] as? String else {
                return fail("path and text required")
            }
            do {
                try text.write(toFile: (path as NSString).expandingTildeInPath, atomically: true, encoding: .utf8)
                send(["ok": true])
            } catch { fail(error.localizedDescription) }
        case "clipboard":
            let pb = NSPasteboard.general
            if let text = input["text"] as? String {
                pb.clearContents()
                pb.setString(text, forType: .string)
                send(["ok": true])
            } else {
                send(["text": pb.string(forType: .string) ?? ""])
            }
        case "notify":
            let title = input["title"] as? String ?? "aiui"
            let text = input["text"] as? String ?? ""
            let script = "display notification \(appleQuote(text)) with title \(appleQuote(title))"
            Shell.run("/usr/bin/osascript", ["-e", script]) { _ in send(["ok": true]) }
        default:
            fail("unknown op \(op)")
        }
    }

    private static func appleQuote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
