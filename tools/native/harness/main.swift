import Foundation

// Test harness for NativeLibraries without the CEF app: the real store code and the real shell
// environment (Shell.loginEnvironment), with a stand-in for the API's statics.
//   tools/native/harness/run.sh <scenario>
// Scenarios: blocked | mismatch | update | cancel | policy | pack DIR | bundle DIR | install | shell
// Its settings live in the harness's own defaults domain, not the app's.

final class API {
    static var paused = false
    static var webRoot: URL? = URL(fileURLWithPath: CommandLine.arguments[1])   // the repo's web/
    static func activity(_ id: String, _ title: String?, key: String? = nil, kind: String? = nil, name: String? = nil,
                         detail: String? = nil, actions: [String] = []) {
        print("  activity \(id): \(title ?? "done")\(detail.map { " · \($0)" } ?? "")\(actions.isEmpty ? "" : " \(actions)")")
    }
}

let args = Array(CommandLine.arguments.dropFirst(2))
let scenario = args.first ?? "install"
let web = API.webRoot!
let bundled = web.appendingPathComponent("native.json")
var failures = 0
func check(_ ok: Bool, _ what: String) { print(ok ? "✓ \(what)" : "✗ \(what)"); if !ok { failures += 1 } }
func finish() -> Never { print(failures == 0 ? "PASS" : "FAIL (\(failures))"); exit(failures == 0 ? 0 : 1) }
func temp() -> URL {
    let d = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("aiui-native-test-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}
/// A catalog with the given tools (edited copies of the bundled entries).
func catalog(_ tools: [[String: Any]], version: Int, at url: URL) {
    let c: [String: Any] = ["version": version, "platform": "macos-arm64", "tools": tools]
    try! JSONSerialization.data(withJSONObject: c).write(to: url)
}
let base = NativeLibraries.readCatalog(bundled)!
func tool(_ id: String) -> [String: Any] { (base["tools"] as! [[String: Any]]).first { $0["id"] as? String == id }! }
func store(_ dir: URL, catalogAt: URL, pack: URL? = nil) -> NativeLibraries {
    let s = NativeLibraries(dir: dir)
    s.bundledCatalog = catalogAt
    s.packDir = pack
    s.loadCatalog()
    return s
}
func sh(_ cmd: String) -> Shell.Result { Shell.runSync("/bin/zsh", ["-lc", cmd]) }

switch scenario {
case "blocked":
    // Setting off: background maintenance and an explicit request download nothing, and say why.
    let dir = temp()
    NativeLibraries.settingOn = false
    let s = store(dir, catalogAt: bundled)
    s.maintain {
        check(s.lastBlocked == "turned off in Settings (Download native libraries)", "background: blocked — \(s.lastBlocked ?? "nil")")
        s.ensure(["jq"], wait: 10) { r in
            let failed = r["failed"] as? [String: String] ?? [:]
            check(failed["jq"]?.contains("turned off in Settings") == true, "ensure jq refused: \(failed["jq"] ?? "-")")
            check((s.status()["policy"] as? [String: Any])?["allowed"] as? Bool == false, "status reports policy blocked")
            let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
            check(!files.contains("jq") && (s.status()["used"] as? Int) == 0, "nothing downloaded (\(files.sorted()))")
            // Paused: background blocked, a foreground request is not.
            NativeLibraries.settingOn = true
            API.paused = true
            check(s.blocked(background: true) == "background work is paused", "paused blocks background work")
            check(s.blocked(background: false) == nil, "paused does not block an explicit request")
            API.paused = false
            finish()
        }
    }

case "mismatch":
    // A wrong pinned hash: the download is refused and nothing is installed or linked.
    let dir = temp()
    NativeLibraries.settingOn = true
    var jq = tool("jq")
    var arts = jq["artifacts"] as! [[String: Any]]
    arts[0]["sha256"] = String(repeating: "0", count: 64)
    jq["artifacts"] = arts
    let cat = dir.appendingPathComponent("cat.json")
    catalog([jq], version: 1, at: cat)
    let s = store(dir.appendingPathComponent("native"), catalogAt: cat)
    s.install("jq") { err in
        check(err?.contains("SHA-256 mismatch") == true, "refused: \(err ?? "installed!")")
        let d = dir.appendingPathComponent("native")
        check(!FileManager.default.fileExists(atPath: d.appendingPathComponent("jq").path), "no jq folder")
        check(!FileManager.default.fileExists(atPath: d.appendingPathComponent("bin/jq").path), "no jq link")
        let left = ((try? FileManager.default.contentsOfDirectory(atPath: d.path)) ?? []).filter { $0.hasPrefix(".staging") }
        check(left.isEmpty, "staging cleaned up")
        finish()
    }

case "update":
    // jq 1.7.1 → catalog update to 1.8.2 (atomic swap, 1.7.1 kept) → rollback → remove.
    let dir = temp()
    NativeLibraries.settingOn = true
    var old = tool("jq")
    old["version"] = "1.7.1"
    old["artifacts"] = [["url": "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-macos-arm64", "name": "jq-macos-arm64",
                         "format": "file", "sha256": "0bbe619e663e0de2c550be2fe0d240d076799d6f8a652b70fa04aea8a8362e8a",
                         "bytes": 0, "bin": ["jq": "jq-macos-arm64"]]]
    let c1 = dir.appendingPathComponent("c1.json"), c2 = dir.appendingPathComponent("c2.json")
    catalog([old], version: 1, at: c1)
    catalog([tool("jq")], version: 2, at: c2)
    let d = dir.appendingPathComponent("native")
    let s = store(d, catalogAt: c1)
    func jqVersion() -> String {
        NativeLibraries.run(d.appendingPathComponent("bin/jq").path, ["--version"], timeout: 10).out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    s.install("jq") { err in
        check(err == nil, "jq 1.7.1 installed \(err ?? "")")
        s.start(after: 3600)        // links + helper; the live catalog URL is pointed at c2 below
        check(jqVersion() == "jq-1.7.1", "bin/jq runs: \(jqVersion())")
        s.bundledCatalog = c2
        s.loadCatalog()
        s.maintain(force: true) {
            let st = (s.status()["tools"] as! [[String: Any]])[0]
            check(st["installedVersion"] as? String == "1.8.2" && st["previous"] as? String == "1.7.1", "updated to 1.8.2, previous 1.7.1 kept")
            check(jqVersion() == "jq-1.8.2", "bin/jq now: \(jqVersion())")
            let cur = try? FileManager.default.destinationOfSymbolicLink(atPath: d.appendingPathComponent("jq/current").path)
            check(cur == "1.8.2", "current → \(cur ?? "-")")
            check(s.rollback("jq") == nil && jqVersion() == "jq-1.7.1", "rollback → \(jqVersion())")
            s.remove("jq")
            check(!FileManager.default.fileExists(atPath: d.appendingPathComponent("bin/jq").path), "removed, link gone")
            finish()
        }
    }

case "pack":
    // Offline: setting off (no downloads), jq and ripgrep from a pack folder, hash-checked.
    let dir = temp()
    let pack = URL(fileURLWithPath: args[1])
    NativeLibraries.settingOn = false
    var tools: [[String: Any]] = []
    for id in ["jq", "ripgrep", "pandoc"] { var t = tool(id); t["default"] = true; tools.append(t) }
    let cat = dir.appendingPathComponent("cat.json")
    catalog(tools, version: 1, at: cat)
    let s = store(dir.appendingPathComponent("native"), catalogAt: cat, pack: pack)
    s.maintain {
        let st = s.status()["tools"] as! [[String: Any]]
        let inst = st.filter { $0["installed"] as? Bool == true }.map { $0["id"] as! String }
        check(inst.sorted() == ["jq", "ripgrep"], "installed from the pack offline: \(inst)")
        check(st.first { $0["id"] as? String == "pandoc" }?["installed"] as? Bool == false, "pandoc (not in the pack) not downloaded")
        check(st.allSatisfy { ($0["fromPack"] as? Bool ?? true) }, "marked fromPack")
        check(s.lastBlocked != nil, "download step blocked: \(s.lastBlocked ?? "-")")
        NativeLibraries.settingOn = true
        finish()
    }

case "install":
    // The real store (Application Support/aiui/native): the default set, then every tool through
    // the app's shell environment, and aiui-native from a shell.
    NativeLibraries.settingOn = true
    let s = NativeLibraries.shared
    s.bundledCatalog = bundled
    s.start(after: 3600)
    let t0 = Date()
    s.maintain(force: true) {
        print(String(format: "maintenance took %.0f s", Date().timeIntervalSince(t0)))
        let st = s.status()
        for t in st["tools"] as! [[String: Any]] where t["default"] as? Bool == true {
            check(t["installed"] as? Bool == true, "\(t["id"]!) \(t["installedVersion"] ?? "-") · \(NativeLibraries.mb(t["diskBytes"] as? Int ?? 0)) \(t["error"] ?? "")")
        }
        print("used \(NativeLibraries.mb(st["used"] as! Int)) of budget \(NativeLibraries.mb(st["budget"] as! Int))")
        DispatchQueue.global().async {
            let r = sh("aiui-native ensure fd")
            DispatchQueue.main.async {
                check(r.code == 0 && r.stdout.contains("\"fd\""), "aiui-native ensure fd from a login shell: \(r.stdout.prefix(200)) \(r.stderr.prefix(200))")
                finish()
            }
        }
    }

case "shell":
    // Each installed tool's version through Shell.loginEnvironment (as aiui.sys shell / the AI run them).
    NativeLibraries.shared.bundledCatalog = bundled
    NativeLibraries.shared.start(after: 3600)        // answers aiui-native
    let cat = NativeLibraries.readCatalog(bundled)!
    DispatchQueue.global().async {
    print("PATH ends with: …\(Shell.loginEnvironment["PATH"]!.suffix(80))")
    for t in cat["tools"] as! [[String: Any]] {
        guard let checkCmd = t["check"] as? [String] else { continue }
        let exe = checkCmd[0]
        // command -v shows which one a bare name finds (the user's own installs come first);
        // the check runs the store's copy through $AIUI_NATIVE_BIN from the same login shell.
        let r = sh("command -v \(exe) && \"$AIUI_NATIVE_BIN/\(exe)\" \(checkCmd.dropFirst().joined(separator: " ")) 2>&1 | grep -m1 .")
        let lines = r.stdout.split(separator: "\n")
        let installed = FileManager.default.fileExists(atPath: NativeLibraries.binDir.appendingPathComponent(exe).path)
        if !installed { print("· \(t["id"]!) not installed"); continue }
        check(r.code == 0 && lines.count >= 2, "\(exe): \(lines.first ?? "") → \(lines.dropFirst().first ?? r.stderr.prefix(120))")
    }
    for exe in ["\"$AIUI_NATIVE_BIN/ffprobe\" -version", "pdftoppm -v", "exiftool -ver", "rg --version", "aiui-native list"] {
        let r = sh("\(exe) 2>&1 | grep -m1 .")
        check(r.code == 0 && !r.stdout.isEmpty, "\(exe): \(r.stdout.prefix(100).trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    DispatchQueue.main.async { finish() }
    }

case "cancel":
    // The activity's cancel action: a running download stops and leaves nothing behind.
    let dir = temp()
    NativeLibraries.settingOn = true
    let s = store(dir, catalogAt: bundled)
    s.install("pandoc") { err in
        check(err == "cancelled", "install ended: \(err ?? "installed")")
        let left = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasPrefix(".") || $0 == "pandoc" }
        check(left.isEmpty, "nothing left behind \(left)")
        finish()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { s.cancel("pandoc") }

case "bundle":
    // The app bundle's pack (./build.sh --native-pack): the whole default set offline, downloads off.
    let dir = temp()
    NativeLibraries.settingOn = false
    let s = store(dir, catalogAt: bundled, pack: URL(fileURLWithPath: args[1]))
    let t0 = Date()
    s.maintain {
        let st = s.status()["tools"] as! [[String: Any]]
        for t in st where t["default"] as? Bool == true {
            check(t["installed"] as? Bool == true && t["fromPack"] as? Bool == true, "\(t["id"]!) from the pack \(t["error"] ?? "")")
        }
        check(st.filter { $0["default"] as? Bool == false }.allSatisfy { $0["installed"] as? Bool == false }, "extras not downloaded")
        print(String(format: "offline install took %.0f s", Date().timeIntervalSince(t0)))
        NativeLibraries.settingOn = true
        try? FileManager.default.removeItem(at: dir)
        finish()
    }

case "policy":
    let s = NativeLibraries(dir: temp())
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        print(s.policy())
        check((s.policy()["network"] as? String) != "unknown", "network state known")
        finish()
    }

default:
    print("unknown scenario"); exit(2)
}
dispatchMain()
