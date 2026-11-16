import XCTest
@testable import AIUI

/// Helpers shared by the agent-CLI tests (Claude, AgentCLI).
enum CLITest {
    /// Writes `lines` as a shell script body that prints them (single-quoted) to stdout.
    static func printLines(_ lines: [String]) -> String {
        lines.map { "printf '%s\\n' '\($0.replacingOccurrences(of: "'", with: "'\\''"))'" }.joined(separator: "\n")
    }
    static func json(_ obj: Any) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)
    }
    /// A file in the fake PATH folder that is executable but not a program (Process.run fails).
    static func brokenTool(_ name: String) {
        let u = TestEnv.fakeBin.appendingPathComponent(name)
        try? Data([0xCA, 0xFE, 0x00, 0x01, 0x02]).write(to: u)
        chmod(u.path, 0o755)
    }
}

final class ClaudeTests: AIUITestCase {
    private var dir: URL!
    private var argsFile: URL { dir.appendingPathComponent("args.txt") }
    private var stdinFile: URL { dir.appendingPathComponent("stdin.txt") }

    override func setUp() {
        super.setUp()
        signal(SIGPIPE, SIG_IGN)
        dir = TestEnv.tempDir("claude")
    }

    override func tearDown() {
        TestEnv.removeFake("claude")
        super.tearDown()
    }

    /// A fake `claude` that records its arguments and stdin, then runs `body`.
    private func fake(_ body: String) {
        TestEnv.fakeTool("claude", """
        printf '%s\\n' "$@" > '\(argsFile.path)'
        cat > '\(stdinFile.path)'
        \(body)
        """)
    }

    private func args() -> [String] {
        ((try? String(contentsOf: argsFile, encoding: .utf8)) ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    private func run(_ c: Claude, _ prompt: String = "hello") -> (result: Swift.Result<[String: Any], Error>, progress: [String]) {
        var progress: [String] = []
        var result: Swift.Result<[String: Any], Error>?
        c.next(prompt: prompt, progress: { progress.append($0) }, done: { result = $0 })
        waitUntil(10) { result != nil }
        spin()
        return (result ?? .failure(aiError("no result")), progress)
    }

    private func message(_ r: Swift.Result<[String: Any], Error>) -> String? {
        if case .failure(let e) = r { return e.localizedDescription }
        return nil
    }

    func testMissingCLIFails() {
        TestEnv.removeFake("claude")
        let c = Claude(persistent: false, systemPrompt: "s", schema: "{}")
        XCTAssertEqual(c.label, "Claude Code")
        XCTAssertEqual(message(run(c).result), "The claude CLI was not found on PATH. Install Claude Code and sign in.")
    }

    func testStreamedScreenProgressAndPersistentSession() {
        let assistant: [String: Any] = ["type": "assistant", "message": ["content": [
            ["type": "thinking", "thinking": "hmm"],
            ["type": "text", "text": "Looking around"],
            ["type": "text", "text": ""],
            ["type": "tool_use", "name": "Bash", "input": ["command": "osascript -e 'tell application \"Music\" to play'", "description": "Play\nmusic"]],
            ["type": "tool_use", "name": "Read", "input": ["file_path": "/tmp/x"]],
            ["type": "image"],
            ["type": "tool_use", "name": "StructuredOutput", "input": ["title": "Draft"]],
        ]]]
        fake(CLITest.printLines([
            "not json",
            CLITest.json(["type": "system", "subtype": "init"]),
            CLITest.json(assistant),
            "",
            CLITest.json(["type": "result", "result": "done", "is_error": false]),
        ]))
        let c = Claude(persistent: true, systemPrompt: "SYS", schema: "{\"type\":\"object\"}")
        c.model = "opus"
        let first = run(c, "first prompt")
        XCTAssertEqual(try first.result.get()["title"] as? String, "Draft")
        XCTAssertEqual(first.progress.first, "thinking")
        XCTAssertTrue(first.progress.contains("Looking around"))
        XCTAssertTrue(first.progress.contains("Bash · Play music"))
        XCTAssertTrue(first.progress.contains("Read · /tmp/x"))
        XCTAssertTrue(first.progress.contains("composing screen"))
        XCTAssertEqual(try? String(contentsOf: stdinFile, encoding: .utf8), "first prompt")
        let a1 = args()
        XCTAssertEqual(Array(a1.prefix(4)), ["-p", "--output-format", "stream-json", "--verbose"])
        XCTAssertTrue(a1.contains("bypassPermissions"))
        XCTAssertTrue(a1.contains("SYS"))
        XCTAssertTrue(a1.contains("{\"type\":\"object\"}"))
        XCTAssertEqual(a1[a1.firstIndex(of: "--model")! + 1], "opus")
        XCTAssertEqual(a1[a1.firstIndex(of: "--session-id")! + 1], c.sessionID)

        // The next call resumes the same session.
        let id = c.sessionID
        _ = run(c)
        let a2 = args()
        XCTAssertEqual(a2[a2.firstIndex(of: "--resume")! + 1], id)
        XCTAssertFalse(a2.contains("--session-id"))

        // reset starts a new session.
        c.reset()
        XCTAssertNotEqual(c.sessionID, id)
        _ = run(c)
        XCTAssertTrue(args().contains("--session-id"))
    }

    func testReadOnlyNonPersistentAndStructuredResult() {
        fake(CLITest.printLines([CLITest.json(["type": "result", "structured_output": ["title": "S"], "result": "x"])]))
        let c = Claude(persistent: false, systemPrompt: "s", schema: "{}")
        c.readOnly = true
        c.model = ""
        XCTAssertEqual(try run(c).result.get()["title"] as? String, "S")
        let a = args()
        XCTAssertEqual(a[a.firstIndex(of: "--permission-mode")! + 1], "dontAsk")
        XCTAssertEqual(a[a.firstIndex(of: "--tools")! + 1], "")
        XCTAssertFalse(a.contains("--model"))
        XCTAssertFalse(a.contains("--session-id"))
        XCTAssertFalse(a.contains("--resume"))
    }

    func testResultTextJSONIsTheFallbackScreen() {
        fake(CLITest.printLines([CLITest.json(["type": "result", "result": "Here: {\"title\":\"From text\"} ok"])]))
        let c = Claude(persistent: true, systemPrompt: "s", schema: "{}")
        XCTAssertEqual(try run(c).result.get()["title"] as? String, "From text")
        _ = run(c)
        XCTAssertTrue(args().contains("--resume"))
    }

    func testErrorsFromResultStderrAndExitStatus() {
        let c = Claude(persistent: true, systemPrompt: "s", schema: "{}")
        fake(CLITest.printLines([CLITest.json(["type": "result", "is_error": true, "result": "Credit balance too low"])]))
        let id = c.sessionID
        XCTAssertEqual(message(run(c).result), "Credit balance too low")
        XCTAssertNotEqual(c.sessionID, id, "a failed first call starts a fresh session")

        fake(CLITest.printLines([CLITest.json(["type": "result", "is_error": true, "subtype": "error_max_turns"])]))
        XCTAssertEqual(message(run(c).result), "error_max_turns")

        fake(CLITest.printLines([CLITest.json(["type": "result", "is_error": true])]))
        XCTAssertEqual(message(run(c).result), "error")

        fake("echo 'not logged in' >&2\nsleep 0.3\nexit 2")
        XCTAssertEqual(message(run(c).result), "not logged in\n")

        fake("exit 7")
        XCTAssertEqual(message(run(c).result), "claude exited with status 7")
    }

    func testFailureAfterASuccessKeepsTheSession() {
        let c = Claude(persistent: true, systemPrompt: "s", schema: "{}")
        fake(CLITest.printLines([CLITest.json(["type": "result", "structured_output": ["title": "ok"]])]))
        _ = run(c)
        let id = c.sessionID
        fake("exit 1")
        XCTAssertNotNil(message(run(c).result))
        XCTAssertEqual(c.sessionID, id)
    }

    func testOutputLeftInThePipeAfterExitIsRead() {
        // The script exits at once; a background child writes the result afterwards, so it is
        // read by the termination handler rather than the readability handler.
        let line = CLITest.json(["type": "result", "structured_output": ["title": "late"]])
        fake("(sleep 0.4; printf '%s\\n%s' 'garbage' '\(line)') &\nexit 0")
        let c = Claude(persistent: false, systemPrompt: "s", schema: "{}")
        XCTAssertEqual(try run(c).result.get()["title"] as? String, "late")
    }

    func testWatchdogEndsALongCall() {
        fake("exec sleep 20")
        let c = Claude(persistent: false, systemPrompt: "s", schema: "{}")
        c.timeout = 0.3
        let start = Date()
        let r = run(c)
        XCTAssertTrue(message(r.result)?.hasPrefix("claude exited with status") ?? false)
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
    }

    func testCancelEndsTheRunningCall() {
        fake("exec sleep 20")
        let c = Claude(persistent: true, systemPrompt: "s", schema: "{}")
        let id = c.sessionID
        var results: [Swift.Result<[String: Any], Error>] = []
        c.next(prompt: "p", progress: { _ in }, done: { results.append($0) })
        spin(0.2)
        c.cancel()
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(message(results[0]), "cancelled")
        XCTAssertNotEqual(c.sessionID, id)
        spin(0.5)
        XCTAssertEqual(results.count, 1, "the terminated process reports nothing more")
        c.cancel()
        XCTAssertEqual(results.count, 1)
    }

    func testANewerRequestSupersedesTheOlder() {
        fake("sleep 0.3\n" + CLITest.printLines([CLITest.json(["type": "result", "structured_output": ["title": "new"]])]))
        let c = Claude(persistent: false, systemPrompt: "s", schema: "{}")
        var first: [Swift.Result<[String: Any], Error>] = []
        c.next(prompt: "a", progress: { _ in }, done: { first.append($0) })
        let r = run(c, "b")
        XCTAssertEqual(try r.result.get()["title"] as? String, "new")
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(message(first[0]), "cancelled")
    }

    func testLaunchFailureIsReported() {
        CLITest.brokenTool("claude")
        let c = Claude(persistent: false, systemPrompt: "s", schema: "{}")
        var results: [Swift.Result<[String: Any], Error>] = []
        c.next(prompt: "p", progress: { _ in }, done: { results.append($0) })
        XCTAssertEqual(results.count, 1)
        if case .success = results[0] { XCTFail("expected a launch error") }
        c.cancel()
        XCTAssertEqual(results.count, 1, "no pending request after a launch failure")
    }

    func testDescribe() {
        XCTAssertEqual(Claude.describe(tool: "Bash", input: ["description": "List\nfiles", "command": "ls"]), "Bash · List files")
        XCTAssertEqual(Claude.describe(tool: "Bash", input: ["command": "ls"]), "Bash · ls")
        XCTAssertEqual(Claude.describe(tool: "Read", input: ["file_path": "/a"]), "Read · /a")
        XCTAssertEqual(Claude.describe(tool: "Grep", input: ["pattern": "x+"]), "Grep · x+")
        XCTAssertEqual(Claude.describe(tool: "WebSearch", input: ["query": "q"]), "WebSearch · q")
        XCTAssertEqual(Claude.describe(tool: "WebFetch", input: ["url": "https://a.test"]), "WebFetch · https://a.test")
        XCTAssertEqual(Claude.describe(tool: "Todo", input: [:]), "Todo")
        XCTAssertEqual(Claude.describe(tool: "Bash", input: ["command": String(repeating: "a", count: 200)]).count, "Bash · ".count + 110)
    }

    func testErrHelper() {
        let e = Claude(persistent: false, systemPrompt: "", schema: "").err("boom")
        XCTAssertEqual(e.domain, "aiui")
        XCTAssertEqual(e.localizedDescription, "boom")
    }
}
