import Foundation
import XCTest
@testable import OSInstallerCore

final class PreflightTests: XCTestCase {
    func report(_ mac: FakeMac, target: UInt64 = Size.target) -> Preflight.Report {
        Preflight(probe: mac.probe, now: fixtureNow, timeZone: utc, target: target).run()
    }

    func check(_ id: String, _ mac: FakeMac) -> Check {
        report(mac).checks.first { $0.id == id }!
    }

    func withText(_ name: String, _ value: String?) -> FakeMac {
        var mac = FakeMac.standard()
        mac.text[name] = value
        return mac
    }

    /// M0 test from docs/os-plan.md §5, on the recorded output of this Mac.
    func testThisMac() {
        let r = Preflight(probe: FixtureProbe(directory: thisMac), now: fixtureNow, timeZone: utc).run()
        let byID = Dictionary(uniqueKeysWithValues: r.checks.map { ($0.id, $0) })
        XCTAssertEqual(r.checks.map(\.id), ["model", "macos", "space", "existing", "filevault", "power", "backup"])
        XCTAssertEqual(byID["model"]?.status, .ok)
        XCTAssertEqual(byID["model"]?.data["board"] as? String, "j313ap")
        XCTAssertTrue(byID["model"]!.notes.contains { $0.contains("reference machine") })
        XCTAssertEqual(byID["macos"]?.status, .ok)
        XCTAssertEqual(byID["macos"]?.notes.count, 3)
        XCTAssertEqual(byID["space"]?.status, .fail)
        XCTAssertEqual(byID["space"]?.data["toFree"] as? UInt64, 63_000_000_000 - 25_389_518_848)
        XCTAssertTrue(byID["space"]!.summary.hasPrefix("free 37.7 GB in macOS first"), byID["space"]!.summary)
        XCTAssertEqual(byID["existing"]?.status, .ok)
        XCTAssertEqual(byID["filevault"]?.data["on"] as? Bool, true)
        XCTAssertEqual(byID["power"]?.status, .ok)
        XCTAssertEqual(byID["power"]?.data["battery"] as? Int, 46)
        XCTAssertEqual(byID["backup"]?.status, .fail)
        XCTAssertFalse(r.ready)
        XCTAssertNotNil(r.layout)
        XCTAssertEqual(r.json["ready"] as? Bool, false)
        XCTAssertEqual((r.json["checks"] as? [[String: Any]])?.count, 7)
    }

    func testReadyMac() {
        let r = report(FakeMac.standard())
        XCTAssertTrue(r.ready, "\(r.checks.map { "\($0.id) \($0.summary)" })")
        XCTAssertEqual(r.checks.first { $0.id == "backup" }?.summary, "last Time Machine backup 2 h ago")
    }

    func testModel() {
        XCTAssertEqual(check("model", withText("ioreg-platform.txt", nil)).status, .fail)
        XCTAssertEqual(check("model", withText("ioreg-platform.txt", "+-o Mac-Intel\n")).summary, "MacBookAir10,1: not an Apple silicon Mac")
        let m3 = check("model", withText("ioreg-platform.txt", "\"compatible\" = <\"J613AP\",\"Mac15,12\">"))
        XCTAssertEqual(m3.status, .fail)
        XCTAssertTrue(m3.summary.contains("j613ap"))
        var mini = FakeMac.standard()
        mini.text["ioreg-platform.txt"] = "\"compatible\" = <\"J274AP\",\"Macmini9,1\",\"AppleARM\">"
        mini.text["sysctl-hw.model.txt"] = nil
        let c = check("model", mini)
        XCTAssertEqual(c.status, .ok)
        XCTAssertEqual(c.data["model"] as? String, "unknown")
        XCTAssertEqual(c.notes.count, 1, "not the reference machine")
        XCTAssertEqual(Preflight.board("\"compatible\" = <\"J313AP\",\"MacBookAir10,1\">"), "j313ap")
        XCTAssertEqual(Devices.supported[Devices.reference], "MacBook Air (M1, 2020)")
    }

    func testMacOSVersion() {
        XCTAssertEqual(check("macos", withText("sw_vers.txt", nil)).summary, "could not read the macOS version")
        XCTAssertEqual(check("macos", withText("sw_vers.txt", "ProductVersion: 13.4\nBuildVersion: X")).status, .fail)
        let sonoma = check("macos", withText("sw_vers.txt", "ProductVersion:\t14.6\n"))
        XCTAssertEqual(sonoma.status, .ok)
        XCTAssertTrue(sonoma.notes.isEmpty)
        XCTAssertEqual(sonoma.data["build"] as? String, "")
        XCTAssertEqual(check("macos", withText("sw_vers.txt", "ProductVersion: 13.5")).status, .ok)
    }

    func testSpace() {
        // 25 + 38 GB needed. Unallocated space after macOS counts too.
        XCTAssertEqual(check("space", FakeMac.standard(free: 63 * Size.gb)).status, .ok)
        XCTAssertEqual(check("space", FakeMac.standard(free: 40 * Size.gb, gap: 23 * Size.gb)).status, .ok)
        let low = check("space", FakeMac.standard(free: 50 * Size.gb))
        XCTAssertEqual(low.status, .fail)
        XCTAssertEqual(low.data["toFree"] as? UInt64, 13 * Size.gb)
        XCTAssertEqual(low.notes.count, 1)
        let small = Preflight.space(FakeMac.standard(free: 50 * Size.gb).layout, target: 10 * Size.gb)
        XCTAssertEqual(small.status, .ok)
    }

    func testSpaceRefusesUnusualLayouts() {
        var noRecovery = FakeMac.standard()
        noRecovery.partitions.removeLast()
        XCTAssertTrue(check("space", noRecovery).summary.hasPrefix("unusual disk layout"))
        // Recovery before macOS (wrong order).
        var wrongOrder = FakeMac.standard()
        let rec = wrongOrder.partitions.removeLast()
        wrongOrder.partitions.insert(rec, at: 1)
        XCTAssertEqual(check("space", wrongOrder).status, .fail)
        var noSystem = FakeMac.standard()
        noSystem.macHasSystem = false
        XCTAssertEqual(check("space", noSystem).status, .fail)
    }

    func testDiskUnreadable() {
        var mac = FakeMac.standard()
        mac.text["x"] = nil
        let probe = DictProbe(files: mac.files.filter { $0.key != "diskutil-list.plist" })
        let r = Preflight(probe: probe, now: fixtureNow, timeZone: utc).run()
        XCTAssertEqual(r.checks.first { $0.id == "disk" }?.status, .fail)
        XCTAssertNil(r.layout)
    }

    func testExistingInstalls() {
        let ours = check("existing", FakeMac.standard(installed: true))
        XCTAssertEqual(ours.status, .warn)
        XCTAssertTrue(ours.summary.hasPrefix("AI UI OS is already installed"))
        let asahi = FakeMac.standard(extraBetween: [
            .init(id: "disk0s4", content: "Apple_APFS", size: Size.stub, name: ""),
            .init(id: "disk0s5", content: "EFI", size: 500_000_000, name: "EFI - FEDOR"),
            .init(id: "disk0s6", content: "Linux Filesystem", size: Size.gb),
            .init(id: "disk0s7", content: "Microsoft Basic Data", size: Size.gb),
        ])
        let other = check("existing", asahi)
        XCTAssertEqual(other.status, .warn)
        let kinds = (other.data["partitions"] as! [[String: Any]]).map { $0["kind"] as! String }
        XCTAssertEqual(kinds, ["other-macos-or-stub", "linux", "linux", "foreign"])
        XCTAssertTrue(other.summary.contains("left alone"))
    }

    func testFileVault() {
        XCTAssertEqual(check("filevault", withText("fdesetup-status.txt", "FileVault is Off.\n")).data["on"] as? Bool, false)
        XCTAssertEqual(check("filevault", withText("fdesetup-status.txt", "Encryption in progress: Percent completed = 12")).status, .warn)
        XCTAssertEqual(check("filevault", withText("fdesetup-status.txt", nil)).summary, "could not read the FileVault status")
    }

    func testPower() {
        let battery = check("power", withText("pmset-batt.txt", "Now drawing from 'Battery Power'\n -InternalBattery-0\t35%; discharging"))
        XCTAssertEqual(battery.status, .fail)
        XCTAssertEqual(battery.summary, "on battery, battery 35%: connect the power adapter")
        let desktop = check("power", withText("pmset-batt.txt", "Now drawing from 'AC Power'\n"))
        XCTAssertEqual(desktop.summary, "on AC power")
        XCTAssertEqual(check("power", withText("pmset-batt.txt", nil)).status, .warn)
    }

    func testBackupAge() {
        func backup(_ stamp: String) -> Check { check("backup", withText("tmutil-latestbackup.txt", "/Volumes/TM/\(stamp).backup")) }
        XCTAssertEqual(backup("2026-11-16-100000").status, .ok)
        XCTAssertEqual(backup("2026-11-16-130000").data["ageHours"] as? Int, 0, "a clock skew is not a negative age")
        let days = backup("2026-11-13-120000")
        XCTAssertEqual(days.status, .warn)
        XCTAssertTrue(days.summary.contains("3 days ago"))
        XCTAssertEqual(backup("2026-10-01-120000").status, .fail)
        XCTAssertEqual(check("backup", withText("tmutil-latestbackup.txt", nil)).status, .fail)
    }
}
