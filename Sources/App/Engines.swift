import Foundation
import Security

/// Something that turns a UI event into the next screen.
protocol AIEngine: AnyObject {
    var label: String { get }
    func next(prompt: String, progress: @escaping (String) -> Void,
              done: @escaping (Swift.Result<[String: Any], Error>) -> Void)
    func cancel()
    func reset()
}

extension Claude: AIEngine {
    var label: String { "Claude Code" }
}

func aiError(_ s: String) -> NSError { NSError(domain: "aiui", code: 1, userInfo: [NSLocalizedDescriptionKey: s]) }

// MARK: - Provider choice

/// Which AI backs the app: a detected agent CLI, or an API key for a provider (Keychain).
enum Provider {
    /// Agent CLIs we know how to drive, in order of preference.
    static let clis: [(id: String, name: String)] = [
        ("claude", "Claude Code"), ("codex", "Codex CLI"), ("gemini", "Gemini CLI"),
    ]

    static func detectedCLIs() -> [String] { clis.map(\.id).filter { Shell.which($0) != nil } }

    struct Key: Codable {
        var provider: String   // anthropic | openai-compatible
        var name: String       // display name
        var key: String
        var base: String
        var model: String
    }

    /// Recognises the provider from the key itself; "<base-url> <key> [model]" for anything else.
    static func parse(_ text: String) -> Key? {
        let parts = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).map(String.init)
        guard let first = parts.first else { return nil }
        if first.hasPrefix("http"), parts.count >= 2 {
            return Key(provider: "openai-compatible", name: URL(string: first)?.host ?? "Custom", key: parts[1],
                       base: first.hasSuffix("/") ? String(first.dropLast()) : first, model: parts.count > 2 ? parts[2] : "")
        }
        let k = first, model = parts.count > 1 ? parts[1] : ""
        func oa(_ name: String, _ base: String, _ m: String) -> Key {
            Key(provider: "openai-compatible", name: name, key: k, base: base, model: model.isEmpty ? m : model)
        }
        if k.hasPrefix("sk-ant-") {
            return Key(provider: "anthropic", name: "Anthropic", key: k, base: "https://api.anthropic.com",
                       model: model.isEmpty ? "claude-opus-5-5" : model)
        }
        if k.hasPrefix("sk-or-") { return oa("OpenRouter", "https://openrouter.ai/api/v1", "openrouter/auto") }
        if k.hasPrefix("AIza") { return oa("Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-pro") }
        if k.hasPrefix("gsk_") { return oa("Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile") }
        if k.hasPrefix("xai-") { return oa("xAI", "https://api.x.ai/v1", "grok-4") }
        if k.hasPrefix("sk-") { return oa("OpenAI", "https://api.openai.com/v1", "gpt-5") }
        return nil
    }

    // Keychain (generic password).
    private static let service = "dev.aiui.app.provider"

    static func loadKey() -> Key? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Key.self, from: data)
    }

    static func saveKey(_ key: Key) -> Bool {
        deleteKey()
        guard let data = try? JSONEncoder().encode(key) else { return false }
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key.name, kSecValueData as String: data]
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func deleteKey() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }
}

// MARK: - Other agent CLIs (Codex, Gemini)

/// Drives a non-Claude agent CLI in full-auto mode. These CLIs have no schema flag here, so the
/// prompt carries the schema and the reply's last JSON object is the screen. Context between calls
/// is a short transcript the engine keeps itself.
final class AgentCLI: AIEngine {
    let id: String, label: String
    let persistent: Bool, systemPrompt: String, schema: String
    private var process: Process?
    private var generation = 0
    private var pendingDone: ((Swift.Result<[String: Any], Error>) -> Void)?
    private var transcript: [String] = []

    init(id: String, label: String, persistent: Bool, systemPrompt: String, schema: String) {
        self.id = id; self.label = label
        self.persistent = persistent; self.systemPrompt = systemPrompt; self.schema = schema
    }

    func reset() { cancel(); transcript = [] }

    func cancel() {
        generation += 1
        if let d = pendingDone { pendingDone = nil; d(.failure(aiError("cancelled"))) }
        if let p = process, p.isRunning { p.terminate() }
        process = nil
    }

    func next(prompt: String, progress: @escaping (String) -> Void,
              done: @escaping (Swift.Result<[String: Any], Error>) -> Void) {
        cancel()
        guard let exe = Shell.which(id) else { return done(.failure(aiError("\(id) not found on PATH"))) }
        generation += 1
        let gen = generation
        pendingDone = done

        let history = persistent && !transcript.isEmpty
            ? "## Earlier in this session\n" + transcript.suffix(8).joined(separator: "\n") + "\n\n" : ""
        let full = """
        \(systemPrompt)

        ## Output
        Finish with ONLY one JSON object (no prose, no code fence) matching this JSON Schema:
        \(schema)

        \(history)\(prompt)
        """
        let outFile = FileManager.default.temporaryDirectory.appendingPathComponent("aiui-\(UUID().uuidString).txt")
        var args: [String]
        switch id {
        case "codex":
            args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
                    "--color", "never", "-o", outFile.path, "-"]
        default: // gemini
            args = ["--yolo", "-p", full]
        }
        if let m = ProcessInfo.processInfo.environment["AIUI_MODEL"], !m.isEmpty { args = ["-m", m] + args }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = Shell.loginEnvironment
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = inp
        var stdout = Data()
        let lock = NSLock()
        out.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty else { return }
            lock.lock(); stdout.append(d); lock.unlock()
            if let line = String(data: d, encoding: .utf8)?.split(separator: "\n").last {
                let s = String(line.prefix(120))
                DispatchQueue.main.async { [weak self] in if self?.generation == gen { progress(s) } }
            }
        }
        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            let rest = out.fileHandleForReading.readDataToEndOfFile()
            let errText = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            lock.lock(); stdout.append(rest); let all = String(decoding: stdout, as: UTF8.self); lock.unlock()
            let last = (try? String(contentsOf: outFile, encoding: .utf8)) ?? all
            try? FileManager.default.removeItem(at: outFile)
            DispatchQueue.main.async {
                guard let self, self.generation == gen else { return }
                self.process = nil
                self.pendingDone = nil
                if let screen = Claude.extractJSON(last) ?? Claude.extractJSON(all) {
                    if self.persistent {
                        self.transcript.append("- event: \(prompt.prefix(400))\n  → screen: \(screen["note"] as? String ?? screen["title"] as? String ?? "")")
                    }
                    done(.success(screen))
                } else {
                    done(.failure(aiError(errText.isEmpty ? "\(self.id) exited \(proc.terminationStatus) without a screen" : String(errText.suffix(600)))))
                }
            }
        }
        do { try p.run() } catch { pendingDone = nil; return done(.failure(error)) }
        process = p
        if id == "codex" { inp.fileHandleForWriting.write(Data(full.utf8)) }
        try? inp.fileHandleForWriting.close()
        progress("thinking")
    }
}

// MARK: - API key engines (own agent loop: shell tool + screen tool)

/// Runs the agent loop itself against a provider API: the model may call `shell` (full system
/// access, like the agent CLIs) any number of times and ends by calling `screen`.
final class APIEngine: AIEngine {
    let key: Provider.Key
    let persistent: Bool, systemPrompt: String, schema: [String: Any]
    var label: String { "\(key.name) · \(key.model)" }
    private var generation = 0
    private var pendingDone: ((Swift.Result<[String: Any], Error>) -> Void)?
    private var task: Task<Void, Never>?
    /// Append-only conversation (persistent engines), in the provider's wire format.
    private var messages: [[String: Any]] = []
    /// The last turn ended with a `screen` call that still needs its tool result.
    private var openScreenCall: String?

    init(key: Provider.Key, persistent: Bool, systemPrompt: String, schema: String) {
        self.key = key; self.persistent = persistent; self.systemPrompt = systemPrompt
        self.schema = (try? JSONSerialization.jsonObject(with: Data(schema.utf8))) as? [String: Any] ?? [:]
    }

    func reset() { cancel(); messages = []; openScreenCall = nil }

    func cancel() {
        generation += 1
        task?.cancel(); task = nil
        if let d = pendingDone { pendingDone = nil; d(.failure(aiError("cancelled"))) }
    }

    private var instructions: String {
        systemPrompt + """


        ## Tools in this app
        You act through two tools. `shell` runs a zsh command on the user's Mac and returns its output \
        (osascript/JXA included). When you are ready, call `screen` exactly once with the next screen; \
        that ends your turn. Always end by calling `screen`, never with plain text.
        """
    }

    func next(prompt: String, progress: @escaping (String) -> Void,
              done: @escaping (Swift.Result<[String: Any], Error>) -> Void) {
        cancel()
        generation += 1
        let gen = generation
        pendingDone = done
        let start = persistent ? messages : []
        let pending = persistent ? openScreenCall : nil
        progress("thinking")
        task = Task { [weak self] in
            guard let self else { return }
            var convo = start
            let result: Swift.Result<[String: Any], Error>
            do {
                let screen = try await self.loop(&convo, prompt: prompt, pendingScreen: pending) { line in
                    DispatchQueue.main.async { if self.generation == gen { progress(line) } }
                }
                result = .success(screen.screen)
                let final = convo
                await MainActor.run {
                    if self.persistent && self.generation == gen {
                        self.messages = final
                        self.openScreenCall = screen.callID
                    }
                }
            } catch {
                result = .failure(error)
            }
            await MainActor.run {
                guard self.generation == gen else { return }
                self.pendingDone = nil
                self.task = nil
                done(result)
            }
        }
    }

    private func loop(_ convo: inout [[String: Any]], prompt: String, pendingScreen: String?,
                      progress: @escaping (String) -> Void) async throws -> (screen: [String: Any], callID: String?) {
        key.provider == "anthropic"
            ? try await anthropicLoop(&convo, prompt: prompt, pendingScreen: pendingScreen, progress: progress)
            : try await openAILoop(&convo, prompt: prompt, pendingScreen: pendingScreen, progress: progress)
    }

    private let shellTool: (name: String, description: String, schema: [String: Any]) = (
        "shell",
        "Run a zsh command on the user's Mac (login shell; osascript -l JavaScript reaches every Cocoa API). Returns exit code, stdout and stderr.",
        ["type": "object", "properties": ["command": ["type": "string"]], "required": ["command"]]
    )
    private var screenTool: (name: String, description: String, schema: [String: Any]) {
        ("screen", "Show the next screen to the user. Ends your turn.", schema)
    }

    // Anthropic Messages API (raw HTTP; Swift has no official SDK).
    private func anthropicLoop(_ convo: inout [[String: Any]], prompt: String, pendingScreen: String?,
                               progress: @escaping (String) -> Void) async throws -> (screen: [String: Any], callID: String?) {
        var first: [[String: Any]] = []
        if let id = pendingScreen { first.append(["type": "tool_result", "tool_use_id": id, "content": "Screen shown."]) }
        first.append(["type": "text", "text": prompt])
        convo.append(["role": "user", "content": first])
        let tools: [[String: Any]] = [shellTool, screenTool].map {
            ["name": $0.name, "description": $0.description, "input_schema": $0.schema]
        }
        let usesFallbacks = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"].contains(key.model)
        for _ in 0..<30 {
            try Task.checkCancellation()
            var body: [String: Any] = [
                "model": key.model, "max_tokens": 16000, "system": instructions,
                "tools": tools, "tool_choice": ["type": "auto"], "messages": convo,
                "output_config": ["effort": "medium"],
            ]
            var headers = ["x-api-key": key.key, "anthropic-version": "2026-10-21"]
            if usesFallbacks {
                body["fallbacks"] = "default"
                headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
            }
            let res = try await post("\(key.base)/v1/messages", body, headers)
            let content = res["content"] as? [[String: Any]] ?? []
            convo.append(["role": "assistant", "content": content]) // unchanged: thinking blocks included
            let stop = res["stop_reason"] as? String ?? ""
            if stop == "refusal" { throw aiError("The model declined this request.") }
            if stop == "max_tokens" { throw aiError("The model ran out of output tokens.") }
            let uses = content.filter { $0["type"] as? String == "tool_use" }
            if let s = uses.first(where: { $0["name"] as? String == "screen" }) {
                // Other calls in the same turn still need results before the next user turn.
                let others = uses.filter { $0["name"] as? String != "screen" }
                if !others.isEmpty {
                    var results: [[String: Any]] = []
                    for u in others { results.append(["type": "tool_result", "tool_use_id": u["id"] ?? "", "content": "skipped"]) }
                    results.append(["type": "tool_result", "tool_use_id": s["id"] ?? "", "content": "Screen shown."])
                    convo.append(["role": "user", "content": results + [["type": "text", "text": "(continuing)"]]])
                    return (s["input"] as? [String: Any] ?? [:], nil)
                }
                return (s["input"] as? [String: Any] ?? [:], s["id"] as? String)
            }
            if uses.isEmpty {
                convo.append(["role": "user", "content": [["type": "text", "text": "Call the screen tool now with the next screen."]]])
                continue
            }
            var results: [[String: Any]] = []
            for u in uses {
                let cmd = (u["input"] as? [String: Any])?["command"] as? String ?? ""
                progress("shell · \(cmd.prefix(110))")
                results.append(["type": "tool_result", "tool_use_id": u["id"] ?? "", "content": await runShell(cmd)])
            }
            convo.append(["role": "user", "content": results]) // all results in one message
        }
        throw aiError("The model did not produce a screen.")
    }

    // OpenAI-compatible Chat Completions (OpenAI, OpenRouter, Google, Groq, xAI, custom).
    private func openAILoop(_ convo: inout [[String: Any]], prompt: String, pendingScreen: String?,
                            progress: @escaping (String) -> Void) async throws -> (screen: [String: Any], callID: String?) {
        if let id = pendingScreen { convo.append(["role": "tool", "tool_call_id": id, "content": "Screen shown."]) }
        convo.append(["role": "user", "content": prompt])
        let tools: [[String: Any]] = [shellTool, screenTool].map {
            ["type": "function", "function": ["name": $0.name, "description": $0.description, "parameters": $0.schema]]
        }
        for _ in 0..<30 {
            try Task.checkCancellation()
            let body: [String: Any] = ["model": key.model, "tools": tools, "tool_choice": "auto",
                                       "messages": [["role": "system", "content": instructions]] + convo]
            let res = try await post("\(key.base)/chat/completions", body, ["Authorization": "Bearer \(key.key)"])
            guard let msg = ((res["choices"] as? [[String: Any]])?.first)?["message"] as? [String: Any] else {
                throw aiError("Unexpected response from \(key.name).")
            }
            var assistant: [String: Any] = ["role": "assistant", "content": msg["content"] ?? NSNull()]
            let calls = msg["tool_calls"] as? [[String: Any]] ?? []
            if !calls.isEmpty { assistant["tool_calls"] = calls }
            convo.append(assistant)
            func args(_ c: [String: Any]) -> [String: Any] {
                let s = (c["function"] as? [String: Any])?["arguments"] as? String ?? "{}"
                return (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
            }
            func name(_ c: [String: Any]) -> String { (c["function"] as? [String: Any])?["name"] as? String ?? "" }
            if let s = calls.first(where: { name($0) == "screen" }) {
                for c in calls where name(c) != "screen" {
                    convo.append(["role": "tool", "tool_call_id": c["id"] ?? "", "content": "skipped"])
                }
                return (args(s), s["id"] as? String)
            }
            if calls.isEmpty {
                if let text = msg["content"] as? String, let screen = Claude.extractJSON(text) { return (screen, nil) }
                convo.append(["role": "user", "content": "Call the screen tool now with the next screen."])
                continue
            }
            for c in calls {
                let cmd = args(c)["command"] as? String ?? ""
                progress("shell · \(cmd.prefix(110))")
                convo.append(["role": "tool", "tool_call_id": c["id"] ?? "", "content": await runShell(cmd)])
            }
        }
        throw aiError("The model did not produce a screen.")
    }

    private func runShell(_ cmd: String) async -> String {
        await withCheckedContinuation { cont in
            Shell.run("/bin/zsh", ["-lc", cmd]) { r in
                var s = "exit \(r.code)\n\(r.stdout)"
                if !r.stderr.isEmpty { s += "\nstderr:\n\(r.stderr)" }
                cont.resume(returning: String(s.prefix(20000)))
            }
        }
    }

    private func post(_ url: String, _ body: [String: Any], _ headers: [String: String]) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: url)!, timeoutInterval: 600)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = ((obj["error"] as? [String: Any])?["message"] as? String) ?? String(decoding: data.prefix(400), as: UTF8.self)
            throw aiError("\(key.name) error \(status): \(msg)")
        }
        return obj
    }
}
