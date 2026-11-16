import Foundation
import XCTest
@testable import OSInstallerCore

final class ManifestTests: XCTestCase {
    func parse(_ json: String) throws -> OSManifest { try OSManifest.parse(Data(json.utf8)) }

    func testInstallerDataAndSingleEntry() throws {
        let entry = """
        {"name":"AI UI OS","package":"aiui.zip","supported_fw":["13.5"],"partitions":[
          {"name":"EFI","type":"EFI","size":"524288000B","format":"fat"},
          {"name":"Boot","type":"Linux","size":"1073741824B","image":"boot.img"},
          {"name":"Root","type":"Linux","size":7000000000,"image":"root.img","expand":true}]}
        """
        let m = try parse(entry)
        XCTAssertEqual(m.name, "AI UI OS")
        XCTAssertEqual(m.partitions.map(\.size), [524_288_000, 1_073_741_824, 7_000_000_000])
        XCTAssertEqual(m.partitions.map(\.expand), [false, false, true])
        XCTAssertEqual(try parse("{\"os_list\":[\(entry)]}"), m)
        let bare = try parse("""
        {"name":"x","partitions":[{"name":"EFI","type":"EFI","size":"1B"},{"name":"Root","type":"Linux","size":"1B","expand":true}]}
        """)
        XCTAssertEqual(bare.package, "")
        XCTAssertEqual(bare.supportedFW, [])
    }

    func testInvalidManifests() {
        let bad = [
            "[1]",
            "{\"name\":\"x\",\"partitions\":[]}",
            "{\"name\":\"x\",\"partitions\":[{\"name\":\"A\",\"type\":\"NTFS\",\"size\":\"1B\"}]}",
            "{\"name\":\"x\",\"partitions\":[{\"type\":\"EFI\",\"size\":\"1B\"}]}",
            "{\"name\":\"x\",\"partitions\":[{\"name\":\"EFI\",\"type\":\"EFI\",\"size\":\"1B\"}]}",
            "{\"name\":\"x\",\"partitions\":[{\"name\":\"R\",\"type\":\"Linux\",\"size\":\"1B\",\"expand\":true}]}",
        ]
        for json in bad {
            XCTAssertThrowsError(try parse(json), json) { XCTAssertTrue("\($0)".hasPrefix("package manifest: "), "\($0)") }
        }
    }

    func testExampleManifestMatchesBuiltIn() throws {
        let data = try Data(contentsOf: fixturesRoot.deletingLastPathComponent().appendingPathComponent("manifests/aiui-os.example.json"))
        let m = try OSManifest.parse(data)
        XCTAssertEqual(m.partitions, OSManifest.builtIn.partitions)
        XCTAssertEqual(m.supportedFW, OSManifest.builtIn.supportedFW)
    }
}

final class InstallPlannerTests: XCTestCase {
    func testThisMacNeedsSpaceFirst() throws {
        let layout = try DiskLayout.load(from: FixtureProbe(directory: thisMac))
        XCTAssertThrowsError(try InstallPlanner.plan(layout: layout, manifest: .builtIn)) {
            XCTAssertEqual($0 as? PlanError, .notEnoughSpace(toFree: 37_610_481_152))
            XCTAssertEqual("\($0)", "not enough space: free 37.7 GB in macOS first")
        }
    }

    func testPlanShrinksMacOSAndCreatesMarkedPartitions() throws {
        let layout = FakeMac.standard(free: 70 * Size.gb).layout
        let plan = try InstallPlanner.plan(layout: layout, manifest: .builtIn, packagePath: "/tmp/pkg")
        XCTAssertEqual(plan.kind, .install)
        let shells = plan.commands.map(\.shell)
        let ceiling = layout.container(onStore: "disk0s2")!.ceiling
        XCTAssertEqual(shells, [
            "diskutil apfs resizeContainer disk0s2 \(ceiling - 24_999_997_440)B",
            "diskutil addPartition disk0s2 APFS 'AI UI OS' 2500001792B",
            "diskutil addPartition '<new:stub>' %C12A7328-F81F-11D2-BA4B-00A0C93EC93B% %noformat% 524288000B",
            "newfs_msdos -F 32 -v AIUI-EFI '/dev/r<new:esp>'",
            "diskutil addPartition '<new:esp>' %0FC63DAF-8483-4772-8E79-3D69D8477DE4% %noformat% 1073741824B",
            "dd if=/tmp/pkg/boot.img 'of=/dev/r<new:boot>' bs=8m",
            "diskutil addPartition '<new:boot>' %0FC63DAF-8483-4772-8E79-3D69D8477DE4% %noformat% 20901965824B",
            "dd if=/tmp/pkg/root.img 'of=/dev/r<new:root>' bs=8m",
            "bless --mount '/Volumes/AI UI OS' --setBoot",
        ])
        XCTAssertEqual(plan.steps.filter { $0.kind == .user }.count, Guide.step2.count)
        XCTAssertEqual(plan.steps.filter { $0.kind == .installer }.count, 5)
        XCTAssertEqual(plan.details["total"] as? UInt64, 24_999_997_440)
        let parts = plan.details["partitions"] as! [[String: Any]]
        XCTAssertEqual(parts.map { $0["name"] as! String }, ["Stub - AI UI OS", "EFI - AI UI OS", "Boot - AI UI OS", "Root - AI UI OS"])
        let marker = plan.details["marker"] as! [String: Any]
        XCTAssertEqual((marker["partitions"] as! [[String: Any]]).map { $0["role"] as! String }, ["stub", "esp", "boot", "root"])
        XCTAssertEqual(Set(plan.protected), ["disk0s1", "disk0s2", "disk0s3"])
        XCTAssertNotNil(SafetyGuard.check(plan), "install plans never pass the uninstall guard")
    }

    func testUnallocatedSpaceIsUsedFirst() throws {
        let plan = try InstallPlanner.plan(layout: FakeMac.standard(free: 40 * Size.gb, gap: 30 * Size.gb).layout, manifest: .builtIn)
        XCTAssertFalse(plan.commands.contains { $0.argv.contains("resizeContainer") })
        XCTAssertEqual((plan.details["resize"] as! [String: Any])["shrinkBy"] as? UInt64, 0)
    }

    func testRefusals() {
        XCTAssertThrowsError(try InstallPlanner.plan(layout: FakeMac.standard(free: 100 * Size.gb, installed: true).layout, manifest: .builtIn)) {
            XCTAssertEqual($0 as? PlanError, .alreadyInstalled)
        }
        XCTAssertThrowsError(try InstallPlanner.plan(layout: FakeMac.standard().layout, manifest: .builtIn, target: 10 * Size.gb)) {
            XCTAssertEqual($0 as? PlanError, .targetTooSmall(minimum: 11_614_224_384))
        }
        var odd = FakeMac.standard()
        odd.partitions.removeLast()
        XCTAssertThrowsError(try InstallPlanner.plan(layout: odd.layout, manifest: .builtIn)) {
            XCTAssertTrue("\($0)".hasPrefix("unusual disk layout"))
        }
        XCTAssertEqual("\(PlanError.alreadyInstalled)", "AI UI OS is already installed: uninstall it first")
        XCTAssertEqual("\(PlanError.targetTooSmall(minimum: 12 * Size.gb))", "AI UI OS needs at least 12.0 GB for this package")
    }

    func testManifestWithoutFirmwareList() throws {
        var m = OSManifest.builtIn
        m.supportedFW = []
        let plan = try InstallPlanner.plan(layout: FakeMac.standard().layout, manifest: m)
        XCTAssertTrue(plan.steps.contains { $0.note.contains("macOS ? from") })
    }
}

final class UninstallPlannerTests: XCTestCase {
    func plan(_ mac: FakeMac, _ marker: InstallMarker? = nil) throws -> Plan {
        try UninstallPlanner.plan(layout: mac.layout, marker: marker ?? FakeMac.marker(for: mac))
    }

    func refusal(_ mac: FakeMac, _ marker: InstallMarker? = nil) -> String {
        do { _ = try plan(mac, marker); return "planned" } catch { return "\(error)" }
    }

    func testPlanDeletesOnlyOurPartitionsAndGrowsMacOS() throws {
        let mac = FakeMac.standard(installed: true)
        let p = try plan(mac)
        XCTAssertEqual(p.commands.map(\.shell), [
            "bless --mount / --setBoot",
            "diskutil apfs deleteContainer disk0s4",
            "diskutil eraseVolume free free disk0s5",
            "diskutil eraseVolume free free disk0s6",
            "diskutil eraseVolume free free disk0s7",
            "diskutil apfs resizeContainer disk0s2 0",
        ])
        XCTAssertEqual(p.protected, ["disk0", "disk0s1", "disk0s2", "disk0s3"])
        XCTAssertNil(SafetyGuard.check(p))
        XCTAssertEqual(p.details["reclaimed"] as? UInt64, FakeMac.ourParts.reduce(0) { $0 + $1.size })
        XCTAssertTrue((p.details["ifResizeFails"] as! String).contains("repairVolume disk0s2"))
        // Same disk, same plan, same hash; GUIDs in lower case are fine.
        var lower = FakeMac.marker(for: mac)
        lower.partitions[0].partitionUUID = lower.partitions[0].partitionUUID.lowercased()
        XCTAssertEqual(try plan(mac, lower).hash, p.hash)
    }

    func testRefusesUnusualLayouts() {
        var mac = FakeMac.standard(installed: true)
        let marker = FakeMac.marker(for: mac)
        mac.partitions.removeLast()
        XCTAssertTrue(refusal(mac, marker).contains("unusual disk layout"))
    }

    func testRefusesAnotherDisk() {
        let mac = FakeMac.standard(installed: true)
        var marker = FakeMac.marker(for: mac)
        marker.disk.size += 1
        XCTAssertTrue(refusal(mac, marker).contains("belongs to another disk"))
    }

    func testRefusesIncompleteMarker() {
        let mac = FakeMac.standard(installed: true)
        var marker = FakeMac.marker(for: mac)
        marker.partitions.removeFirst()
        XCTAssertTrue(refusal(mac, marker).contains("one stub"))
        marker.partitions = [FakeMac.marker(for: mac).partitions[0]]
        XCTAssertTrue(refusal(mac, marker).contains("one stub"))
    }

    func testRefusesMissingPartition() {
        let mac = FakeMac.standard(installed: true)
        var marker = FakeMac.marker(for: mac)
        marker.partitions[3].partitionUUID = "11111111-0000-4000-8000-000000000000"
        XCTAssertTrue(refusal(mac, marker).contains("not on the disk; nothing was changed"))
    }

    func testNeverTouchesISCMacOSOrRecoveryEvenIfTheMarkerSaysSo() {
        let mac = FakeMac.standard(installed: true)
        for id in ["disk0s1", "disk0s2", "disk0s3"] {
            var marker = FakeMac.marker(for: mac)
            marker.partitions[1].partitionUUID = mac.partitions.first { $0.id == id }!.uuid
            XCTAssertTrue(refusal(mac, marker).contains("never deleted"), id)
        }
    }

    func testRefusesPartitionsOutsideTheRegion() {
        // Our partitions after Recovery (wrong order).
        var mac = FakeMac.standard(installed: true)
        let rec = mac.partitions.remove(at: 6)
        mac.partitions.insert(rec, at: 3)
        XCTAssertTrue(refusal(mac).contains("is not between macOS (disk0s2) and Recovery (disk0s3)"), refusal(mac))
    }

    func testRefusesWrongNames() {
        var mac = FakeMac.standard(installed: true)
        let marker = FakeMac.marker(for: mac)
        mac.partitions[3].name = "EFI - FEDOR"
        XCTAssertTrue(refusal(mac, marker).contains("is named \"EFI - FEDOR\""))
        // Marker and disk agree but the name lacks our suffix.
        var renamed = FakeMac.standard(installed: true)
        renamed.partitions[4].name = "Boot"
        var m2 = FakeMac.marker(for: FakeMac.standard(installed: true))
        m2.partitions[2].name = "Boot"
        XCTAssertTrue(refusal(renamed, m2).contains("is named \"Boot\""))
    }

    func testRefusesWrongTypes() {
        for (index, content) in [(2, "Linux Filesystem"), (3, "Apple_APFS"), (5, "EFI")] {
            var mac = FakeMac.standard(installed: true)
            mac.partitions[index].content = content
            XCTAssertTrue(refusal(mac).contains("has type \(content)"), "\(index)")
        }
    }

    func testRefusesForeignPartitionsInTheRegion() {
        let mac = FakeMac.standard(installed: true, extraBetween: [.init(id: "disk0s8", content: "Linux Filesystem", size: Size.gb, name: "Fedora")])
        XCTAssertTrue(refusal(mac).contains("disk0s8 (Linux Filesystem) between macOS and Recovery is not ours"))
    }

    func testFindMarker() throws {
        let mac = FakeMac.standard(installed: true)
        let data = FakeMac.marker(for: mac).encoded()
        let fromESP = try UninstallPlanner.findMarker(layout: mac.layout, explicit: nil) {
            $0 == "/Volumes/AIUI-EFI/asahi/aiui-install.json" ? data : nil
        }
        XCTAssertEqual(fromESP, FakeMac.marker(for: mac))
        XCTAssertEqual(try UninstallPlanner.findMarker(layout: mac.layout, explicit: "/m.json") { $0 == "/m.json" ? data : nil }, fromESP)
        XCTAssertThrowsError(try UninstallPlanner.findMarker(layout: mac.layout, explicit: "/x") { _ in nil }) {
            XCTAssertEqual("\($0)", "refused: cannot read /x")
        }
        var unmounted = FakeMac.standard(installed: true)
        unmounted.partitions[3].mount = nil
        XCTAssertThrowsError(try UninstallPlanner.findMarker(layout: unmounted.layout, explicit: nil) { _ in data }) {
            XCTAssertEqual("\($0)", "refused: no AI UI OS install marker found; mount the EFI partition first (diskutil mount disk0s5) or pass --marker")
        }
        XCTAssertThrowsError(try UninstallPlanner.findMarker(layout: FakeMac.standard().layout, explicit: nil) { _ in data }) {
            XCTAssertEqual("\($0)", "refused: no AI UI OS install marker found")
        }
    }

    func testMarkerFormat() throws {
        let marker = FakeMac.marker(for: FakeMac.standard(installed: true))
        XCTAssertEqual(try InstallMarker.decode(marker.encoded()), marker)
        var other = marker
        other.product = "Fedora"
        XCTAssertThrowsError(try InstallMarker.decode(other.encoded()))
        other = marker
        other.format = 2
        XCTAssertThrowsError(try InstallMarker.decode(other.encoded()))
        XCTAssertThrowsError(try InstallMarker.decode(Data("{}".utf8)))
    }
}
