import XCTest
import CoreWLAN
import CoreLocation
@testable import AIUI

/// A stand-in Wi-Fi interface: nothing here reaches the real CoreWLAN hardware calls.
final class FakeWiFi: CWInterface {
    var name: String? = "en7"
    var current: String?
    var on = true
    var found: [CWNetwork] = []
    var scanError: Error?
    var associateError: Error?
    var powerError: Error?
    var joined: [(ssid: String?, password: String?)] = []
    var powered: [Bool] = []

    override var interfaceName: String? { name }
    override func ssid() -> String? { current }
    override func powerOn() -> Bool { on }
    override func rssiValue() -> Int { -42 }
    override func scanForNetworks(withName networkName: String?) throws -> Set<CWNetwork> {
        if let scanError { throw scanError }
        return Set(found)
    }
    override func associate(to network: CWNetwork, password: String?) throws {
        joined.append((network.ssid, password))
        if let associateError { throw associateError }
        current = network.ssid
    }
    override func setPower(_ power: Bool) throws {
        if let powerError { throw powerError }
        powered.append(power); on = power
    }
}

final class FakeChannel: CWChannel {
    let band: CWChannelBand
    init(_ band: CWChannelBand) { self.band = band; super.init() }
    required init?(coder: NSCoder) { fatalError() }
    override var channelBand: CWChannelBand { band }
}

final class FakeNetwork: CWNetwork {
    let name: String?, rssi: Int, open: Bool, channel: CWChannel?
    init(_ name: String?, _ rssi: Int, open: Bool = false, band: CWChannelBand? = .band2GHz) {
        self.name = name; self.rssi = rssi; self.open = open; channel = band.map(FakeChannel.init)
        super.init()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var ssid: String? { name }
    override var rssiValue: Int { rssi }
    override var wlanChannel: CWChannel? { channel }
    override func supportsSecurity(_ security: CWSecurity) -> Bool { security == .none ? open : !open }
    override func isEqual(_ object: Any?) -> Bool { (object as AnyObject?) === self }
    override var hash: Int { ObjectIdentifier(self).hashValue }
}

final class LiveTests: AIUITestCase {
    private let net = NetworkControl.shared
    private var wifi: FakeWiFi!
    private var savedAuth: (() -> CLAuthorizationStatus)!
    private var savedRequest: (() -> Void)!
    private var savedRun: ((String, [String]) -> String)!
    private var auth: CLAuthorizationStatus = .authorizedAlways
    private var requested = 0
    private var commands: [[String]] = []
    private var networksetupReply = ""

    override func setUp() {
        super.setUp()
        savedAuth = net.authorization; savedRequest = net.requestLocation; savedRun = NetworkControl.run
        wifi = FakeWiFi()
        let w = wifi!
        net.interface = { w }
        net.authorization = { [unowned self] in auth }
        net.requestLocation = { [unowned self] in requested += 1 }
        NetworkControl.run = { [unowned self] path, args in
            XCTAssertEqual(path, "/usr/sbin/networksetup")
            commands.append(args)
            if args.first == "-listpreferredwirelessnetworks" { return "Preferred networks on en7:\n\tHome\n\t  \n\tCafe\n" }
            return networksetupReply
        }
    }

    override func tearDown() {
        net.interface = { nil }
        net.authorization = savedAuth; net.requestLocation = savedRequest; NetworkControl.run = savedRun
        super.tearDown()
    }

    func testDefaultsAreTheRealOnes() {
        let fresh = NetworkControl()
        _ = fresh.interface
        let s = fresh.authorization()
        XCTAssertEqual(fresh.locationAllowed, s == .authorizedAlways || s == .authorized)
        _ = fresh.requestLocation   // built, never called: no permission prompt in tests
    }

    func testStatusWithoutAndWithWiFi() {
        net.interface = { nil }
        var s = net.status()
        XCTAssertEqual(s["wifi"] as? Bool, false)
        XCTAssertNil(s["power"])
        XCTAssertNotNil(s["addresses"] as? [[String: String]])

        net.interface = { [wifi] in wifi }
        wifi.current = "Home"
        s = net.status()
        XCTAssertEqual(s["wifi"] as? Bool, true)
        XCTAssertEqual(s["power"] as? Bool, true)
        XCTAssertEqual(s["ssid"] as? String, "Home")
        XCTAssertEqual(s["rssi"] as? Int, -42)
        XCTAssertEqual(s["interface"] as? String, "en7")
        XCTAssertEqual(s["locationAllowed"] as? Bool, true)

        wifi.current = nil; wifi.name = nil
        auth = .denied
        s = net.status()
        XCTAssertNil(s["ssid"])
        XCTAssertEqual(s["interface"] as? String, "en0")
        XCTAssertEqual(s["locationAllowed"] as? Bool, false)
        auth = .authorized
        XCTAssertTrue(net.locationAllowed)
    }

    func testScanListsTheStrongestOfEachNetwork() {
        net.interface = { nil }
        XCTAssertEqual(net.scan()["error"] as? String, "no Wi-Fi interface")
        net.interface = { [wifi] in wifi }

        wifi.current = "Home"
        wifi.found = [
            FakeNetwork("Home", -70), FakeNetwork("Home", -40, band: .band5GHz), FakeNetwork("Home", -80),
            FakeNetwork("Cafe", -60, open: true, band: nil),
            FakeNetwork("Six", -50, band: .band6GHz),
            FakeNetwork("", -10), FakeNetwork(nil, -10),
        ]
        let r = net.scan()
        let list = r["networks"] as? [[String: Any]] ?? []
        XCTAssertEqual(list.map { $0["ssid"] as? String }, ["Home", "Six", "Cafe"])
        XCTAssertEqual(list[0]["rssi"] as? Int, -40)
        XCTAssertEqual(list[0]["band"] as? String, "5 GHz")
        XCTAssertEqual(list[0]["known"] as? Bool, true)
        XCTAssertEqual(list[0]["current"] as? Bool, true)
        XCTAssertEqual(list[0]["secure"] as? Bool, true)
        XCTAssertEqual(list[1]["band"] as? String, "6 GHz")
        XCTAssertEqual(list[1]["known"] as? Bool, false)
        XCTAssertEqual(list[2]["band"] as? String, "")
        XCTAssertEqual(list[2]["secure"] as? Bool, false)
        XCTAssertEqual(list[2]["known"] as? Bool, true)
        XCTAssertEqual(r["hidden"] as? Bool, false)
        XCTAssertEqual(commands.last, ["-listpreferredwirelessnetworks", "en7"])
        XCTAssertEqual(requested, 0)

        // Without Location permission: names are hidden and permission is asked for.
        auth = .notDetermined
        wifi.found = [FakeNetwork(nil, -30)]
        wifi.name = nil
        let hidden = net.scan()
        XCTAssertEqual(hidden["hidden"] as? Bool, true)
        XCTAssertEqual(hidden["locationAllowed"] as? Bool, false)
        XCTAssertEqual(commands.last, ["-listpreferredwirelessnetworks", "en0"])
        waitUntil { self.requested == 1 }

        wifi.found = [FakeNetwork("Plain", -50, band: .band2GHz)]
        XCTAssertEqual((net.scan()["networks"] as? [[String: Any]])?.first?["band"] as? String, "2.4 GHz")

        wifi.scanError = NSError(domain: "wifi", code: 1, userInfo: [NSLocalizedDescriptionKey: "scan failed"])
        let failed = net.scan()
        XCTAssertEqual(failed["error"] as? String, "scan failed")
        XCTAssertEqual((failed["networks"] as? [Any])?.count, 0)
    }

    func testConnect() {
        net.interface = { nil }
        XCTAssertEqual(net.connect("Home", password: nil)["error"] as? String, "no Wi-Fi interface")
        net.interface = { [wifi] in wifi }

        wifi.current = "Home"
        let already = net.connect("Home", password: nil)
        XCTAssertEqual(already["already"] as? Bool, true)
        XCTAssertEqual((already["status"] as? [String: Any])?["ssid"] as? String, "Home")

        // Not scanned yet: a scan finds it, then it is joined (empty password = none).
        wifi.current = nil
        wifi.found = [FakeNetwork("Cafe", -50, open: true), FakeNetwork("Work", -60)]
        let joined = net.connect("Cafe", password: "")
        XCTAssertEqual(joined["ok"] as? Bool, true)
        XCTAssertEqual(wifi.joined.last?.ssid, "Cafe")
        XCTAssertNil(wifi.joined.last?.password ?? nil)
        XCTAssertEqual((joined["status"] as? [String: Any])?["ssid"] as? String, "Cafe")

        let scans = commands.count
        _ = net.connect("Work", password: "pw")
        XCTAssertEqual(wifi.joined.last?.password, "pw")
        XCTAssertEqual(commands.count, scans, "a scanned network is joined without scanning again")
        wifi.current = nil

        // Association fails with a password: the error is returned.
        wifi.associateError = NSError(domain: "wifi", code: 2, userInfo: [NSLocalizedDescriptionKey: "wrong password"])
        let wrong = net.connect("Work", password: "bad")
        XCTAssertEqual(wrong["ok"] as? Bool, false)
        XCTAssertEqual(wrong["error"] as? String, "wrong password")

        // Without a password: networksetup tries the saved one; a secured network then needs a password.
        networksetupReply = "Could not find network Work.\n"
        let needs = net.connect("Work", password: nil)
        XCTAssertEqual(needs["ok"] as? Bool, false)
        XCTAssertEqual(needs["needsPassword"] as? Bool, true)
        XCTAssertEqual(needs["error"] as? String, "Could not find network Work.")
        XCTAssertEqual(commands.last, ["-setairportnetwork", "en7", "Work"])
        let openFail = net.connect("Cafe", password: "")
        XCTAssertNil(openFail["needsPassword"])
        networksetupReply = ""
        let viaTool = net.connect("Work", password: nil)
        XCTAssertEqual(viaTool["ok"] as? Bool, true)
        XCTAssertNil(viaTool["needsPassword"])

        // Not seen by any scan: networksetup joins by name, with the password.
        wifi.name = nil
        networksetupReply = "Error: -3900"
        let unseen = net.connect("Hidden", password: "secret")
        XCTAssertEqual(unseen["ok"] as? Bool, false)
        XCTAssertEqual(commands.last, ["-setairportnetwork", "en0", "Hidden", "secret"])
        networksetupReply = ""
        XCTAssertEqual(net.connect("Hidden2", password: "")["ok"] as? Bool, true)
        XCTAssertEqual(commands.last, ["-setairportnetwork", "en0", "Hidden2"])
    }

    func testPower() {
        let off = net.power(false)
        XCTAssertEqual(off["ok"] as? Bool, true)
        XCTAssertEqual(wifi.powered, [false])
        XCTAssertEqual((off["status"] as? [String: Any])?["power"] as? Bool, false)
        wifi.powerError = NSError(domain: "wifi", code: 3, userInfo: [NSLocalizedDescriptionKey: "no power"])
        XCTAssertEqual(net.power(true)["error"] as? String, "no power")
    }

    func testAskLocationRequestsOnTheMainQueue() {
        net.askLocation()
        XCTAssertEqual(requested, 0)
        waitUntil { self.requested == 1 }
    }

    func testRunProcess() {
        XCTAssertEqual(NetworkControl.runProcess("/bin/sh", ["-c", "echo out; echo err >&2"]), "out\nerr\n")
        XCTAssertFalse(NetworkControl.runProcess("/nonexistent/networksetup", []).isEmpty)
        // The default runner is runProcess (used here on a harmless command, never networksetup).
        XCTAssertEqual(savedRun("/bin/echo", ["default"]), "default\n")
    }

    func testAddressesAndLiveStats() {
        let addrs = NetworkControl.addresses()
        for a in addrs {
            XCTAssertNotEqual(a["ip"], "127.0.0.1")
            XCTAssertEqual(a["ip"]?.split(separator: ".").count, 4)
            XCTAssertNotNil(a["name"])
        }
        let p = LiveStats.process()
        XCTAssertGreaterThanOrEqual(p["uptime"] as? Double ?? -1, 0)
        XCTAssertEqual(p["cores"] as? Int, ProcessInfo.processInfo.activeProcessorCount)
        XCTAssertEqual(p["memoryTotal"] as? UInt64, ProcessInfo.processInfo.physicalMemory)
        XCTAssertEqual((p["load"] as? [Double])?.count, 3)
        XCTAssertGreaterThan(p["memory"] as? UInt64 ?? 0, 0)
        XCTAssertNotNil(p["diskFree"])
    }
}
