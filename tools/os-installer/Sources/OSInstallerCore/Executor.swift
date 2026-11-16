import Foundation

/// What the person confirmed: the explicit flag and the hash of the plan they saw.
public struct Confirmation: Equatable {
    public var iUnderstandThisRepartitions: Bool
    public var planHash: String?
    public init(iUnderstandThisRepartitions: Bool, planHash: String?) {
        self.iUnderstandThisRepartitions = iUnderstandThisRepartitions
        self.planHash = planHash
    }
}

public struct StepOutcome: Equatable {
    public var step: Step
    public var status: Int32
    public var output: String
}

public enum ExecutorError: Error, Equatable, CustomStringConvertible {
    case refused(String)
    case failed(StepOutcome, done: [StepOutcome], hint: String)

    public var description: String {
        switch self {
        case .refused(let why): return "not executed: \(why)"
        case .failed(let o, _, let hint): return "\(o.step.shell) failed (\(o.status)): \(o.output). \(hint)"
        }
    }
}

/// The single path by which a plan may change the disk.
public protocol Executor {
    func execute(_ plan: Plan, confirmation: Confirmation) throws -> [StepOutcome]
}

/// Runs an uninstall plan's commands, and only when the flag is given, the confirmed hash matches the
/// plan and every command passes `SafetyGuard`. Commands run by absolute path, one at a time,
/// stopping at the first failure.
public struct RealExecutor: Executor {
    public static let tools = ["diskutil": "/usr/sbin/diskutil", "bless": "/usr/sbin/bless"]
    let runner: CommandRunner
    public init(runner: CommandRunner = ProcessRunner()) { self.runner = runner }

    public func execute(_ plan: Plan, confirmation: Confirmation) throws -> [StepOutcome] {
        guard confirmation.iUnderstandThisRepartitions else {
            throw ExecutorError.refused("--i-understand-this-repartitions was not given")
        }
        guard let hash = confirmation.planHash, hash == plan.hash else {
            throw ExecutorError.refused("the confirmed plan hash does not match this plan (\(plan.hash)); the disk may have changed: review the plan again")
        }
        if let why = SafetyGuard.check(plan) { throw ExecutorError.refused(why) }
        var done: [StepOutcome] = []
        for step in plan.commands {
            let argv = [RealExecutor.tools[step.argv[0]]!] + step.argv.dropFirst()
            let result = runner.run(argv)
            let output = String(decoding: result.stdout + result.stderr, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let outcome = StepOutcome(step: step, status: result.status, output: output)
            guard result.status == 0 else {
                let hint = step.argv.contains("resizeContainer")
                    ? (plan.details["ifResizeFails"] as? String ?? "")
                    : "nothing after this step ran"
                throw ExecutorError.failed(outcome, done: done, hint: hint)
            }
            done.append(outcome)
        }
        return done
    }
}
