import Cocoa

/// Native endpoints behind the page's fetch("/api/<name>").
final class API: NSObject, AIUIHost {
    let cache: Cache
    let claude: Claude
    /// Stateless pager: fetches more circles for the current screen in the background.
    let pager: Claude
    /// Actions answered from the cache since the AI last heard from us.
    private var replayed: [[String: Any]] = []

    init(support: URL) {
        let mb = Int(ProcessInfo.processInfo.environment["AIUI_CACHE_MB"] ?? "") ?? 64
        cache = Cache(dir: support.appendingPathComponent("cache", isDirectory: true), limitMB: mb)
        let memory = Prompts.memory(index: cache.indexText.path)
        claude = Claude(persistent: true, systemPrompt: Prompts.system + memory, schema: Prompts.screenSchema)
        pager = Claude(persistent: false, systemPrompt: Prompts.system + memory + Prompts.pager, schema: Prompts.pageSchema)
        super.init()
    }

    func resetSession() { pager.cancel(); claude.reset() }
    func shutdown() { pager.cancel(); claude.cancel() }

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
                  "session": claude.sessionID, "engine": "CEF/Blink",
                  "macos": ProcessInfo.processInfo.operatingSystemVersionString])

        case "ai":
            pager.cancel()
            let action = Cache.action(from: input)
            let key = Cache.key(for: action)
            if (input["fresh"] as? Bool) != true, let screen = cache.lookup(key) {
                replayed.append(action)
                if replayed.count > 20 { replayed.removeFirst(replayed.count - 20) }
                send(["screen": screen, "cached": true])
                return
            }
            var event = input
            if !replayed.isEmpty { event["replayed"] = replayed }
            let prompt = Self.prompt(for: event)
            claude.next(prompt: prompt, progress: { line in
                Self.emit(["type": "progress", "text": line])
            }, done: { [weak self] result in
                switch result {
                case .success(let screen):
                    guard let self else { return }
                    self.replayed.removeAll()
                    self.cache.store(key: key, action: action, outcome: screen)
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
            if (input["pager"] as? Bool) == true { pager.cancel() } else { claude.cancel() }
            send(["ok": true])

        case "reset":
            claude.reset()
            send(["ok": true, "session": claude.sessionID])

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
