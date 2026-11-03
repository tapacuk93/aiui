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

func aiError(_ s: String) -> NSError { NSError(domain: "aiui", code: 1, userInfo: [NSLocalizedDescriptionKey: s]) }

/// The outermost {...} of a model's text reply, as JSON (fallback when no tool/structured output came).
func extractJSON(_ text: String) -> [String: Any]? {
    guard let a = text.firstIndex(of: "{"), let b = text.lastIndex(of: "}"), a < b else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(String(text[a...b]).utf8))) as? [String: Any]
}

// MARK: - Provider choice

/// Which AI backs the app: a detected agent CLI, or an API key for a provider (Keychain).
enum Provider {
    /// Agent CLIs we know how to drive, in order of preference.
    static let clis: [(id: String, name: String)] = [
        ("claude", "Claude Code"), ("codex", "Codex CLI"), ("gemini", "Gemini CLI"),
    ]

    static func detectedCLIs() -> [String] {
        #if os(macOS)
        return clis.map(\.id).filter { Shell.which($0) != nil }
        #else
        return []
        #endif
    }

    struct Key: Codable {
        var provider: String   // anthropic | openai-compatible
        var name: String       // display name
        var key: String
        var base: String
        var model: String
        /// Extra request headers (AICoin: `X-AI` names the provider behind the proxy).
        var headers: [String: String]? = nil
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
    private static let service = "com.oeaio.aiui.provider"
    private static let legacyService = "dev.aiui.app.provider"

    static func loadKey() -> Key? {
        if let k = read(service) { return k }
        // Migrate a key saved under the app's earlier bundle identifier.
        guard let old = read(legacyService) else { return nil }
        if saveKey(old) {
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: legacyService] as CFDictionary)
        }
        return old
    }

    private static func read(_ svc: String) -> Key? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc,
                                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Key.self, from: data)
    }

    static func saveKey(_ key: Key) -> Bool {
        deleteKey()
        guard let data = try? JSONEncoder().encode(key) else { return false }
        // Synced through iCloud Keychain to the user's other devices; falls back to this device
        // only where syncing is unavailable (e.g. an ad-hoc signed build).
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key.name, kSecValueData as String: data,
                                kSecAttrSynchronizable as String: true]
        if SecItemAdd(q as CFDictionary, nil) == errSecSuccess { return true }
        q[kSecAttrSynchronizable as String] = false
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func deleteKey() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                       kSecAttrSynchronizable as String: kSecAttrSynchronizableAny] as CFDictionary)
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

    /// Thinking effort for Anthropic models ("low" for quick interim screens).
    var effort = "medium"
    /// An image (JPEG) to send with the next call — e.g. a live screenshot for the improver.
    private var pendingImage: Data?
    func attachImage(_ data: Data) { pendingImage = data }

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
    /// The shell tool exists only where there is a shell (the Mac).
    private var availableTools: [(name: String, description: String, schema: [String: Any])] {
        #if os(macOS)
        return [shellTool, screenTool]
        #else
        return [screenTool]
        #endif
    }

    // Anthropic Messages API (raw HTTP; Swift has no official SDK).
    private func anthropicLoop(_ convo: inout [[String: Any]], prompt: String, pendingScreen: String?,
                               progress: @escaping (String) -> Void) async throws -> (screen: [String: Any], callID: String?) {
        var first: [[String: Any]] = []
        if let id = pendingScreen { first.append(["type": "tool_result", "tool_use_id": id, "content": "Screen shown."]) }
        if let img = pendingImage {
            pendingImage = nil
            first.append(["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": img.base64EncodedString()]])
        }
        first.append(["type": "text", "text": prompt])
        convo.append(["role": "user", "content": first])
        let tools: [[String: Any]] = availableTools.map {
            ["name": $0.name, "description": $0.description, "input_schema": $0.schema]
        }
        let usesFallbacks = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"].contains(key.model)
        for _ in 0..<30 {
            try Task.checkCancellation()
            var body: [String: Any] = [
                "model": key.model, "max_tokens": 16000, "system": instructions,
                "tools": tools, "tool_choice": ["type": "auto"], "messages": convo,
                "output_config": ["effort": effort],
            ]
            var headers = ["x-api-key": key.key, "anthropic-version": "2026-10-21"].merging(key.headers ?? [:]) { $1 }
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
        if let img = pendingImage {
            pendingImage = nil
            convo.append(["role": "user", "content": [
                ["type": "image_url", "image_url": ["url": "data:image/jpeg;base64," + img.base64EncodedString()]],
                ["type": "text", "text": prompt]]])
        } else {
            convo.append(["role": "user", "content": prompt])
        }
        let tools: [[String: Any]] = availableTools.map {
            ["type": "function", "function": ["name": $0.name, "description": $0.description, "parameters": $0.schema]]
        }
        for _ in 0..<30 {
            try Task.checkCancellation()
            let body: [String: Any] = ["model": key.model, "tools": tools, "tool_choice": "auto",
                                       "messages": [["role": "system", "content": instructions]] + convo]
            let res = try await post("\(key.base)/chat/completions", body, ["Authorization": "Bearer \(key.key)"].merging(key.headers ?? [:]) { $1 })
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
                if let text = msg["content"] as? String, let screen = extractJSON(text) { return (screen, nil) }
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
        #if os(macOS)
        await withCheckedContinuation { cont in
            Shell.run("/bin/zsh", ["-lc", cmd]) { r in
                var s = "exit \(r.code)\n\(r.stdout)"
                if !r.stderr.isEmpty { s += "\nstderr:\n\(r.stderr)" }
                cont.resume(returning: String(s.prefix(20000)))
            }
        }
        #else
        "No shell on this device."
        #endif
    }

    private func post(_ url: String, _ body: [String: Any], _ headers: [String: String]) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: url)!, timeoutInterval: persistent ? 180 : 100)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 402, key.base == AICoin.proxy { throw AICoin.paymentError(obj) }
            let msg = ((obj["error"] as? [String: Any])?["message"] as? String) ?? String(decoding: data.prefix(400), as: UTF8.self)
            throw aiError("\(key.name) error \(status): \(msg)")
        }
        return obj
    }
}
