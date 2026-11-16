import XCTest
@testable import AIUI

final class AgentCLITests: AIUITestCase {
    private var dir: URL!
    private var argsFile: URL { dir.appendingPathComponent("args.txt") }
    private var stdinFile: URL { dir.appendingPathComponent("stdin.txt") }

    override func setUp() {
        super.setUp()
        signal(SIGPIPE, SIG_IGN)
        dir = TestEnv.tempDir("agentcli")
    }

    override func tearDown() {
        TestEnv.removeFake("codex"); TestEnv.removeFake("gemini")
        unsetenv("AIUI_MODEL")
        super.tearDown()
    }

    /// A fake CLI that records its arguments (NUL-free, one per line) and stdin, then runs `body`.
    /// `$OUT` is the value after `-o` (codex's last-message file).
    private func fake(_ name: String, _ body: String) {
        TestEnv.fakeTool(name, """
        printf '%s\\n' "$@" > '\(argsFile.path)'
        OUT=""; prev=""
        for a in "$@"; do [ "$prev" = "-o" ] && OUT="$a"; prev="$a"; done
        cat > '\(stdinFile.path)'
        \(body)
        """)
    }

    private func args() -> String { (try? String(contentsOf: argsFile, encoding: .utf8)) ?? "" }
    private func stdin() -> String { (try? String(contentsOf: stdinFile, encoding: .utf8)) ?? "" }

    private func run(_ c: AgentCLI, _ prompt: String = "hello") -> (result: Swift.Result<[String: Any], Error>, progress: [String]) {
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
        let c = AgentCLI(id: "gemini", label: "Gemini CLI", persistent: false, systemPrompt: "s", schema: "{}")
        XCTAssertEqual(c.label, "Gemini CLI")
        XCTAssertEqual(message(run(c).result), "gemini not found on PATH")
    }

    func testCodexReadsTheLastMessageFileAndKeepsATranscript() {
        fake("codex", """
        echo "working on it"
        sleep 0.2
        printf '%s' '{"title":"Codex screen","note":"noted"}' > "$OUT"
        """)
        let c = AgentCLI(id: "codex", label: "Codex CLI", persistent: true, systemPrompt: "SYSTEM", schema: "{\"s\":1}")
        let r = run(c, "first event")
        XCTAssertEqual(try r.result.get()["title"] as? String, "Codex screen")
        XCTAssertEqual(r.progress.first, "thinking")
        XCTAssertTrue(r.progress.contains("working on it"))
        let a = args()
        XCTAssertTrue(a.hasPrefix("exec\n--skip-git-repo-check\n--dangerously-bypass-approvals-and-sandbox\n--color\nnever\n-o\n"))
        XCTAssertTrue(a.hasSuffix("\n-\n"))
        let s1 = stdin()
        XCTAssertTrue(s1.hasPrefix("SYSTEM\n"))
        XCTAssertTrue(s1.contains("{\"s\":1}"))
        XCTAssertTrue(s1.hasSuffix("first event"))
        XCTAssertFalse(s1.contains("Earlier in this session"))
        // The last-message file is removed.
        let outPath = a.split(separator: "\n").map(String.init)[6]
        XCTAssertFalse(FileManager.default.fileExists(atPath: outPath))

        // The second call carries the transcript of the first.
        _ = run(c, "second event")
        let s2 = stdin()
        XCTAssertTrue(s2.contains("## Earlier in this session\n- event: first event\n  → screen: noted"))

        c.reset()
        _ = run(c, "third")
        XCTAssertFalse(stdin().contains("Earlier in this session"))
    }

    func testCodexReadOnlyWithModelAndTitleInTranscript() {
        setenv("AIUI_MODEL", "o-model", 1)
        fake("codex", "printf '%s' '{\"title\":\"T\"}' > \"$OUT\"")
        let c = AgentCLI(id: "codex", label: "Codex", persistent: true, systemPrompt: "s", schema: "{}")
        c.readOnly = true
        _ = run(c, "e1")
        XCTAssertTrue(args().hasPrefix("-m\no-model\nexec\n--skip-git-repo-check\n--sandbox\nread-only\n"))
        _ = run(c, "e2")
        XCTAssertTrue(stdin().contains("→ screen: T"))
        fake("codex", "printf '%s' '{\"x\":1}' > \"$OUT\"")
        _ = run(c, "e3")
        _ = run(c, "e4")
        XCTAssertTrue(stdin().contains("- event: e3\n  → screen: \n"))
    }

    func testGeminiTakesThePromptAsAnArgumentAndAnswersOnStdout() {
        fake("gemini", "echo 'Sure. {\"title\":\"Gem\"}'")
        let c = AgentCLI(id: "gemini", label: "Gemini", persistent: false, systemPrompt: "SYS", schema: "{}")
        let r = run(c, "evt")
        XCTAssertEqual(try r.result.get()["title"] as? String, "Gem")
        let a = args()
        XCTAssertTrue(a.hasPrefix("--yolo\n-p\nSYS\n"))
        XCTAssertEqual(stdin(), "", "gemini gets no stdin")
        // Non-persistent: no transcript.
        _ = run(c, "evt2")
        XCTAssertFalse(args().contains("Earlier in this session"))

        c.readOnly = true
        _ = run(c)
        XCTAssertTrue(args().hasPrefix("-p\nSYS\n"))
    }

    func testEmptyModelIsIgnored() {
        setenv("AIUI_MODEL", "", 1)
        fake("gemini", "echo '{\"title\":\"G\"}'")
        let c = AgentCLI(id: "gemini", label: "Gemini", persistent: false, systemPrompt: "SYS", schema: "{}")
        _ = run(c)
        XCTAssertTrue(args().hasPrefix("--yolo\n"))
    }

    func testFailuresUseStderrOrTheExitStatus() {
        let c = AgentCLI(id: "gemini", label: "Gemini", persistent: true, systemPrompt: "s", schema: "{}")
        fake("gemini", "echo 'no json here'\necho 'quota exceeded' >&2\nexit 1")
        XCTAssertEqual(message(run(c).result), "quota exceeded\n")
        fake("gemini", "exit 3")
        XCTAssertEqual(message(run(c).result), "gemini exited 3 without a screen")
    }

    func testWatchdogEndsALongCall() {
        fake("gemini", "exec sleep 20")
        let c = AgentCLI(id: "gemini", label: "Gemini", persistent: false, systemPrompt: "s", schema: "{}")
        c.timeout = 0.3
        let start = Date()
        XCTAssertEqual(message(run(c).result), "gemini exited 15 without a screen")
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
    }

    func testCancelAndSupersede() {
        fake("gemini", "exec sleep 20")
        let c = AgentCLI(id: "gemini", label: "Gemini", persistent: false, systemPrompt: "s", schema: "{}")
        var results: [Swift.Result<[String: Any], Error>] = []
        c.next(prompt: "p", progress: { _ in }, done: { results.append($0) })
        spin(0.2)
        c.cancel()
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(message(results[0]), "cancelled")
        spin(0.5)
        XCTAssertEqual(results.count, 1)

        fake("gemini", "sleep 0.2; echo '{\"title\":\"new\"}'")
        var first: [Swift.Result<[String: Any], Error>] = []
        c.next(prompt: "a", progress: { _ in }, done: { first.append($0) })
        XCTAssertEqual(try run(c).result.get()["title"] as? String, "new")
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(message(first[0]), "cancelled")
    }

    func testLaunchFailureIsReported() {
        CLITest.brokenTool("codex")
        let c = AgentCLI(id: "codex", label: "Codex", persistent: false, systemPrompt: "s", schema: "{}")
        var results: [Swift.Result<[String: Any], Error>] = []
        c.next(prompt: "p", progress: { _ in }, done: { results.append($0) })
        XCTAssertEqual(results.count, 1)
        if case .success = results[0] { XCTFail("expected a launch error") }
        c.cancel()
        XCTAssertEqual(results.count, 1)
    }
}
