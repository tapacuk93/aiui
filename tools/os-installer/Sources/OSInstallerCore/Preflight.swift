import Foundation

public enum Status: String {
    case ok, warn, fail
}

public struct Check {
    public var id: String
    public var status: Status
    public var summary: String
    public var notes: [String] = []
    public var data: [String: Any] = [:]

    var json: [String: Any] {
        ["id": id, "status": status.rawValue, "summary": summary, "notes": notes, "data": data]
    }
}

/// Boards the Asahi installer supports (non-expert), from upstream `src/main.py`. M1 and M2 families;
/// M3 and later are not supported yet. `j313ap` is our reference machine (docs/os-plan.md §0).
public enum Devices {
    public static let supported: [String: String] = [
        "j274ap": "Mac mini (M1, 2020)",
        "j293ap": "MacBook Pro (13-inch, M1, 2020)",
        "j313ap": "MacBook Air (M1, 2020)",
        "j456ap": "iMac (24-inch, M1, 2021, four ports)",
        "j457ap": "iMac (24-inch, M1, 2021, two ports)",
        "j314sap": "MacBook Pro (14-inch, M1 Pro, 2021)",
        "j314cap": "MacBook Pro (14-inch, M1 Max, 2021)",
        "j316sap": "MacBook Pro (16-inch, M1 Pro, 2021)",
        "j316cap": "MacBook Pro (16-inch, M1 Max, 2021)",
        "j375cap": "Mac Studio (M1 Max, 2022)",
        "j375dap": "Mac Studio (M1 Ultra, 2022)",
        "j413ap": "MacBook Air (M2, 2022)",
        "j415ap": "MacBook Air (15-inch, M2, 2023)",
        "j493ap": "MacBook Pro (13-inch, M2, 2022)",
        "j473ap": "Mac mini (M2, 2023)",
        "j474sap": "Mac mini (M2 Pro, 2023)",
        "j414sap": "MacBook Pro (14-inch, M2 Pro, 2023)",
        "j414cap": "MacBook Pro (14-inch, M2 Max, 2023)",
        "j416sap": "MacBook Pro (16-inch, M2 Pro, 2023)",
        "j416cap": "MacBook Pro (16-inch, M2 Max, 2023)",
        "j475cap": "Mac Studio (M2 Max, 2023)",
        "j475dap": "Mac Studio (M2 Ultra, 2023)",
        "j180dap": "Mac Pro (M2 Ultra, 2023)",
    ]
    public static let reference = "j313ap"
}

/// Marks partitions an AI UI OS install creates (docs/os-plan.md §1.7).
public enum Ownership {
    public static let product = "AI UI OS"
    public static let suffix = " - AI UI OS"
    public static func name(_ base: String) -> String { base + suffix }
    public static func isOurs(_ p: Partition) -> Bool { p.name.hasSuffix(suffix) }
}

/// The M0 preflight: can this Mac run AI UI OS, and what must the user do first?
public struct Preflight {
    public var probe: Probe
    public var now: Date
    public var timeZone: TimeZone
    public var target: UInt64

    public init(probe: Probe, now: Date, timeZone: TimeZone = .current, target: UInt64 = Size.target) {
        self.probe = probe
        self.now = now
        self.timeZone = timeZone
        self.target = target
    }

    public struct Report {
        public var checks: [Check]
        public var layout: DiskLayout?
        public var ready: Bool { !checks.contains { $0.status == .fail } }
        public var json: [String: Any] { ["ready": ready, "checks": checks.map(\.json)] }
    }

    public func run() -> Report {
        var checks = [model(), macOS()]
        var layout: DiskLayout?
        do {
            let l = try DiskLayout.load(from: probe)
            layout = l
            checks += [Preflight.space(l, target: target), Preflight.existing(l)]
        } catch {
            checks.append(Check(id: "disk", status: .fail, summary: "\(error)"))
        }
        checks += [fileVault(), power(), backup()]
        return Report(checks: checks, layout: layout)
    }

    func model() -> Check {
        let model = probe.text(.hwModel)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown"
        let board = probe.text(.platform).flatMap(Preflight.board)
        guard let board else {
            return Check(id: "model", status: .fail, summary: "\(model): not an Apple silicon Mac",
                         data: ["model": model])
        }
        guard let name = Devices.supported[board] else {
            return Check(id: "model", status: .fail,
                         summary: "\(model) (\(board)) is not supported yet (M1 and M2 Macs are)",
                         data: ["model": model, "board": board])
        }
        var check = Check(id: "model", status: .ok, summary: "\(name), \(board): supported",
                          data: ["model": model, "board": board])
        check.notes = [
            "Touch ID and external displays over USB-C do not work in AI UI OS; unlock with a password",
        ]
        if board == Devices.reference { check.notes.append("this is the reference machine AI UI OS is tested on") }
        return check
    }

    /// First entry of the platform `compatible` list, lower-cased: `"J313AP"` → `j313ap`.
    static func board(_ ioreg: String) -> String? {
        guard let range = ioreg.range(of: #""compatible" = <"([A-Za-z0-9]+)""#, options: .regularExpression) else { return nil }
        let match = ioreg[range]
        return match.split(separator: "\"").last!.lowercased()
    }

    func macOS() -> Check {
        let text = probe.text(.swVers) ?? ""
        let version = Preflight.field(text, "ProductVersion") ?? ""
        let build = Preflight.field(text, "BuildVersion") ?? ""
        let parts = version.split(separator: ".").compactMap { Int($0) }
        guard parts.count >= 2 else {
            return Check(id: "macos", status: .fail, summary: "could not read the macOS version")
        }
        let data: [String: Any] = ["version": version, "build": build]
        if (parts[0], parts[1]) < (13, 5) {
            return Check(id: "macos", status: .fail, summary: "macOS \(version): update to macOS 13.5 or later first", data: data)
        }
        var check = Check(id: "macos", status: .ok, summary: "macOS \(version) (\(build))", data: data)
        if parts[0] >= 27 {
            check.notes = [
                "macOS 27 hides installs without the APFS bootable flag: the installer sets it (and can repair it)",
                "macOS 27 firmware needs a Linux kernel 7.0.12 or later for the battery; AI UI OS pins it",
                "check AI UI OS compatibility before each macOS update",
            ]
        }
        return check
    }

    static func field(_ text: String, _ key: String) -> String? {
        for line in text.split(separator: "\n") where line.hasPrefix(key + ":") {
            return line.dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    /// Space: the macOS container must keep 38 GB free after giving AI UI OS its size.
    public static func space(_ layout: DiskLayout, target: UInt64) -> Check {
        guard let mac = layout.macPartition, let container = layout.container(onStore: mac.id),
              let recovery = layout.recoveryPartition, recovery.offset >= mac.end else {
            return Check(id: "space", status: .fail,
                         summary: "unusual disk layout: no macOS container followed by a Recovery partition")
        }
        let available = container.free + layout.gapAfterMac
        let needed = target + Size.minFreeMacOS
        let shortfall = needed > available ? needed - available : 0
        let data: [String: Any] = [
            "macPartition": mac.id, "containerFree": container.free, "unallocatedAfterMacOS": layout.gapAfterMac,
            "available": available, "needed": needed, "target": target, "minFreeMacOS": Size.minFreeMacOS,
            "toFree": shortfall,
        ]
        let summary = "\(Size.gbText(available)) free, \(Size.gbText(needed)) needed (\(Size.gbText(target)) for AI UI OS + \(Size.gbText(Size.minFreeMacOS)) kept free for macOS)"
        if shortfall > 0 {
            var check = Check(id: "space", status: .fail, summary: "free \(Size.gbText(shortfall)) in macOS first: " + summary, data: data)
            check.notes = ["empty the Trash and check Storage settings; free space shows up here at once"]
            return check
        }
        return Check(id: "space", status: .ok, summary: summary, data: data)
    }

    /// Other operating systems already on the disk (AI UI OS, Asahi, other Linux, another macOS).
    public static func existing(_ layout: DiskLayout) -> Check {
        let mac = layout.macPartition?.id
        var found: [[String: Any]] = []
        for p in layout.partitions where p.id != mac {
            let kind: String
            if Ownership.isOurs(p) {
                kind = "aiui-os"
            } else if p.content == PartitionType.apfs {
                kind = "other-macos-or-stub"
            } else if PartitionType.isEFI(p.content) || PartitionType.isLinux(p.content) {
                kind = "linux"
            } else if p.content == PartitionType.isc || p.content == PartitionType.recovery {
                continue
            } else {
                kind = "foreign"
            }
            found.append(["id": p.id, "kind": kind, "content": p.content, "name": p.name, "size": p.size])
        }
        let ours = found.contains { $0["kind"] as? String == "aiui-os" }
        if found.isEmpty {
            return Check(id: "existing", status: .ok, summary: "no other operating systems on the disk", data: ["partitions": found])
        }
        let summary = ours
            ? "AI UI OS is already installed: uninstall it before installing again"
            : "other systems found (\(found.count) partitions): they are left alone"
        return Check(id: "existing", status: .warn, summary: summary, data: ["partitions": found])
    }

    func fileVault() -> Check {
        let text = probe.text(.fileVault)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.hasPrefix("FileVault is On") {
            return Check(id: "filevault", status: .ok, summary: "FileVault on", notes: [
                "macOS stays encrypted; if growing macOS back ever fails, the recoveryOS repair needs the disk unlocked first",
            ], data: ["on": true])
        }
        if text.hasPrefix("FileVault is Off") {
            return Check(id: "filevault", status: .ok, summary: "FileVault off", data: ["on": false])
        }
        return Check(id: "filevault", status: .warn,
                     summary: text.isEmpty ? "could not read the FileVault status" : "FileVault is busy (\(text)): wait until it finishes")
    }

    func power() -> Check {
        guard let text = probe.text(.battery) else {
            return Check(id: "power", status: .warn, summary: "could not read the power source")
        }
        let onAC = text.contains("'AC Power'")
        var data: [String: Any] = ["ac": onAC]
        var percentText = ""
        if let r = text.range(of: #"[0-9]+%"#, options: .regularExpression) {
            let percent = Int(text[r].dropLast())!
            data["battery"] = percent
            percentText = ", battery \(percent)%"
        }
        if onAC { return Check(id: "power", status: .ok, summary: "on AC power" + percentText, data: data) }
        return Check(id: "power", status: .fail, summary: "on battery\(percentText): connect the power adapter", data: data)
    }

    func backup() -> Check {
        let text = probe.text(.latestBackup) ?? ""
        guard let r = text.range(of: #"[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}"#, options: .regularExpression) else {
            return Check(id: "backup", status: .fail,
                         summary: "no Time Machine backup found: back up the Mac first",
                         notes: ["if a backup exists, give the app Full Disk Access so it can see it"])
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        let date = formatter.date(from: String(text[r]))!
        let hours = max(0, now.timeIntervalSince(date) / 3600)
        let data: [String: Any] = ["latest": String(text[r]), "ageHours": Int(hours)]
        if hours <= 24 { return Check(id: "backup", status: .ok, summary: "last Time Machine backup \(Int(hours)) h ago", data: data) }
        let days = Int(hours / 24)
        if days < 7 {
            return Check(id: "backup", status: .warn, summary: "last Time Machine backup \(days) days ago: back up again right before installing", data: data)
        }
        return Check(id: "backup", status: .fail, summary: "last Time Machine backup \(days) days ago: back up the Mac first", data: data)
    }
}
