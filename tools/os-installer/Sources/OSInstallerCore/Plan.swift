import CryptoKit
import Foundation

/// One step of a plan. Only `.command` steps are ever executed (and only through an `Executor`);
/// `.installer` steps are done by our installer fork, `.user` steps by the person at the Mac.
public struct Step: Equatable {
    public enum Kind: String { case command, installer, user }
    public var kind: Kind
    public var argv: [String]
    public var note: String

    public static func command(_ argv: [String], _ note: String) -> Step { Step(kind: .command, argv: argv, note: note) }
    public static func installer(_ note: String) -> Step { Step(kind: .installer, argv: [], note: note) }
    public static func user(_ note: String) -> Step { Step(kind: .user, argv: [], note: note) }

    /// The command as it would be typed in a shell.
    public var shell: String { argv.map(Step.quote).joined(separator: " ") }

    static func quote(_ s: String) -> String {
        if !s.isEmpty, s.range(of: #"^[A-Za-z0-9%@/._:=+,-]+$"#, options: .regularExpression) != nil { return s }
        return "'" + s.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }

    var json: [String: Any] {
        var j: [String: Any] = ["kind": kind.rawValue, "note": note]
        if kind == .command { j["argv"] = argv; j["shell"] = shell }
        return j
    }
}

public struct Plan {
    public enum Kind: String { case install, uninstall }
    public var kind: Kind
    public var steps: [Step]
    /// The macOS container's partition and the partitions no step may ever touch.
    public var macPartition: String
    public var protected: [String]
    /// Extra facts for the output (partition table, marker, sizes).
    public var details: [String: Any] = [:]

    public var commands: [Step] { steps.filter { $0.kind == .command } }

    /// SHA-256 of the kind and the steps: the person confirms exactly this list.
    public var hash: String {
        let body: [String: Any] = ["kind": kind.rawValue, "steps": steps.map(\.json)]
        let data = try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// Last line of defence: every command in an uninstall plan must have one of four exact shapes,
/// and none may name the internal disk, iSC, the macOS container (except to grow it) or Recovery.
public enum SafetyGuard {
    public static let neverTouch: Set<String> = ["disk0", "disk0s1"]

    public static func check(_ plan: Plan) -> String? {
        guard plan.kind == .uninstall else { return "only uninstall plans run from this tool; installs run in the installer" }
        let forbidden = neverTouch.union(plan.protected).union([plan.macPartition])
        for step in plan.commands {
            let a = step.argv
            switch a.count {
            case 4 where a == ["bless", "--mount", "/", "--setBoot"]:
                continue
            case 4 where a[0...2] == ["diskutil", "apfs", "deleteContainer"] && allowed(a[3], forbidden):
                continue
            case 5 where a[0...3] == ["diskutil", "eraseVolume", "free", "free"] && allowed(a[4], forbidden):
                continue
            case 5 where a == ["diskutil", "apfs", "resizeContainer", plan.macPartition, "0"]:
                continue
            default:
                return "refusing a command outside the uninstall allowlist: \(step.shell)"
            }
        }
        return nil
    }

    static func allowed(_ id: String, _ forbidden: Set<String>) -> Bool {
        Query.isDiskIdentifier(id) && id.hasPrefix(DiskLayout.internalDisk + "s") && !forbidden.contains(id)
    }
}
