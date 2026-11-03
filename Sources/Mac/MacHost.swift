import Cocoa

/// The Mac host: CEF serves aiui:// and hands /api/* to API.
extension API: AIUIHost {}

extension API {
    // MARK: - System access for the page and AI-generated views (Mac: everything)

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
            let title = input["title"] as? String ?? "AI UI"
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
