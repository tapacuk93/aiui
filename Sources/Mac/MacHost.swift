import Cocoa

/// The Mac host: CEF serves aiui:// and hands /api/* to API.
extension API: AIUIHost {}

extension API {
    // MARK: - System access for the page and AI-generated views (Mac: everything)

    /// What `sys` acts through (tests swap them so they never open apps, run AppleScript or
    /// change the user's clipboard): process runner, URL opener, pasteboard.
    static var sysRun: (String, [String], String?, @escaping (Shell.Result) -> Void) -> Void = {
        Shell.run($0, $1, stdin: $2, completion: $3)
    }
    static var sysOpen: (URL) -> Void = { NSWorkspace.shared.open($0) }
    static var sysPasteboard: () -> NSPasteboard = { .general }

    static func sys(_ input: [String: Any], send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        let op = input["op"] as? String ?? ""
        let shellResult: (Shell.Result) -> Void = { r in
            send(["code": Int(r.code), "stdout": r.stdout, "stderr": r.stderr])
        }
        switch op {
        case "shell":
            guard let cmd = input["cmd"] as? String else { return fail("cmd required") }
            sysRun("/bin/zsh", ["-lc", cmd], nil, shellResult)
        case "jxa":
            guard let script = input["script"] as? String else { return fail("script required") }
            sysRun("/usr/bin/osascript", ["-l", "JavaScript", "-"], script, shellResult)
        case "applescript":
            guard let script = input["script"] as? String else { return fail("script required") }
            sysRun("/usr/bin/osascript", ["-"], script, shellResult)
        case "open":
            guard let target = input["target"] as? String else { return fail("target required") }
            if let url = URL(string: target), url.scheme != nil, !target.hasPrefix("/") {
                sysOpen(url)
            } else if FileManager.default.fileExists(atPath: (target as NSString).expandingTildeInPath) {
                sysOpen(URL(fileURLWithPath: (target as NSString).expandingTildeInPath))
            } else {
                sysRun("/usr/bin/open", ["-a", target], nil) { r in
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
            let pb = sysPasteboard()
            if let text = input["text"] as? String {
                pb.clearContents()
                pb.setString(text, forType: .string)
                send(["ok": true])
            } else {
                send(["text": pb.string(forType: .string) ?? ""])
            }
        case "native":                            // native tools: {op:'native', action:'ensure', ids:[...]}
            NativeLibraries.shared.handle(input.filter { $0.key != "op" }, send: send, fail: fail)
        case "notify":
            let title = input["title"] as? String ?? "AI UI"
            let text = input["text"] as? String ?? ""
            let script = "display notification \(appleQuote(text)) with title \(appleQuote(title))"
            sysRun("/usr/bin/osascript", ["-e", script], nil) { _ in send(["ok": true]) }
        default:
            fail("unknown op \(op)")
        }
    }

    private static func appleQuote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
