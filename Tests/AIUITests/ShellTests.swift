import XCTest
@testable import AIUI

final class ShellTests: AIUITestCase {
    func testWhichFindsExecutablesOnThePath() {
        TestEnv.fakeTool("aiui-which-probe", "exit 0")
        defer { TestEnv.removeFake("aiui-which-probe") }
        XCTAssertEqual(Shell.which("aiui-which-probe"), TestEnv.fakeBin.appendingPathComponent("aiui-which-probe").path)
        XCTAssertEqual(Shell.which("ls"), "/bin/ls")
        XCTAssertNil(Shell.which("aiui-no-such-tool-\(UUID().uuidString)"))
    }

    func testRunSyncPassesStdinCwdAndCollectsOutput() {
        let dir = TestEnv.tempDir("cwd")
        let r = Shell.runSync("/bin/sh", ["-c", "cat; pwd; echo oops >&2; exit 3"], stdin: "hello\n", cwd: dir.path)
        XCTAssertEqual(r.code, 3)
        XCTAssertTrue(r.stdout.hasPrefix("hello\n"))
        XCTAssertTrue(r.stdout.contains(dir.lastPathComponent))
        XCTAssertEqual(r.stderr, "oops\n")
    }

    func testRunSyncDefaultsToHomeAndNotesMediaOfShellCommands() {
        let r = Shell.runSync("/bin/zsh", ["-fc", "pwd # tell application \"Spotify\" to play"])
        XCTAssertEqual(r.code, 0)
        XCTAssertEqual(r.stdout.trimmingCharacters(in: .whitespacesAndNewlines), NSHomeDirectory())
    }

    func testRunSyncReportsALaunchFailure() {
        let r = Shell.runSync("/nonexistent/aiui-tool", [])
        XCTAssertEqual(r.code, -1)
        XCTAssertEqual(r.stdout, "")
        XCTAssertFalse(r.stderr.isEmpty)
    }

    func testRunCompletesOnTheMainThread() {
        var got: Shell.Result?
        var onMain = false
        Shell.run("/bin/echo", ["hi"]) { r in got = r; onMain = Thread.isMainThread }
        waitUntil { got != nil }
        XCTAssertEqual(got?.stdout, "hi\n")
        XCTAssertTrue(onMain)
    }

    func testLoginEnvironmentAddsInstallFoldersAndNativeBin() {
        let env = Shell.computeLoginEnvironment()
        let parts = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        XCTAssertTrue(parts.contains("/opt/homebrew/bin"))
        XCTAssertTrue(parts.contains("/usr/local/bin"))
        XCTAssertTrue(parts.contains("\(NSHomeDirectory())/.local/bin"))
        XCTAssertEqual(parts.last, NativeLibraries.binDir.path)
        XCTAssertEqual(env["AIUI_NATIVE_BIN"], NativeLibraries.binDir.path)
        // Each folder appears once.
        XCTAssertEqual(parts.filter { $0 == "/usr/local/bin" }.count, 1)
    }

    func testDefaultQuitHooksRunAndSignalForReal() {
        // The real runner and signal, used only on harmless targets: echo, and our own child.
        XCTAssertEqual(Shell.quitRun("/bin/echo", ["x"]).stdout, "x\n")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["30"]
        XCTAssertNoThrow(try p.run())
        Shell.signal(p.processIdentifier, SIGTERM)
        p.waitUntilExit()
        XCTAssertEqual(p.terminationReason, .uncaughtSignal)
        XCTAssertEqual(p.terminationStatus, SIGTERM)
    }

    func testStopEverythingStopsPlayersMediaAndGroups() {
        let savedRun = Shell.quitRun, savedSignal = Shell.signal, savedGrace = Shell.killGrace
        defer { Shell.quitRun = savedRun; Shell.signal = savedSignal; Shell.killGrace = savedGrace }
        _ = Shell.launched
        Thread.sleep(forTimeInterval: 0.01)

        // A finished child is adopted: its group is signalled (it no longer exists, so nothing is hit).
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        XCTAssertNoThrow(try p.run())
        Shell.adopt(p)
        p.waitUntilExit()
        // A process that never ran has no pid and is not adopted.
        Shell.adopt(Process())

        Shell.noteMedia(in: "osascript -e 'tell application \"Music\" to play'")
        Shell.noteMedia(in: "tell application \"Music\" to open location \"x\"")
        Shell.noteMedia(in: "tell application \"Spotify\" to play")
        Shell.noteMedia(in: "tell application \"TV\" to play")
        Shell.noteMedia(in: "tell application \"QuickTime Player\" to play")
        Shell.noteMedia(in: "ls -la")

        var runs: [(String, [String])] = []
        var signals: [(pid_t, Int32)] = []
        Shell.killGrace = 0
        Shell.signal = { signals.append(($0, $1)) }
        Shell.quitRun = { exe, args in
            runs.append((exe, args))
            if exe == "/bin/ps" {
                return Shell.Result(code: 0, stdout: """
                  101 00:00 /usr/bin/afplay
                  102 10-01:00:00 /usr/bin/say
                  103 01:02:03 /opt/homebrew/bin/mpv
                  104 00:00 /Applications/Safari.app/Contents/MacOS/Safari
                  bad 00:00 ffplay
                  105 00:00
                  106 00:00 /usr/local/bin/ffmpeg
                """, stderr: "")
            }
            return Shell.Result(code: 0, stdout: "", stderr: "")
        }
        Shell.stopEverything()

        XCTAssertEqual(runs.first?.0, "/bin/ps")
        let paused = runs.filter { $0.0 == "/usr/bin/osascript" }.map { $0.1[1] }
        for app in ["Music", "Spotify", "TV", "QuickTime Player"] {
            XCTAssertTrue(paused.contains("if application \"\(app)\" is running then tell application \"\(app)\" to pause"), app)
        }
        let players = signals.filter { $0.0 > 0 }
        XCTAssertEqual(players.map(\.0).sorted(), [101, 106])
        XCTAssertTrue(players.allSatisfy { $0.1 == SIGTERM })
        let pid = p.processIdentifier
        XCTAssertTrue(signals.contains { $0.0 == -pid && $0.1 == SIGTERM })
        XCTAssertTrue(signals.contains { $0.0 == -pid && $0.1 == SIGKILL })
        XCTAssertFalse(signals.contains { $0.0 == 0 })
    }
}
