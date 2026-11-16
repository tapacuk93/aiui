import Foundation

/// `aiui-os preflight | plan-install | plan-uninstall` (README.md). Returns the exit status:
/// 0 success, 1 not ready / refused / failed, 2 usage error.
public struct CLI {
    public var probe: Probe
    public var executor: Executor
    public var now: () -> Date
    public var timeZone: TimeZone
    public var readFile: (String) -> Data?
    public var out: (String) -> Void
    public var err: (String) -> Void

    public init(probe: Probe, executor: Executor, now: @escaping () -> Date, timeZone: TimeZone,
                readFile: @escaping (String) -> Data?, out: @escaping (String) -> Void, err: @escaping (String) -> Void) {
        self.probe = probe
        self.executor = executor
        self.now = now
        self.timeZone = timeZone
        self.readFile = readFile
        self.out = out
        self.err = err
    }

    /// The real machine: read-only probes; the real executor (which refuses without confirmation).
    public static func live() -> CLI {
        CLI(probe: SystemProbe(), executor: RealExecutor(), now: Date.init, timeZone: .current,
            readFile: { FileManager.default.contents(atPath: $0) },
            out: { print($0) }, err: { FileHandle.standardError.write(Data(($0 + "\n").utf8)) })
    }

    public static let usage = """
    usage: aiui-os <command> [options]
      preflight         can this Mac run AI UI OS? (read-only)
      plan-install      the install plan and the exact commands, as a dry run (nothing is changed)
      plan-uninstall    the uninstall plan (dry run by default)
    options:
      --json                     machine-readable output (preflight: one document; plans: JSON lines)
      --fixtures DIR             read recorded diskutil/system output from DIR instead of this Mac
      --size GB                  AI UI OS size (default 25)
      --manifest FILE            installer_data.json or one os_list entry (default: built-in)
      --package DIR              where the unpacked package is (shown in dd commands)
      --marker FILE              aiui-install.json to use (default: from the mounted AI UI OS EFI partition)
      --execute --plan-hash H --i-understand-this-repartitions
                                 plan-uninstall only: really run the plan whose hash is H
    """

    struct Options {
        var command: String
        var flags: Set<String> = []
        var values: [String: String] = [:]
    }

    static let valueOptions: Set<String> = ["--fixtures", "--size", "--manifest", "--package", "--marker", "--plan-hash"]
    static let flagOptions: Set<String> = ["--json", "--dry-run", "--execute", "--i-understand-this-repartitions"]

    static func parse(_ args: [String]) -> Options? {
        guard let command = args.first, !command.hasPrefix("-") else { return nil }
        var o = Options(command: command)
        var i = 1
        while i < args.count {
            let a = args[i]
            if flagOptions.contains(a) {
                o.flags.insert(a)
            } else if valueOptions.contains(a), i + 1 < args.count {
                o.values[a] = args[i + 1]
                i += 1
            } else {
                return nil
            }
            i += 1
        }
        return o
    }

    public func run(_ args: [String]) -> Int32 {
        guard let o = CLI.parse(args), ["preflight", "plan-install", "plan-uninstall"].contains(o.command) else {
            err(CLI.usage)
            return 2
        }
        var cli = self
        if let dir = o.values["--fixtures"] { cli.probe = FixtureProbe(directory: URL(fileURLWithPath: dir)) }
        var target = Size.target
        if let s = o.values["--size"] {
            guard let n = Size.parse(s), n >= Size.gb else {
                err("--size: a size in GB, such as 25")
                return 2
            }
            target = n
        }
        let json = o.flags.contains("--json")
        switch o.command {
        case "preflight": return cli.preflight(json: json, target: target)
        case "plan-install": return cli.planInstall(o, json: json, target: target)
        default: return cli.planUninstall(o, json: json)
        }
    }

    func emit(_ object: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        out(String(decoding: data, as: UTF8.self))
    }

    /// A JSON-lines event: `fields` plus `"event": name`.
    static func event(_ name: String, _ fields: [String: Any], _ extra: [String: Any] = [:]) -> [String: Any] {
        var e = fields
        for (k, v) in extra { e[k] = v }
        e["event"] = name
        return e
    }

    static let mark: [Status: String] = [.ok: "✓", .warn: "!", .fail: "✗"]

    func printChecks(_ checks: [Check]) {
        for c in checks {
            out("\(CLI.mark[c.status]!) \(c.id): \(c.summary)")
            for n in c.notes { out("    · \(n)") }
        }
    }

    func preflight(json: Bool, target: UInt64) -> Int32 {
        let report = Preflight(probe: probe, now: now(), timeZone: timeZone, target: target).run()
        if json {
            emit(report.json)
        } else {
            printChecks(report.checks)
            out(report.ready ? "This Mac is ready for AI UI OS." : "Not ready yet: fix the ✗ items above.")
        }
        return report.ready ? 0 : 1
    }

    func failure(_ message: String, json: Bool) -> Int32 {
        if json {
            emit(["event": "error", "message": message])
            emit(["event": "done", "ok": false])
        } else {
            err(message)
        }
        return 1
    }

    func printPlan(_ plan: Plan, json: Bool) {
        if json {
            for (i, s) in plan.steps.enumerated() { emit(CLI.event("step", s.json, ["index": i + 1])) }
            emit(["event": "plan", "kind": plan.kind.rawValue, "hash": plan.hash, "details": plan.details])
        } else {
            for (i, s) in plan.steps.enumerated() {
                switch s.kind {
                case .command: out("\(i + 1). $ \(s.shell)\n     \(s.note)")
                case .installer: out("\(i + 1). [installer] \(s.note)")
                case .user: out("\(i + 1). [you] \(s.note)")
                }
            }
            out("plan hash: \(plan.hash)")
        }
    }

    func planInstall(_ o: Options, json: Bool, target: UInt64) -> Int32 {
        if json { emit(["event": "start", "command": "plan-install", "dryRun": true]) }
        if o.flags.contains("--execute") {
            return failure("plan-install never runs: step 1 is done by the AI UI OS installer (run by the Mac app); this tool only plans", json: json)
        }
        var manifest = OSManifest.builtIn
        if let path = o.values["--manifest"] {
            guard let data = readFile(path) else { return failure("cannot read \(path)", json: json) }
            do { manifest = try OSManifest.parse(data) } catch { return failure("\(error)", json: json) }
        }
        let report = Preflight(probe: probe, now: now(), timeZone: timeZone, target: target).run()
        if json {
            for c in report.checks { emit(CLI.event("check", c.json)) }
        } else {
            printChecks(report.checks)
        }
        guard let layout = report.layout else { return failure("cannot plan without the disk layout", json: json) }
        let plan: Plan
        do {
            plan = try InstallPlanner.plan(layout: layout, manifest: manifest, target: target,
                                           packagePath: o.values["--package"] ?? "<package>")
        } catch {
            return failure("\(error)", json: json)
        }
        printPlan(plan, json: json)
        if json {
            emit(["event": "done", "ok": true, "ready": report.ready, "dryRun": true])
        } else {
            out("Dry run: nothing was changed." + (report.ready ? "" : " Not ready to install yet: fix the ✗ items above."))
        }
        return 0
    }

    func planUninstall(_ o: Options, json: Bool) -> Int32 {
        let execute = o.flags.contains("--execute")
        if json { emit(["event": "start", "command": "plan-uninstall", "dryRun": !execute]) }
        let plan: Plan
        do {
            let layout = try DiskLayout.load(from: probe)
            let marker = try UninstallPlanner.findMarker(layout: layout, explicit: o.values["--marker"], read: readFile)
            plan = try UninstallPlanner.plan(layout: layout, marker: marker)
        } catch {
            return failure("\(error)", json: json)
        }
        printPlan(plan, json: json)
        guard execute else {
            if json {
                emit(["event": "done", "ok": true, "dryRun": true])
            } else {
                out("Dry run: nothing was changed. To run it: aiui-os plan-uninstall --execute --plan-hash \(plan.hash) --i-understand-this-repartitions")
            }
            return 0
        }
        let confirmation = Confirmation(iUnderstandThisRepartitions: o.flags.contains("--i-understand-this-repartitions"),
                                        planHash: o.values["--plan-hash"])
        do {
            let outcomes = try executor.execute(plan, confirmation: confirmation)
            for r in outcomes {
                if json { emit(["event": "ran", "shell": r.step.shell, "status": r.status]) } else { out("ran: \(r.step.shell)") }
            }
        } catch {
            return failure("\(error)", json: json)
        }
        if json { emit(["event": "done", "ok": true, "dryRun": false]) } else { out("AI UI OS was removed.") }
        return 0
    }
}
