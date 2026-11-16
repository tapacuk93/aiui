import Foundation

/// The only things this tool ever asks the system. Each case is a fixed, read-only command:
/// a probe cannot run anything else, so reading the machine can never change it.
public enum Query: Equatable {
    case diskList
    case apfsList
    case diskInfo(String)
    case hwModel
    case platform
    case swVers
    case fileVault
    case battery
    case latestBackup

    /// The command line, with absolute paths. `nil` for a malformed disk identifier.
    public var argv: [String]? {
        switch self {
        case .diskList: return ["/usr/sbin/diskutil", "list", "-plist"]
        case .apfsList: return ["/usr/sbin/diskutil", "apfs", "list", "-plist"]
        case .diskInfo(let id): return Query.isDiskIdentifier(id) ? ["/usr/sbin/diskutil", "info", "-plist", id] : nil
        case .hwModel: return ["/usr/sbin/sysctl", "-n", "hw.model"]
        case .platform: return ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]
        case .swVers: return ["/usr/bin/sw_vers"]
        case .fileVault: return ["/usr/bin/fdesetup", "status"]
        case .battery: return ["/usr/bin/pmset", "-g", "batt"]
        case .latestBackup: return ["/usr/bin/tmutil", "latestbackup"]
        }
    }

    /// File name of the recorded output in a fixture directory (`Fixtures/`).
    public var fixtureName: String? {
        switch self {
        case .diskList: return "diskutil-list.plist"
        case .apfsList: return "diskutil-apfs-list.plist"
        case .diskInfo(let id): return Query.isDiskIdentifier(id) ? "diskutil-info-\(id).plist" : nil
        case .hwModel: return "sysctl-hw.model.txt"
        case .platform: return "ioreg-platform.txt"
        case .swVers: return "sw_vers.txt"
        case .fileVault: return "fdesetup-status.txt"
        case .battery: return "pmset-batt.txt"
        case .latestBackup: return "tmutil-latestbackup.txt"
        }
    }

    /// `disk0`, `disk0s2`, `disk12s3`: nothing else reaches a command line.
    public static func isDiskIdentifier(_ s: String) -> Bool {
        s.range(of: #"^disk[0-9]+(s[0-9]+)?$"#, options: .regularExpression) != nil
    }
}

/// Answers queries: the live system or recorded output. `nil` means the command failed.
public protocol Probe {
    func run(_ query: Query) -> Data?
}

public struct RunResult: Equatable {
    public var status: Int32
    public var stdout: Data
    public var stderr: Data
    public init(status: Int32, stdout: Data, stderr: Data) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// Runs a program and collects its output.
public protocol CommandRunner {
    func run(_ argv: [String]) -> RunResult
}

public struct ProcessRunner: CommandRunner {
    public init() {}
    public func run(_ argv: [String]) -> RunResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: argv[0])
        process.arguments = Array(argv.dropFirst())
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch {
            return RunResult(status: -1, stdout: Data(), stderr: Data("\(error)".utf8))
        }
        let stdout = out.fileHandleForReading.readDataToEndOfFile()
        let stderr = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return RunResult(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}

/// The live machine, through the fixed read-only queries only.
public struct SystemProbe: Probe {
    let runner: CommandRunner
    public init(runner: CommandRunner = ProcessRunner()) { self.runner = runner }
    public func run(_ query: Query) -> Data? {
        guard let argv = query.argv else { return nil }
        let result = runner.run(argv)
        return result.status == 0 ? result.stdout : nil
    }
}

/// Recorded output in a directory (one file per query, named by `Query.fixtureName`).
/// A missing file stands for a failed command.
public struct FixtureProbe: Probe {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    public func run(_ query: Query) -> Data? {
        guard let name = query.fixtureName else { return nil }
        return try? Data(contentsOf: directory.appendingPathComponent(name))
    }
}

extension Probe {
    func text(_ query: Query) -> String? {
        run(query).map { String(decoding: $0, as: UTF8.self) }
    }
}
