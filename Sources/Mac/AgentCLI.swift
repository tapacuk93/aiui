import Foundation

extension Claude: AIEngine {
    var label: String { "Claude Code" }
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
                if let screen = extractJSON(last) ?? extractJSON(all) {
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
        Shell.adopt(p)
        let deadline = persistent ? 180.0 : 100.0
        DispatchQueue.main.asyncAfter(deadline: .now() + deadline) { [weak self, weak p] in
            guard let self, let p, p.isRunning, self.generation == gen else { return }
            p.terminate()
        }
        if id == "codex" { inp.fileHandleForWriting.write(Data(full.utf8)) }
        try? inp.fileHandleForWriting.close()
        progress("thinking")
    }
}

