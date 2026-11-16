import Foundation
import XCTest
@testable import OSInstallerCore

func uninstallPlan() -> Plan {
    let mac = FakeMac.standard(installed: true)
    return try! UninstallPlanner.plan(layout: mac.layout, marker: FakeMac.marker(for: mac))
}

final class SafetyGuardTests: XCTestCase {
    func guarded(_ argv: [String]) -> String? {
        var plan = uninstallPlan()
        plan.steps = [.command(argv, "test"), .user("not checked")]
        return SafetyGuard.check(plan)
    }

    func testAllowlist() {
        XCTAssertNil(guarded(["bless", "--mount", "/", "--setBoot"]))
        XCTAssertNil(guarded(["diskutil", "apfs", "deleteContainer", "disk0s4"]))
        XCTAssertNil(guarded(["diskutil", "eraseVolume", "free", "free", "disk0s7"]))
        XCTAssertNil(guarded(["diskutil", "apfs", "resizeContainer", "disk0s2", "0"]))
        let refused: [[String]] = [
            ["diskutil", "apfs", "deleteContainer", "disk0s1"],
            ["diskutil", "apfs", "deleteContainer", "disk0s2"],
            ["diskutil", "apfs", "deleteContainer", "disk0s3"],
            ["diskutil", "eraseVolume", "free", "free", "disk0"],
            ["diskutil", "eraseVolume", "free", "free", "disk3s1"],
            ["diskutil", "eraseVolume", "free", "free", "disk0s5; rm"],
            ["diskutil", "eraseVolume", "APFS", "x", "disk0s5"],
            ["diskutil", "apfs", "resizeContainer", "disk0s2", "100g"],
            ["diskutil", "apfs", "resizeContainer", "disk0s4", "0"],
            ["diskutil", "apfs", "addVolume", "disk3", "APFS", "x"],
            ["diskutil", "eraseDisk", "APFS", "x", "disk0"],
            ["bless", "--mount", "/Volumes/X", "--setBoot"],
            ["nvram", "boot-args=x"],
            ["dd", "if=/dev/zero", "of=/dev/rdisk0"],
            ["rm"],
        ]
        for argv in refused {
            XCTAssertNotNil(guarded(argv), argv.joined(separator: " "))
        }
    }

    func testStepRendering() {
        XCTAssertEqual(Step.quote("it's"), #"'it'\''s'"#)
        XCTAssertEqual(Step.quote(""), "''")
        XCTAssertEqual(Step.user("x").json["argv"] as? [String], nil)
        XCTAssertEqual(Step.command(["a"], "n").json["shell"] as? String, "a")
    }

    func testHashCoversEveryStep() {
        let plan = uninstallPlan()
        XCTAssertEqual(plan.hash.count, 64)
        var changed = plan
        changed.steps[1].argv[3] = "disk0s8"
        XCTAssertNotEqual(changed.hash, plan.hash)
        changed = plan
        changed.kind = .install
        XCTAssertNotEqual(changed.hash, plan.hash)
    }
}

final class ExecutorTests: XCTestCase {
    func confirm(_ plan: Plan) -> Confirmation { Confirmation(iUnderstandThisRepartitions: true, planHash: plan.hash) }

    func refusal(_ plan: Plan, _ c: Confirmation, runner: RecordingRunner) -> String {
        do { _ = try RealExecutor(runner: runner).execute(plan, confirmation: c); return "ran" } catch { return "\(error)" }
    }

    func testRefusesWithoutFlagHashOrGuard() {
        let plan = uninstallPlan()
        let runner = RecordingRunner()
        XCTAssertEqual(refusal(plan, Confirmation(iUnderstandThisRepartitions: false, planHash: plan.hash), runner: runner),
                       "not executed: --i-understand-this-repartitions was not given")
        XCTAssertTrue(refusal(plan, Confirmation(iUnderstandThisRepartitions: true, planHash: nil), runner: runner).contains("does not match"))
        XCTAssertTrue(refusal(plan, Confirmation(iUnderstandThisRepartitions: true, planHash: "abc"), runner: runner).contains("does not match"))
        var install = plan
        install.kind = .install
        XCTAssertTrue(refusal(install, confirm(install), runner: runner).contains("only uninstall plans"))
        XCTAssertTrue(runner.calls.isEmpty, "nothing ran")
        _ = RealExecutor() // default runner, never used here
    }

    /// With a recording runner (never the real tools): commands run in order by absolute path.
    func testRunsConfirmedPlanThroughTheRunner() throws {
        let plan = uninstallPlan()
        let runner = RecordingRunner()
        let outcomes = try RealExecutor(runner: runner).execute(plan, confirmation: confirm(plan))
        XCTAssertEqual(outcomes.count, 6)
        XCTAssertEqual(outcomes[0].output, "ok")
        XCTAssertEqual(runner.calls.first, ["/usr/sbin/bless", "--mount", "/", "--setBoot"])
        XCTAssertEqual(runner.calls.last, ["/usr/sbin/diskutil", "apfs", "resizeContainer", "disk0s2", "0"])
    }

    func testStopsAtTheFirstFailure() {
        let plan = uninstallPlan()
        let runner = RecordingRunner()
        runner.results["/usr/sbin/diskutil eraseVolume free free disk0s6"] = RunResult(status: 1, stdout: Data(), stderr: Data("busy".utf8))
        XCTAssertThrowsError(try RealExecutor(runner: runner).execute(plan, confirmation: confirm(plan))) {
            guard case .failed(let o, let done, let hint) = $0 as! ExecutorError else { return XCTFail() }
            XCTAssertEqual(o.output, "busy")
            XCTAssertEqual(done.count, 3)
            XCTAssertEqual(hint, "nothing after this step ran")
            XCTAssertTrue("\($0)".hasPrefix("diskutil eraseVolume free free disk0s6 failed (1): busy."))
        }
        XCTAssertEqual(runner.calls.count, 4)
    }

    func testResizeFailureExplainsTheRepair() {
        var plan = uninstallPlan()
        let runner = RecordingRunner()
        runner.results["/usr/sbin/diskutil apfs resizeContainer disk0s2 0"] = RunResult(status: 1, stdout: Data("Storage system verify or repair failed".utf8), stderr: Data())
        XCTAssertThrowsError(try RealExecutor(runner: runner).execute(plan, confirmation: confirm(plan))) {
            guard case .failed(_, _, let hint) = $0 as! ExecutorError else { return XCTFail() }
            XCTAssertTrue(hint.contains("diskutil repairVolume disk0s2"))
        }
        plan.details = [:]
        XCTAssertThrowsError(try RealExecutor(runner: runner).execute(plan, confirmation: confirm(plan))) {
            guard case .failed(_, _, let hint) = $0 as! ExecutorError else { return XCTFail() }
            XCTAssertEqual(hint, "")
        }
    }
}

final class CLITests: XCTestCase {
    let installed = FakeMac.standard(installed: true)
    var markerFiles: [String: Data] { ["/Volumes/AIUI-EFI/asahi/aiui-install.json": FakeMac.marker(for: installed).encoded()] }

    func testUsage() {
        for args in [[], ["--json"], ["format-disk"], ["preflight", "--bogus"], ["preflight", "--size"]] {
            let r = runCLI(args)
            XCTAssertEqual(r.status, 2, "\(args)")
            XCTAssertTrue(r.err[0].hasPrefix("usage: aiui-os"))
        }
        XCTAssertEqual(runCLI(["preflight", "--size", "0.5"]).status, 2)
        XCTAssertEqual(runCLI(["preflight", "--size", "0"]).err, ["--size: a size in GB, such as 25"])
    }

    func testPreflightOnRecordedFixtures() {
        let r = runCLI(["preflight", "--fixtures", thisMac.path])
        XCTAssertEqual(r.status, 1)
        XCTAssertTrue(r.out.contains("✓ model: MacBook Air (M1, 2020), j313ap: supported"), "\(r.out)")
        XCTAssertTrue(r.out.contains { $0.hasPrefix("✗ space: free 37.7 GB in macOS first") })
        XCTAssertTrue(r.out.contains { $0.hasPrefix("    · macOS 27") })
        XCTAssertEqual(r.out.last, "Not ready yet: fix the ✗ items above.")
        let json = runCLI(["preflight", "--json", "--fixtures", thisMac.path])
        XCTAssertEqual(json.json.count, 1)
        XCTAssertEqual(json.json[0]["ready"] as? Bool, false)
    }

    func testPreflightReady() {
        let r = runCLI(["preflight"])
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(r.out.last, "This Mac is ready for AI UI OS.")
        XCTAssertTrue(r.out.contains { $0.hasPrefix("! ") } == false)
        XCTAssertTrue(runCLI(["preflight"], probe: installed.probe).out.contains { $0.hasPrefix("! existing") })
        XCTAssertEqual(runCLI(["preflight", "--json", "--size", "30"]).json[0]["ready"] as? Bool, true)
    }

    func testPlanInstallJSONLines() {
        let r = runCLI(["plan-install", "--json", "--dry-run", "--package", "/p"])
        XCTAssertEqual(r.status, 0)
        let events = r.json.map { $0["event"] as! String }
        XCTAssertEqual(events.first, "start")
        XCTAssertEqual(events.filter { $0 == "check" }.count, 7)
        XCTAssertEqual(events.suffix(2), ["plan", "done"])
        XCTAssertTrue(r.json.contains { ($0["shell"] as? String)?.hasPrefix("dd if=/p/root.img") == true })
        XCTAssertEqual(r.json.last?["ready"] as? Bool, true)
        let plan = r.json.first { $0["event"] as? String == "plan" }!
        XCTAssertEqual((plan["hash"] as! String).count, 64)
    }

    func testPlanInstallHuman() {
        var notReady = FakeMac.standard()
        notReady.text["pmset-batt.txt"] = "Now drawing from 'Battery Power'"
        let r = runCLI(["plan-install"], probe: notReady.probe)
        XCTAssertEqual(r.status, 0)
        XCTAssertTrue(r.out.contains { $0.hasPrefix("1. $ diskutil apfs resizeContainer disk0s2 ") })
        XCTAssertTrue(r.out.contains { $0.contains("[installer]") })
        XCTAssertTrue(r.out.contains { $0.contains("[you]") })
        XCTAssertTrue(r.out.contains { $0.hasPrefix("plan hash: ") })
        XCTAssertEqual(r.out.last, "Dry run: nothing was changed. Not ready to install yet: fix the ✗ items above.")
        XCTAssertEqual(runCLI(["plan-install"]).out.last, "Dry run: nothing was changed.")
    }

    func testPlanInstallFailures() {
        let thisMacRun = runCLI(["plan-install", "--json", "--fixtures", thisMac.path])
        XCTAssertEqual(thisMacRun.status, 1)
        XCTAssertEqual(thisMacRun.json.suffix(2).map { $0["event"] as! String }, ["error", "done"])
        XCTAssertEqual(thisMacRun.json.suffix(2).first?["message"] as? String, "not enough space: free 37.7 GB in macOS first")
        XCTAssertTrue(runCLI(["plan-install", "--execute"]).err[0].hasPrefix("plan-install never runs"))
        XCTAssertEqual(runCLI(["plan-install", "--manifest", "/none"]).err, ["cannot read /none"])
        XCTAssertTrue(runCLI(["plan-install", "--manifest", "/m"], files: ["/m": Data("{}".utf8)]).err[0].hasPrefix("package manifest"))
        let noDisk = DictProbe(files: FakeMac.standard().files.filter { $0.key != "diskutil-list.plist" })
        XCTAssertEqual(runCLI(["plan-install"], probe: noDisk).err, ["cannot plan without the disk layout"])
    }

    func testPlanInstallWithManifest() throws {
        let manifest = try Data(contentsOf: fixturesRoot.deletingLastPathComponent().appendingPathComponent("manifests/aiui-os.example.json"))
        let r = runCLI(["plan-install", "--manifest", "/m", "--size", "30"], files: ["/m": manifest])
        XCTAssertEqual(r.status, 0)
    }

    func testPlanUninstallDryRunByDefault() {
        let executor = RecordingExecutor()
        let r = runCLI(["plan-uninstall"], probe: installed.probe, executor: executor, files: markerFiles)
        XCTAssertEqual(r.status, 0)
        XCTAssertTrue(r.out.contains("2. $ diskutil apfs deleteContainer disk0s4\n     delete the AI UI OS stub container (Stub - AI UI OS)"), "\(r.out)")
        XCTAssertTrue(r.out.last!.hasPrefix("Dry run: nothing was changed. To run it: aiui-os plan-uninstall --execute --plan-hash "))
        XCTAssertTrue(executor.executed.isEmpty)
        let json = runCLI(["plan-uninstall", "--json"], probe: installed.probe, executor: executor, files: markerFiles)
        XCTAssertEqual(json.json.first?["dryRun"] as? Bool, true)
        XCTAssertEqual(json.json.last?["dryRun"] as? Bool, true)
        XCTAssertTrue(executor.executed.isEmpty)
    }

    func testPlanUninstallRefusals() {
        XCTAssertEqual(runCLI(["plan-uninstall"]).err, ["refused: no AI UI OS install marker found"])
        XCTAssertTrue(runCLI(["plan-uninstall", "--fixtures", thisMac.path]).err[0].hasPrefix("refused: no AI UI OS install marker"))
        let noDisk = DictProbe(files: [:])
        XCTAssertEqual(runCLI(["plan-uninstall", "--json"], probe: noDisk).json[1]["message"] as? String,
                       "could not read the disk layout (diskutil list failed)")
        var foreign = installed
        foreign.partitions[5].name = "Root - Fedora"
        XCTAssertEqual(runCLI(["plan-uninstall"], probe: foreign.probe, files: markerFiles).status, 1)
    }

    func testExecuteGoesThroughTheExecutorWithTheConfirmation() {
        let executor = RecordingExecutor()
        let hash = uninstallPlan().hash
        let args = ["plan-uninstall", "--execute", "--plan-hash", hash, "--i-understand-this-repartitions"]
        let r = runCLI(args, probe: installed.probe, executor: executor, files: markerFiles)
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(executor.executed.count, 1)
        XCTAssertEqual(executor.executed[0].1, Confirmation(iUnderstandThisRepartitions: true, planHash: hash))
        XCTAssertTrue(r.out.contains("ran: diskutil apfs resizeContainer disk0s2 0"))
        XCTAssertEqual(r.out.last, "AI UI OS was removed.")
        let json = runCLI(args + ["--json"], probe: installed.probe, executor: executor, files: markerFiles)
        XCTAssertEqual(json.json.filter { $0["event"] as? String == "ran" }.count, 6)
        XCTAssertEqual(json.json.last?["dryRun"] as? Bool, false)
    }

    func testExecuteRefusalIsReported() {
        // The real executor, with a runner that records: without the flag nothing runs.
        let runner = RecordingRunner()
        let r = runCLI(["plan-uninstall", "--execute", "--plan-hash", uninstallPlan().hash],
                       probe: installed.probe, executor: RealExecutor(runner: runner), files: markerFiles)
        XCTAssertEqual(r.status, 1)
        XCTAssertEqual(r.err, ["not executed: --i-understand-this-repartitions was not given"])
        XCTAssertTrue(runner.calls.isEmpty)
        let failing = RecordingExecutor()
        failing.error = ExecutorError.refused("x")
        XCTAssertEqual(runCLI(["plan-uninstall", "--execute"], probe: installed.probe, executor: failing, files: markerFiles).err,
                       ["not executed: x"])
    }

    func testFixtureDirectoryOfASyntheticInstall() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try installed.write(to: dir)
        let marker = dir.appendingPathComponent("aiui-install.json")
        try FakeMac.marker(for: installed).encoded().write(to: marker)
        var out: [String] = []
        var cli = CLI.live()
        cli.out = { out.append($0) }
        XCTAssertEqual(cli.run(["plan-uninstall", "--fixtures", dir.path, "--marker", marker.path]), 0)
        XCTAssertTrue(out.contains("6. $ diskutil apfs resizeContainer disk0s2 0\n     grow macOS back over the freed space"))
    }

    func testLiveWiring() {
        let cli = CLI.live()
        XCTAssertTrue(cli.probe is SystemProbe)
        XCTAssertTrue(cli.executor is RealExecutor)
        XCTAssertNil(cli.readFile("/nonexistent/aiui"))
        XCTAssertLessThan(abs(cli.now().timeIntervalSinceNow), 5)
        cli.out("aiui-os test output")
        cli.err("aiui-os test error output")
    }
}
