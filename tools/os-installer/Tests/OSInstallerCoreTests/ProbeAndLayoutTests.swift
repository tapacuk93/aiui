import Foundation
import XCTest
@testable import OSInstallerCore

final class ProbeTests: XCTestCase {
    func testQueriesAreFixedReadOnlyCommands() {
        let all: [Query] = [.diskList, .apfsList, .diskInfo("disk0s2"), .hwModel, .platform, .swVers, .fileVault, .battery, .latestBackup]
        let programs = Set(all.map { $0.argv![0] })
        XCTAssertEqual(programs, ["/usr/sbin/diskutil", "/usr/sbin/sysctl", "/usr/sbin/ioreg", "/usr/bin/sw_vers",
                                  "/usr/bin/fdesetup", "/usr/bin/pmset", "/usr/bin/tmutil"])
        for q in all where q.argv![0] == "/usr/sbin/diskutil" {
            XCTAssertTrue(q.argv!.contains("-plist") && (q.argv!.contains("list") || q.argv!.contains("info")))
        }
        XCTAssertEqual(Set(all.map { $0.fixtureName! }).count, all.count)
        XCTAssertEqual(Query.diskInfo("disk0s2").argv, ["/usr/sbin/diskutil", "info", "-plist", "disk0s2"])
        XCTAssertEqual(Query.diskInfo("disk0s2").fixtureName, "diskutil-info-disk0s2.plist")
    }

    func testMalformedDiskIdentifiersNeverReachACommand() {
        for bad in ["disk0s2; rm -rf /", "/dev/disk0", "", "disk", "disk0s", "Disk0"] {
            XCTAssertFalse(Query.isDiskIdentifier(bad), bad)
            XCTAssertNil(Query.diskInfo(bad).argv)
            XCTAssertNil(Query.diskInfo(bad).fixtureName)
        }
        XCTAssertTrue(Query.isDiskIdentifier("disk12s34"))
        let runner = RecordingRunner()
        XCTAssertNil(SystemProbe(runner: runner).run(.diskInfo("disk0s2 && x")))
        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertNil(FixtureProbe(directory: thisMac).run(.diskInfo("../x")))
    }

    func testProcessRunner() {
        let echo = ProcessRunner().run(["/bin/echo", "hello"])
        XCTAssertEqual(echo.status, 0)
        XCTAssertEqual(String(decoding: echo.stdout, as: UTF8.self), "hello\n")
        XCTAssertEqual(ProcessRunner().run(["/usr/bin/false"]).status, 1)
        let missing = ProcessRunner().run(["/nonexistent/tool"])
        XCTAssertEqual(missing.status, -1)
        XCTAssertFalse(missing.stderr.isEmpty)
    }

    func testSystemProbeReturnsOutputOnlyOnSuccess() {
        let runner = RecordingRunner()
        runner.results["/usr/bin/fdesetup status"] = RunResult(status: 1, stdout: Data("x".utf8), stderr: Data())
        let probe = SystemProbe(runner: runner)
        XCTAssertEqual(probe.text(.swVers), "ok\n")
        XCTAssertNil(probe.run(.fileVault))
        XCTAssertEqual(runner.calls, [["/usr/bin/sw_vers"], ["/usr/bin/fdesetup", "status"]])
        _ = SystemProbe() // default runner
    }

    func testFixtureProbe() {
        let probe = FixtureProbe(directory: thisMac)
        XCTAssertEqual(probe.text(.swVers)?.contains("27.0.1"), true)
        XCTAssertNil(FixtureProbe(directory: URL(fileURLWithPath: "/nonexistent")).run(.swVers))
    }
}

final class LayoutTests: XCTestCase {
    func testRecordedLayoutOfThisMac() throws {
        let layout = try DiskLayout.load(from: FixtureProbe(directory: thisMac))
        XCTAssertEqual(layout.disk, "disk0")
        XCTAssertEqual(layout.mediaName, "APPLE SSD AP0256Q")
        XCTAssertEqual(layout.size, 251_000_193_024)
        XCTAssertEqual(layout.partitions.map(\.id), ["disk0s1", "disk0s2", "disk0s3"])
        XCTAssertEqual(layout.macPartition?.id, "disk0s2")
        XCTAssertEqual(layout.recoveryPartition?.id, "disk0s3")
        XCTAssertEqual(layout.container(onStore: "disk0s2")?.free, 25_389_518_848)
        XCTAssertEqual(layout.container(onStore: "disk0s2")?.ref, "disk3")
        XCTAssertNil(layout.container(onStore: "disk4s1"), "disk images are not part of disk0")
        XCTAssertEqual(layout.gapAfterMac, 0)
        XCTAssertTrue(layout.between.isEmpty)
        XCTAssertNil(layout.partition("disk0s9"))
        XCTAssertNil(layout.partitions[0].mountPoint)
    }

    func testPhysicalOrderComesFromOffsetsNotNumbers() {
        let layout = FakeMac.standard(installed: true).layout
        XCTAssertEqual(layout.partitions.map(\.id), ["disk0s1", "disk0s2", "disk0s4", "disk0s5", "disk0s6", "disk0s7", "disk0s3"])
        XCTAssertEqual(layout.between.map(\.id), ["disk0s4", "disk0s5", "disk0s6", "disk0s7"])
        XCTAssertEqual(layout.partition("disk0s5")?.mountPoint, "/Volumes/AIUI-EFI")
        XCTAssertEqual(layout.partition("disk0s5")?.name, "EFI - AI UI OS")
        XCTAssertEqual(layout.containers.count, 4, "iSC, macOS, stub, Recovery; not the disk image or the incomplete entry")
    }

    func testGapAfterMacOS() {
        XCTAssertEqual(FakeMac.standard(gap: 5 * Size.gb).layout.gapAfterMac, 5 * Size.gb)
        // macOS last on the disk: the gap runs to the end of the disk.
        var mac = FakeMac.standard()
        mac.partitions.removeLast()
        mac.diskSize = 300 * Size.gb
        let layout = mac.layout
        XCTAssertEqual(layout.gapAfterMac, layout.size - layout.macPartition!.end)
        XCTAssertNil(layout.recoveryPartition)
        XCTAssertTrue(layout.between.isEmpty)
    }

    func testNoMacOSContainer() {
        var mac = FakeMac.standard()
        mac.macHasSystem = false
        let layout = mac.layout
        XCTAssertNil(layout.macPartition)
        XCTAssertEqual(layout.gapAfterMac, 0)
        XCTAssertTrue(layout.between.isEmpty)
    }

    func testLoadErrors() {
        let good = FakeMac.standard().files
        func load(_ change: (inout [String: Data]) -> Void) -> LayoutError? {
            var files = good
            change(&files)
            do { _ = try DiskLayout.load(from: DictProbe(files: files)); return nil } catch { return error as? LayoutError }
        }
        XCTAssertEqual(load { $0["diskutil-list.plist"] = nil }, .commandFailed("diskutil list"))
        XCTAssertEqual(load { $0["diskutil-apfs-list.plist"] = Data("nope".utf8) }, .malformed("diskutil apfs list is not a property list"))
        XCTAssertEqual(load { $0["diskutil-list.plist"] = FakeMac.plist(["AllDisksAndPartitions": [["DeviceIdentifier": "disk1"]]]) },
                       .malformed("no disk0 in diskutil list"))
        XCTAssertEqual(load { $0["diskutil-list.plist"] = FakeMac.plist(["AllDisksAndPartitions": [["DeviceIdentifier": "disk0", "Partitions": [["Size": 1]]]]]) },
                       .malformed("partition without identifier"))
        XCTAssertEqual(load { $0["diskutil-info-disk0s2.plist"] = nil }, .commandFailed("diskutil info disk0s2"))
        XCTAssertEqual(load { $0["diskutil-info-disk0s2.plist"] = FakeMac.plist(["DeviceIdentifier": "disk0s2"]) },
                       .malformed("no offset or size for disk0s2"))
        XCTAssertEqual(LayoutError.commandFailed("x").description, "could not read the disk layout (x failed)")
        XCTAssertEqual(LayoutError.malformed("y").description, "unexpected diskutil output: y")
    }

    func testMinimalPlistsUseDefaults() throws {
        let files: [String: Data] = [
            "diskutil-list.plist": FakeMac.plist(["AllDisksAndPartitions": [["DeviceIdentifier": "disk0", "Partitions": [["DeviceIdentifier": "disk0s1", "Size": 10]]]]]),
            "diskutil-apfs-list.plist": FakeMac.plist(["Containers": [["ContainerReference": "disk3", "DesignatedPhysicalStore": "disk0s1", "CapacityCeiling": 10, "CapacityFree": 5, "Volumes": [[String: Any]()]]]]),
            "diskutil-info-disk0.plist": FakeMac.plist([String: Any]()),
            "diskutil-info-disk0s1.plist": FakeMac.plist(["PartitionMapPartitionOffset": 0]),
        ]
        let layout = try DiskLayout.load(from: DictProbe(files: files))
        XCTAssertEqual(layout.size, 0)
        XCTAssertEqual(layout.mediaName, "")
        XCTAssertEqual(layout.partitions, [Partition(id: "disk0s1", content: "", size: 10, offset: 0, uuid: "", name: "", mountPoint: nil)])
        XCTAssertEqual(layout.containers[0].volumes, [Volume(id: "", name: "", roles: [], fileVault: false)])
        XCTAssertEqual(layout.partitions[0].end, 10)
        // No containers at all, and a container listing no volumes.
        var files2 = files
        files2["diskutil-apfs-list.plist"] = FakeMac.plist([String: Any]())
        XCTAssertTrue(try DiskLayout.load(from: DictProbe(files: files2)).containers.isEmpty)
        files2["diskutil-apfs-list.plist"] = FakeMac.plist(["Containers": [["ContainerReference": "disk3", "DesignatedPhysicalStore": "disk0s1", "CapacityCeiling": 10, "CapacityFree": 5]]])
        XCTAssertEqual(try DiskLayout.load(from: DictProbe(files: files2)).containers[0].volumes, [])
    }

    func testPartitionTypes() {
        XCTAssertTrue(PartitionType.isEFI("EFI"))
        XCTAssertTrue(PartitionType.isEFI("c12a7328-f81f-11d2-ba4b-00a0c93ec93b"))
        XCTAssertFalse(PartitionType.isEFI("Linux Filesystem"))
        XCTAssertTrue(PartitionType.isLinux("Linux Filesystem"))
        XCTAssertTrue(PartitionType.isLinux("Linux"))
        XCTAssertTrue(PartitionType.isLinux(PartitionType.linuxGUID))
        XCTAssertFalse(PartitionType.isLinux("Microsoft Basic Data"))
    }

    func testSizes() {
        XCTAssertEqual(Size.alignUp(1), 4096)
        XCTAssertEqual(Size.alignUp(4096), 4096)
        XCTAssertEqual(Size.alignDown(4097), 4096)
        XCTAssertEqual(Size.stub % 4096, 0)
        XCTAssertEqual(Size.gbText(37_610_481_152), "37.7 GB")
        XCTAssertEqual(Size.gbText(25 * Size.gb), "25.0 GB")
        XCTAssertEqual(Size.gbText(1), "0.1 GB")
        XCTAssertEqual(Size.parse(NSNumber(value: 7)), 7)
        XCTAssertEqual(Size.parse("524288000B"), 524_288_000)
        XCTAssertEqual(Size.parse("25GB"), 25 * Size.gb)
        XCTAssertEqual(Size.parse("30"), 30 * Size.gb)
        XCTAssertNil(Size.parse("lots"))
        XCTAssertNil(Size.parse(nil))
    }
}
