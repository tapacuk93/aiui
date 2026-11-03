import Foundation

/// Drives the `claude` CLI, one request in flight. A persistent instance keeps one conversation
/// per app session; a non-persistent one starts fresh every call (used for paging).
final class Claude {
    let persistent: Bool
    let systemPrompt: String
    let schema: String

    init(persistent: Bool, systemPrompt: String, schema: String) {
        self.persistent = persistent
        self.systemPrompt = systemPrompt
        self.schema = schema
    }

    private(set) var sessionID = UUID().uuidString.lowercased()
    private var started = false
    private var process: Process?
    private var generation = 0
    private var pendingDone: ((Swift.Result<[String: Any], Error>) -> Void)?

    var model: String? = ProcessInfo.processInfo.environment["AIUI_MODEL"]

    func reset() {
        cancel()
        sessionID = UUID().uuidString.lowercased()
        started = false
    }

    func cancel() {
        generation += 1
        if let d = pendingDone {
            pendingDone = nil
            d(.failure(err("cancelled")))
        }
        if let p = process, p.isRunning {
            p.terminate()
            // An interrupted first call may have created the session id; don't reuse it.
            if !started { sessionID = UUID().uuidString.lowercased() }
        }
        process = nil
    }

    /// Asks for the next screen. `progress` gets short status lines; `done` gets the screen JSON.
    /// Both are called on the main thread. A newer request cancels this one silently.
    func next(prompt: String,
              progress: @escaping (String) -> Void,
              done: @escaping (Swift.Result<[String: Any], Error>) -> Void) {
        cancel()
        guard let exe = Shell.which("claude") else {
            done(.failure(err("The claude CLI was not found on PATH. Install Claude Code and sign in.")))
            return
        }
        generation += 1
        let gen = generation
        pendingDone = done

        var args = ["-p", "--output-format", "stream-json", "--verbose",
                    "--permission-mode", "bypassPermissions",
                    "--append-system-prompt", systemPrompt,
                    "--json-schema", schema]
        if let model, !model.isEmpty { args += ["--model", model] }
        if persistent { args += started ? ["--resume", sessionID] : ["--session-id", sessionID] }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = Shell.loginEnvironment
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let out = Pipe(), errPipe = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = errPipe
        p.standardInput = inp

        var buffer = Data()
        var screen: [String: Any]?
        var resultText: String?
        var resultError: String?
        var stderrText = ""
        let lock = NSLock()

        func onMain(_ f: @escaping () -> Void) {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == gen else { return }
                f()
            }
        }

        func handle(line: Data) {
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
            switch obj["type"] as? String {
            case "assistant":
                let content = ((obj["message"] as? [String: Any])?["content"] as? [[String: Any]]) ?? []
                for c in content {
                    switch c["type"] as? String {
                    case "tool_use":
                        let name = c["name"] as? String ?? "tool"
                        let input = c["input"] as? [String: Any] ?? [:]
                        if name == "StructuredOutput" {
                            lock.lock(); screen = input; lock.unlock()
                            onMain { progress("composing screen") }
                        } else {
                            let detail = Self.describe(tool: name, input: input)
                            onMain { progress(detail) }
                        }
                    case "text":
                        if let t = c["text"] as? String, !t.isEmpty {
                            let line = String(t.prefix(140))
                            onMain { progress(line) }
                        }
                    case "thinking":
                        onMain { progress("thinking") }
                    default: break
                    }
                }
            case "result":
                lock.lock()
                if let so = obj["structured_output"] as? [String: Any] { screen = so }
                resultText = obj["result"] as? String
                if (obj["is_error"] as? Bool) == true {
                    resultError = (obj["result"] as? String) ?? (obj["subtype"] as? String) ?? "error"
                }
                lock.unlock()
            default: break
            }
        }

        out.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            if chunk.isEmpty { return }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                if !line.isEmpty { handle(line: line) }
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty { lock.lock(); stderrText += String(decoding: d, as: UTF8.self); lock.unlock() }
        }

        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            let rest = out.fileHandleForReading.readDataToEndOfFile()
            if !rest.isEmpty {
                buffer.append(rest)
                for line in buffer.split(separator: 0x0A) where !line.isEmpty { handle(line: Data(line)) }
            }
            lock.lock()
            let s = screen, text = resultText, rErr = resultError, stderr = stderrText
            lock.unlock()
            onMain {
                guard let self else { return }
                self.process = nil
                self.pendingDone = nil
                if let s { self.started = true; done(.success(s)); return }
                if let text, let parsed = Self.extractJSON(text) { self.started = true; done(.success(parsed)); return }
                let msg = rErr ?? (stderr.isEmpty ? "claude exited with status \(proc.terminationStatus)" : stderr)
                // A failed first call may or may not have created the session: start a fresh one.
                if !self.started { self.sessionID = UUID().uuidString.lowercased() }
                done(.failure(self.err(String(msg.prefix(600)))))
            }
        }

        do {
            try p.run()
        } catch {
            pendingDone = nil
            done(.failure(error))
            return
        }
        process = p
        inp.fileHandleForWriting.write(prompt.data(using: .utf8)!)
        try? inp.fileHandleForWriting.close()
        progress("thinking")
    }

    func err(_ s: String) -> NSError {
        NSError(domain: "aiui", code: 1, userInfo: [NSLocalizedDescriptionKey: s])
    }

    static func describe(tool: String, input: [String: Any]) -> String {
        let detail = (input["description"] as? String)
            ?? (input["command"] as? String)
            ?? (input["file_path"] as? String)
            ?? (input["pattern"] as? String)
            ?? (input["query"] as? String)
            ?? (input["url"] as? String)
            ?? ""
        let d = detail.replacingOccurrences(of: "\n", with: " ")
        return d.isEmpty ? tool : "\(tool) · \(d.prefix(110))"
    }

    /// Fallback when no structured output came back: take the outermost {...} of the text.
    static func extractJSON(_ text: String) -> [String: Any]? {
        guard let a = text.firstIndex(of: "{"), let b = text.lastIndex(of: "}"), a < b else { return nil }
        let slice = String(text[a...b])
        return (try? JSONSerialization.jsonObject(with: Data(slice.utf8))) as? [String: Any]
    }
}
