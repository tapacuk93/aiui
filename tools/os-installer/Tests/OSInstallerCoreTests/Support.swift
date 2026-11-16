import Foundation
import XCTest
@testable import OSInstallerCore

let fixturesRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures")
let thisMac = fixturesRoot.appendingPathComponent("this-mac-2026-11-16")

/// 2026-11-16 12:00 UTC: the day the fixtures were recorded.
let fixtureNow = Date(timeIntervalSince1970: 1_794_830_400)
let utc = TimeZone(identifier: "UTC")!

/// Answers queries from in-memory files named like fixture files.
struct DictProbe: Probe {
    var files: [String: Data]
    func run(_ query: Query) -> Data? { query.fixtureName.flatMap { files[$0] } }
}

/// Records what it was asked to run; answers with a fixed result per program.
final class RecordingRunner: CommandRunner {
    var calls: [[String]] = []
    var results: [String: RunResult] = [:]
    func run(_ argv: [String]) -> RunResult {
        calls.append(argv)
        return results[argv.joined(separator: " ")]
            ?? RunResult(status: 0, stdout: Data("ok\n".utf8), stderr: Data())
    }
}

final class RecordingExecutor: Executor {
    var executed: [(Plan, Confirmation)] = []
    var error: Error?
    func execute(_ plan: Plan, confirmation: Confirmation) throws -> [StepOutcome] {
        if let error { throw error }
        executed.append((plan, confirmation))
        return plan.commands.map { StepOutcome(step: $0, status: 0, output: "") }
    }
}

/// A synthetic Mac: a disk0 layout plus the text answers of the other probes, written out as the
/// same plists `diskutil` produces, so tests run through the real parser.
struct FakeMac {
    struct P {
        var id: String
        var content: String
        var size: UInt64
        var name = ""
        var mount: String? = nil
        var uuid: String { "00000000-0000-4000-8000-" + String(repeating: "0", count: 12 - id.count) + id.uppercased() }
    }

    static let gb = Size.gb
    static let defaultText: [String: String] = [
        "sysctl-hw.model.txt": "MacBookAir10,1\n",
        "ioreg-platform.txt": "+-o J313AP  <class IOPlatformExpertDevice>\n    {\n      \"compatible\" = <\"J313AP\",\"MacBookAir10,1\",\"AppleARM\">\n    }\n",
        "sw_vers.txt": "ProductName:\t\tmacOS\nProductVersion:\t\t27.0.1\nBuildVersion:\t\t26A434\n",
        "fdesetup-status.txt": "FileVault is On.\n",
        "pmset-batt.txt": "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charged; 0:00 remaining present: true\n",
        "tmutil-latestbackup.txt": "/Volumes/.timemachine/X/2026-11-16-100000.backup/2026-11-16-100000.backup\n",
    ]

    /// Physical order, first to last.
    var partitions: [P]
    var containerFree: UInt64
    var gapAfterMac: UInt64 = 0
    var text = FakeMac.defaultText
    var mediaName = "APPLE SSD AP0256Q"
    var diskSize: UInt64 = 251_000_193_024
    var macHasSystem = true
    var stubVolumeName = "AI UI OS"

    static let ourParts: [P] = [
        P(id: "disk0s4", content: "Apple_APFS", size: Size.stub, name: "Stub - AI UI OS"),
        P(id: "disk0s5", content: "EFI", size: 524_288_000, name: "EFI - AI UI OS", mount: "/Volumes/AIUI-EFI"),
        P(id: "disk0s6", content: "Linux Filesystem", size: 1_073_741_824, name: "Boot - AI UI OS"),
        P(id: "disk0s7", content: "Linux Filesystem", size: 20 * gb, name: "Root - AI UI OS"),
    ]

    /// iSC, macOS, [AI UI OS], Recovery. The macOS partition takes what the others leave.
    static func standard(free: UInt64 = 80 * gb, installed: Bool = false, gap: UInt64 = 0, extraBetween: [P] = []) -> FakeMac {
        let between = (installed ? ourParts : []) + extraBetween
        let used = between.reduce(0) { $0 + $1.size }
        let macSize = 245_107_195_904 - used - gap
        var parts = [P(id: "disk0s1", content: "Apple_APFS_ISC", size: 524_288_000),
                     P(id: "disk0s2", content: "Apple_APFS", size: macSize)]
        parts += between
        parts.append(P(id: "disk0s3", content: "Apple_APFS_Recovery", size: 5_368_664_064))
        return FakeMac(partitions: parts, containerFree: free, gapAfterMac: gap)
    }

    static func marker(for mac: FakeMac) -> InstallMarker {
        let roles = ["Stub": "stub", "EFI": "esp", "Boot": "boot", "Root": "root"]
        return InstallMarker(
            format: 1, product: "AI UI OS", disk: .init(mediaName: mac.mediaName, size: mac.diskSize), stubVGID: "VGID",
            partitions: mac.partitions.filter { $0.name.hasSuffix(" - AI UI OS") }.map {
                .init(role: roles[String($0.name.split(separator: " ")[0])]!, partitionUUID: $0.uuid, name: $0.name)
            })
    }

    func offsets() -> [String: UInt64] {
        var result: [String: UInt64] = [:]
        var at: UInt64 = 24576
        for p in partitions {
            result[p.id] = at
            at += p.size
            if p.id == "disk0s2" { at += gapAfterMac }
        }
        return result
    }

    static func plist(_ object: Any) -> Data {
        try! PropertyListSerialization.data(fromPropertyList: object, format: .xml, options: 0)
    }

    var files: [String: Data] {
        let offsets = offsets()
        var files: [String: Data] = [:]
        for (k, v) in text { files[k] = Data(v.utf8) }
        // diskutil lists partitions by GPT entry number, not physical position.
        let byNumber = partitions.sorted { Int($0.id.dropFirst(6))! < Int($1.id.dropFirst(6))! }
        let listParts: [[String: Any]] = byNumber.map {
            ["DeviceIdentifier": $0.id, "Content": $0.content, "Size": $0.size, "DiskUUID": $0.uuid]
        }
        files["diskutil-list.plist"] = FakeMac.plist([
            "AllDisksAndPartitions": [
                ["DeviceIdentifier": "disk0", "Content": "GUID_partition_scheme", "Size": diskSize, "Partitions": listParts],
                ["DeviceIdentifier": "disk3", "Content": "Apple_APFS_Container", "Size": 1, "Partitions": [[String: Any]]()],
            ],
        ])
        files["diskutil-info-disk0.plist"] = FakeMac.plist(["DeviceIdentifier": "disk0", "MediaName": mediaName, "Size": diskSize])
        for p in partitions {
            files["diskutil-info-\(p.id).plist"] = FakeMac.plist([
                "DeviceIdentifier": p.id, "PartitionMapPartitionOffset": offsets[p.id]!, "MediaName": p.name,
                "MountPoint": p.mount ?? "",
            ])
        }
        var containers: [[String: Any]] = []
        for (n, p) in partitions.enumerated() where p.content.hasPrefix("Apple_APFS") {
            var volumes: [[String: Any]] = []
            var free: UInt64 = 1_000_000
            if p.id == "disk0s2" {
                free = containerFree
                volumes = [["DeviceIdentifier": "disk3s1", "Name": "Macintosh HD - Data", "Roles": ["Data"], "FileVault": true],
                           ["DeviceIdentifier": "disk3s3", "Name": "Macintosh HD", "Roles": macHasSystem ? ["System"] : [], "FileVault": true]]
            } else if p.id == "disk0s4" {
                volumes = [["DeviceIdentifier": "disk4s1", "Name": stubVolumeName, "Roles": [String](), "FileVault": false]]
            }
            containers.append(["ContainerReference": p.id == "disk0s2" ? "disk3" : "disk\(10 + n)", "DesignatedPhysicalStore": p.id,
                               "CapacityCeiling": p.size, "CapacityFree": free, "Volumes": volumes])
        }
        // A disk image's container (not on disk0) and an incomplete entry: both ignored.
        containers.append(["ContainerReference": "disk20", "DesignatedPhysicalStore": "disk19s1", "CapacityCeiling": 1, "CapacityFree": 1])
        containers.append(["ContainerReference": "disk21", "DesignatedPhysicalStore": "disk0s9"])
        files["diskutil-apfs-list.plist"] = FakeMac.plist(["Containers": containers])
        return files
    }

    var probe: DictProbe { DictProbe(files: files) }
    var layout: DiskLayout { try! DiskLayout.load(from: probe) }

    func write(to dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, data) in files { try data.write(to: dir.appendingPathComponent(name)) }
    }
}

func tempDir() -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("aiui-os-tests-" + UUID().uuidString)
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// Runs the CLI against a probe and collects its output.
struct CLIRun {
    var status: Int32
    var out: [String]
    var err: [String]
    var json: [[String: Any]] {
        out.map { try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    }
}

func runCLI(_ args: [String], probe: Probe = FakeMac.standard().probe, executor: Executor = RecordingExecutor(),
            files: [String: Data] = [:]) -> CLIRun {
    var out: [String] = [], err: [String] = []
    let status = CLI(probe: probe, executor: executor, now: { fixtureNow }, timeZone: utc,
                     readFile: { files[$0] }, out: { out.append($0) }, err: { err.append($0) }).run(args)
    return CLIRun(status: status, out: out, err: err)
}
