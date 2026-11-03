import Foundation
#if os(macOS)
import CoreWLAN
import CoreLocation
#endif

/// Networks (⌘N: connect to a network) and live numbers for the activity screen (⌘I).
/// On macOS, Wi-Fi goes through CoreWLAN; network names need Location permission, asked once.
final class NetworkControl: NSObject {
    static let shared = NetworkControl()

    #if os(macOS)
    private let location = CLLocationManager()
    private var scanned: [String: CWNetwork] = [:]
    private var iface: CWInterface? { CWWiFiClient.shared().interface() }

    /// Location permission (macOS shows network names only with it).
    var locationAllowed: Bool {
        let s = location.authorizationStatus
        return s == .authorizedAlways || s == .authorized
    }
    func askLocation() {
        DispatchQueue.main.async { self.location.requestWhenInUseAuthorization() }
    }

    func status() -> [String: Any] {
        var r: [String: Any] = ["wifi": iface != nil, "addresses": Self.addresses(), "locationAllowed": locationAllowed]
        if let i = iface {
            r["power"] = i.powerOn()
            if let s = i.ssid() { r["ssid"] = s }
            r["rssi"] = i.rssiValue()
            r["interface"] = i.interfaceName ?? "en0"
        }
        return r
    }

    /// Nearby networks, strongest first, with the known ones (saved by macOS) marked.
    func scan() -> [String: Any] {
        guard let i = iface else { return ["networks": [], "error": "no Wi-Fi interface"] }
        if !locationAllowed { askLocation() }
        let known = Self.knownNetworks(i.interfaceName ?? "en0")
        var best: [String: CWNetwork] = [:]
        do {
            for n in try i.scanForNetworks(withName: nil) {
                guard let ssid = n.ssid, !ssid.isEmpty else { continue }
                if let b = best[ssid], b.rssiValue >= n.rssiValue { continue }
                best[ssid] = n
            }
        } catch { return ["networks": [], "error": error.localizedDescription, "locationAllowed": locationAllowed] }
        scanned = best
        let current = i.ssid()
        let list = best.values.sorted { $0.rssiValue > $1.rssiValue }.map { n -> [String: Any] in
            let ssid = n.ssid ?? ""
            return ["ssid": ssid, "rssi": n.rssiValue, "secure": !n.supportsSecurity(.none), "known": known.contains(ssid),
                    "current": ssid == current, "band": n.wlanChannel.map { $0.channelBand == .band5GHz ? "5 GHz" : $0.channelBand == .band6GHz ? "6 GHz" : "2.4 GHz" } ?? ""]
        }
        return ["networks": list, "locationAllowed": locationAllowed, "hidden": best.isEmpty]
    }

    /// Joins a network: a password for a new secured one; a known one uses the saved password.
    func connect(_ ssid: String, password: String?) -> [String: Any] {
        guard let i = iface else { return ["ok": false, "error": "no Wi-Fi interface"] }
        if i.ssid() == ssid { return ["ok": true, "already": true, "status": status()] }   // already on it
        if scanned[ssid] == nil { _ = scan() }
        if let n = scanned[ssid] {
            do {
                try i.associate(to: n, password: (password?.isEmpty ?? true) ? nil : password)
                return ["ok": true, "status": status()]
            } catch {
                if password == nil || password!.isEmpty {
                    var r = Self.networksetup(i.interfaceName ?? "en0", ssid, nil)
                    // A secured network whose saved password macOS won't hand to the app: ask for it.
                    if (r["ok"] as? Bool) != true, !n.supportsSecurity(.none) { r["needsPassword"] = true }
                    return r
                }
                return ["ok": false, "error": error.localizedDescription]
            }
        }
        // Not seen by the scan (no Location permission): networksetup can still join by name.
        return Self.networksetup(i.interfaceName ?? "en0", ssid, password)
    }

    func power(_ on: Bool) -> [String: Any] {
        do { try iface?.setPower(on); return ["ok": true, "status": status()] }
        catch { return ["ok": false, "error": error.localizedDescription] }
    }

    private static func networksetup(_ dev: String, _ ssid: String, _ password: String?) -> [String: Any] {
        var args = ["-setairportnetwork", dev, ssid]
        if let password, !password.isEmpty { args.append(password) }
        let out = run("/usr/sbin/networksetup", args)
        let failed = out.lowercased().contains("could not") || out.lowercased().contains("error")
        return failed ? ["ok": false, "error": out.trimmingCharacters(in: .whitespacesAndNewlines)] : ["ok": true, "status": NetworkControl.shared.status()]
    }

    private static func knownNetworks(_ dev: String) -> Set<String> {
        let out = run("/usr/sbin/networksetup", ["-listpreferredwirelessnetworks", dev])
        return Set(out.split(separator: "\n").dropFirst().map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }

    private static func run(_ path: String, _ args: [String]) -> String {
        let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
        do { try p.run() } catch { return error.localizedDescription }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }
    #else
    func status() -> [String: Any] { ["wifi": false, "addresses": Self.addresses()] }
    func scan() -> [String: Any] { ["networks": [], "error": "Wi-Fi is managed by the system on this device"] }
    func connect(_ ssid: String, password: String?) -> [String: Any] { ["ok": false, "error": "not available on this device"] }
    func power(_ on: Bool) -> [String: Any] { ["ok": false, "error": "not available on this device"] }
    #endif

    /// IPv4 addresses of the interfaces that are up (loopback excluded).
    static func addresses() -> [[String: String]] {
        var out: [[String: String]] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
        defer { freeifaddrs(ifaddr) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let a = p.pointee
            guard let sa = a.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET), (a.ifa_flags & UInt32(IFF_LOOPBACK)) == 0,
                  (a.ifa_flags & UInt32(IFF_UP)) != 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                out.append(["name": String(cString: a.ifa_name), "ip": String(cString: host)])
            }
        }
        return out
    }
}

/// Live numbers of this process and machine for the activity screen.
enum LiveStats {
    static let started = Date()

    static func process() -> [String: Any] {
        var r: [String: Any] = ["uptime": Date().timeIntervalSince(started), "cores": ProcessInfo.processInfo.activeProcessorCount,
                                "memoryTotal": ProcessInfo.processInfo.physicalMemory]
        var loads = [Double](repeating: 0, count: 3)
        if getloadavg(&loads, 3) == 3 { r["load"] = loads }
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
        }
        if kr == KERN_SUCCESS { r["memory"] = info.resident_size }
        if let free = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage {
            r["diskFree"] = free
        }
        return r
    }
}
