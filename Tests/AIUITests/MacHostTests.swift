import XCTest
import Cocoa
@testable import AIUI

final class MacHostTests: AIUITestCase {
    private var savedRun = API.sysRun
    private var savedOpen = API.sysOpen
    private var savedPasteboard = API.sysPasteboard
    private var runs: [(exe: String, args: [String], stdin: String?)] = []
    private var opened: [URL] = []
    private var reply = Shell.Result(code: 0, stdout: "out", stderr: "err")

    override func setUp() {
        super.setUp()
        savedRun = API.sysRun; savedOpen = API.sysOpen; savedPasteboard = API.sysPasteboard
        runs = []; opened = []
        API.sysRun = { [unowned self] exe, args, stdin, done in
            runs.append((exe, args, stdin))
            let r = reply
            DispatchQueue.main.async { done(r) }
        }
        API.sysOpen = { [unowned self] in opened.append($0) }
    }

    override func tearDown() {
        API.sysRun = savedRun; API.sysOpen = savedOpen; API.sysPasteboard = savedPasteboard
        super.tearDown()
    }

    /// Runs one `sys` call and waits for its answer.
    private func sys(_ input: [String: Any]) -> (sent: [String: Any]?, failed: String?) {
        var sent: [String: Any]?, failed: String?
        API.sys(input, send: { sent = $0 }, fail: { failed = $0 })
        waitUntil { sent != nil || failed != nil }
        return (sent, failed)
    }

    func testShellRunsARealHarmlessCommand() {
        API.sysRun = savedRun
        let r = sys(["op": "shell", "cmd": "echo hi; echo there >&2; exit 4"])
        XCTAssertEqual(r.sent?["code"] as? Int, 4)
        XCTAssertEqual(r.sent?["stdout"] as? String, "hi\n")
        XCTAssertEqual(r.sent?["stderr"] as? String, "there\n")
    }

    func testScriptOpsGoThroughOsascriptWithStdin() {
        var r = sys(["op": "jxa", "script": "1+1"])
        XCTAssertEqual(r.sent?["stdout"] as? String, "out")
        XCTAssertEqual(r.sent?["stderr"] as? String, "err")
        XCTAssertEqual(r.sent?["code"] as? Int, 0)
        XCTAssertEqual(runs.last?.exe, "/usr/bin/osascript")
        XCTAssertEqual(runs.last?.args, ["-l", "JavaScript", "-"])
        XCTAssertEqual(runs.last?.stdin, "1+1")
        r = sys(["op": "applescript", "script": "beep"])
        XCTAssertNotNil(r.sent)
        XCTAssertEqual(runs.last?.args, ["-"])
        XCTAssertEqual(runs.last?.stdin, "beep")
    }

    func testMissingArgumentsFail() {
        XCTAssertEqual(sys(["op": "shell"]).failed, "cmd required")
        XCTAssertEqual(sys(["op": "jxa"]).failed, "script required")
        XCTAssertEqual(sys(["op": "applescript"]).failed, "script required")
        XCTAssertEqual(sys(["op": "open"]).failed, "target required")
        XCTAssertEqual(sys(["op": "read"]).failed, "path required")
        XCTAssertEqual(sys(["op": "write", "path": "/x"]).failed, "path and text required")
        XCTAssertEqual(sys([:]).failed, "unknown op ")
        XCTAssertEqual(sys(["op": "dance"]).failed, "unknown op dance")
        XCTAssertTrue(runs.isEmpty)
    }

    func testOpenURLFileOrApp() {
        XCTAssertEqual(sys(["op": "open", "target": "https://example.test/a"]).sent?["ok"] as? Bool, true)
        XCTAssertEqual(opened.last, URL(string: "https://example.test/a"))

        let file = TestEnv.tempDir("open").appendingPathComponent("f.txt")
        try? "x".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(sys(["op": "open", "target": file.path]).sent?["ok"] as? Bool, true)
        XCTAssertEqual(opened.last?.path, file.path)
        XCTAssertEqual(opened.count, 2)

        XCTAssertEqual(sys(["op": "open", "target": "Some App"]).sent?["ok"] as? Bool, true)
        XCTAssertEqual(runs.last?.exe, "/usr/bin/open")
        XCTAssertEqual(runs.last?.args, ["-a", "Some App"])
        reply = Shell.Result(code: 1, stdout: "", stderr: "Unable to find application named 'Nope'")
        XCTAssertEqual(sys(["op": "open", "target": "Nope"]).failed, "Unable to find application named 'Nope'")
        XCTAssertEqual(opened.count, 2)
    }

    func testReadAndWriteFiles() {
        let dir = TestEnv.tempDir("rw")
        let path = dir.appendingPathComponent("a.txt").path
        XCTAssertEqual(sys(["op": "write", "path": path, "text": "héllo"]).sent?["ok"] as? Bool, true)
        XCTAssertEqual(try? String(contentsOfFile: path, encoding: .utf8), "héllo")
        XCTAssertEqual(sys(["op": "read", "path": path]).sent?["text"] as? String, "héllo")
        XCTAssertEqual(sys(["op": "read", "path": dir.appendingPathComponent("none").path]).failed,
                       "cannot read \(dir.appendingPathComponent("none").path)")
        XCTAssertNotNil(sys(["op": "write", "path": dir.appendingPathComponent("no/dir/a.txt").path, "text": "x"]).failed)
    }

    func testClipboardUsesTheGivenPasteboard() {
        XCTAssertTrue(savedPasteboard() === NSPasteboard.general)
        let pb = NSPasteboard(name: NSPasteboard.Name("com.oeaio.aiui.tests.\(getpid())"))
        API.sysPasteboard = { pb }
        defer { pb.releaseGlobally() }
        XCTAssertEqual(sys(["op": "clipboard", "text": "copied"]).sent?["ok"] as? Bool, true)
        XCTAssertEqual(pb.string(forType: .string), "copied")
        XCTAssertEqual(sys(["op": "clipboard"]).sent?["text"] as? String, "copied")
        pb.clearContents()
        XCTAssertEqual(sys(["op": "clipboard"]).sent?["text"] as? String, "")
    }

    func testNotifyQuotesForAppleScript() {
        XCTAssertEqual(sys(["op": "notify", "title": "T \"q\"", "text": "a\\b"]).sent?["ok"] as? Bool, true)
        XCTAssertEqual(runs.last?.args, ["-e", "display notification \"a\\\\b\" with title \"T \\\"q\\\"\""])
        _ = sys(["op": "notify"])
        XCTAssertEqual(runs.last?.args, ["-e", "display notification \"\" with title \"AI UI\""])
    }

    func testNativeHandsOverToNativeLibraries() {
        let r = sys(["op": "native", "action": "aiui-unknown-action"])
        XCTAssertNotNil(r.sent)
        XCTAssertNil(r.failed)
    }
}
