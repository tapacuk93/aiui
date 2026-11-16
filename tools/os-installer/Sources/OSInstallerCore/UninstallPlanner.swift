import Foundation

public enum UninstallError: Error, Equatable, CustomStringConvertible {
    case refused(String)
    public var description: String {
        switch self { case .refused(let why): return "refused: \(why)" }
    }
}

/// Plans the removal of AI UI OS (docs/os-plan.md §1.4). A partition is deleted only when it is
/// proven ours: listed in the install marker (GUID and name) AND physically between the macOS
/// container and the Recovery partition. Anything else in that region makes it refuse entirely.
public enum UninstallPlanner {
    public static func plan(layout: DiskLayout, marker: InstallMarker) throws -> Plan {
        guard let mac = layout.macPartition, let recovery = layout.recoveryPartition, recovery.offset >= mac.end else {
            throw UninstallError.refused("unusual disk layout: no macOS container followed by a Recovery partition")
        }
        guard marker.disk == .init(mediaName: layout.mediaName, size: layout.size) else {
            throw UninstallError.refused("the install marker belongs to another disk (\(marker.disk.mediaName))")
        }
        guard marker.partitions.filter({ $0.role == "stub" }).count == 1, marker.partitions.count >= 2 else {
            throw UninstallError.refused("the install marker must list one stub and the OS partitions")
        }
        let protectedIDs = Set(layout.partitions.filter {
            $0.content == PartitionType.isc || $0.content == PartitionType.recovery || $0.id == mac.id
        }.map(\.id)).union(SafetyGuard.neverTouch)
        let region = layout.between.map(\.id)

        var ours: [(role: String, partition: Partition)] = []
        for entry in marker.partitions {
            guard let p = layout.partitions.first(where: { $0.uuid == entry.partitionUUID.uppercased() }) else {
                throw UninstallError.refused("\(entry.name) (\(entry.partitionUUID)) is in the marker but not on the disk; nothing was changed")
            }
            guard !protectedIDs.contains(p.id) else {
                throw UninstallError.refused("the marker names \(p.id), a partition that is never deleted")
            }
            guard region.contains(p.id) else {
                throw UninstallError.refused("\(p.id) is not between macOS (\(mac.id)) and Recovery (\(recovery.id))")
            }
            guard p.name == entry.name, Ownership.isOurs(p) else {
                throw UninstallError.refused("\(p.id) is named \"\(p.name)\", not \"\(entry.name)\"")
            }
            let typeOK: Bool
            switch entry.role {
            case "stub": typeOK = p.content == PartitionType.apfs
            case "esp": typeOK = PartitionType.isEFI(p.content)
            default: typeOK = PartitionType.isLinux(p.content)
            }
            guard typeOK else { throw UninstallError.refused("\(p.id) has type \(p.content), unexpected for \(entry.role)") }
            ours.append((entry.role, p))
        }
        let ourIDs = Set(ours.map(\.partition.id))
        if let foreign = layout.between.first(where: { !ourIDs.contains($0.id) }) {
            throw UninstallError.refused("\(foreign.id) (\(foreign.content)) between macOS and Recovery is not ours; remove it yourself first")
        }

        var steps: [Step] = [.command(["bless", "--mount", "/", "--setBoot"], "make macOS the default startup disk again")]
        for (role, p) in ours.sorted(by: { $0.partition.offset < $1.partition.offset }) {
            if role == "stub" {
                steps.append(.command(["diskutil", "apfs", "deleteContainer", p.id], "delete the AI UI OS stub container (\(p.name))"))
            } else {
                steps.append(.command(["diskutil", "eraseVolume", "free", "free", p.id], "free \(p.name)"))
            }
        }
        steps.append(.command(["diskutil", "apfs", "resizeContainer", mac.id, "0"], "grow macOS back over the freed space"))

        var plan = Plan(kind: .uninstall, steps: steps, macPartition: mac.id, protected: protectedIDs.sorted())
        plan.details = [
            "partitions": ours.map { ["role": $0.role, "id": $0.partition.id, "name": $0.partition.name, "size": $0.partition.size] },
            "reclaimed": ours.reduce(0) { $0 + $1.partition.size },
            "ifResizeFails": "start up in recoveryOS, unlock Macintosh HD in Disk Utility, then run: diskutil repairVolume \(mac.id)",
        ]
        return plan
    }

    /// Finds the marker: an explicit file, else the mounted EFI partitions between macOS and Recovery.
    public static func findMarker(layout: DiskLayout, explicit: String?, read: (String) -> Data?) throws -> InstallMarker {
        if let explicit {
            guard let data = read(explicit) else { throw UninstallError.refused("cannot read \(explicit)") }
            return try InstallMarker.decode(data)
        }
        let esps = layout.between.filter { PartitionType.isEFI($0.content) }
        for esp in esps {
            if let mount = esp.mountPoint, let data = read(mount + "/" + InstallMarker.pathInESP) {
                return try InstallMarker.decode(data)
            }
        }
        let hint = esps.map { "diskutil mount \($0.id)" }.joined(separator: " or ")
        throw UninstallError.refused("no AI UI OS install marker found" + (hint.isEmpty ? "" : "; mount the EFI partition first (\(hint)) or pass --marker"))
    }
}
