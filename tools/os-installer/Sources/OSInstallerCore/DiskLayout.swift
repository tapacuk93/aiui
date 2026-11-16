import Foundation

/// Partition type names as `diskutil` reports them (`Content`), and the GPT type GUIDs we create.
public enum PartitionType {
    public static let isc = "Apple_APFS_ISC"
    public static let apfs = "Apple_APFS"
    public static let recovery = "Apple_APFS_Recovery"
    public static let efiGUID = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
    public static let linuxGUID = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"

    public static func isEFI(_ content: String) -> Bool {
        content == "EFI" || content.uppercased() == efiGUID
    }
    public static func isLinux(_ content: String) -> Bool {
        content == "Linux Filesystem" || content == "Linux" || content.uppercased() == linuxGUID
    }
}

/// One partition of the internal disk, in physical order.
public struct Partition: Equatable {
    public var id: String
    public var content: String
    public var size: UInt64
    public var offset: UInt64
    /// GPT unique partition GUID (`DiskUUID`).
    public var uuid: String
    /// GPT partition name (`MediaName` in `diskutil info`).
    public var name: String
    public var mountPoint: String?
    public var end: UInt64 { offset + size }
}

public struct Volume: Equatable {
    public var id: String
    public var name: String
    public var roles: [String]
    public var fileVault: Bool
}

public struct Container: Equatable {
    public var ref: String
    public var physicalStore: String
    public var ceiling: UInt64
    public var free: UInt64
    public var volumes: [Volume]
}

public enum LayoutError: Error, Equatable, CustomStringConvertible {
    case commandFailed(String)
    case malformed(String)

    public var description: String {
        switch self {
        case .commandFailed(let what): return "could not read the disk layout (\(what) failed)"
        case .malformed(let what): return "unexpected diskutil output: \(what)"
        }
    }
}

/// The internal disk (`disk0`) and its APFS containers, read from `diskutil … -plist`.
public struct DiskLayout: Equatable {
    public static let internalDisk = "disk0"

    public var disk: String
    public var size: UInt64
    public var mediaName: String
    public var partitions: [Partition]
    public var containers: [Container]

    public func partition(_ id: String) -> Partition? { partitions.first { $0.id == id } }
    public func container(onStore id: String) -> Container? { containers.first { $0.physicalStore == id } }

    /// The macOS container's partition: the store of the container holding a System volume.
    public var macPartition: Partition? {
        let store = containers.first { $0.volumes.contains { $0.roles.contains("System") } }?.physicalStore
        return partitions.first { $0.id == store }
    }

    /// The last `Apple_APFS_Recovery` partition (the system recoveryOS).
    public var recoveryPartition: Partition? { partitions.last { $0.content == PartitionType.recovery } }

    /// Unallocated bytes directly after the macOS partition (up to the next partition).
    public var gapAfterMac: UInt64 {
        guard let mac = macPartition else { return 0 }
        let next = partitions.first { $0.offset >= mac.end }?.offset ?? size
        return next > mac.end ? next - mac.end : 0
    }

    /// Partitions physically between the macOS partition and the Recovery partition.
    public var between: [Partition] {
        guard let mac = macPartition, let rec = recoveryPartition else { return [] }
        return partitions.filter { $0.offset >= mac.end && $0.end <= rec.offset }
    }

    public static func load(from probe: Probe) throws -> DiskLayout {
        let list = try plist(probe, .diskList, "diskutil list")
        let apfs = try plist(probe, .apfsList, "diskutil apfs list")
        guard let disks = list["AllDisksAndPartitions"] as? [[String: Any]],
              let whole = disks.first(where: { $0["DeviceIdentifier"] as? String == internalDisk }),
              let parts = whole["Partitions"] as? [[String: Any]] else {
            throw LayoutError.malformed("no \(internalDisk) in diskutil list")
        }
        let diskInfo = try plist(probe, .diskInfo(internalDisk), "diskutil info \(internalDisk)")
        var partitions: [Partition] = []
        for p in parts {
            guard let id = p["DeviceIdentifier"] as? String else { throw LayoutError.malformed("partition without identifier") }
            let info = try plist(probe, .diskInfo(id), "diskutil info \(id)")
            guard let offset = uint(info["PartitionMapPartitionOffset"]), let size = uint(p["Size"]) else {
                throw LayoutError.malformed("no offset or size for \(id)")
            }
            let mount = info["MountPoint"] as? String
            partitions.append(Partition(
                id: id, content: p["Content"] as? String ?? "", size: size, offset: offset,
                uuid: (p["DiskUUID"] as? String ?? "").uppercased(), name: info["MediaName"] as? String ?? "",
                mountPoint: mount?.isEmpty == false ? mount : nil))
        }
        partitions.sort { $0.offset < $1.offset }
        var containers: [Container] = []
        for c in apfs["Containers"] as? [[String: Any]] ?? [] {
            guard let store = c["DesignatedPhysicalStore"] as? String,
                  store.hasPrefix(internalDisk + "s"),
                  let ref = c["ContainerReference"] as? String,
                  let ceiling = uint(c["CapacityCeiling"]), let free = uint(c["CapacityFree"]) else { continue }
            let volumes = (c["Volumes"] as? [[String: Any]] ?? []).map {
                Volume(id: $0["DeviceIdentifier"] as? String ?? "", name: $0["Name"] as? String ?? "",
                       roles: $0["Roles"] as? [String] ?? [], fileVault: $0["FileVault"] as? Bool ?? false)
            }
            containers.append(Container(ref: ref, physicalStore: store, ceiling: ceiling, free: free, volumes: volumes))
        }
        return DiskLayout(disk: internalDisk, size: uint(whole["Size"]) ?? 0,
                          mediaName: diskInfo["MediaName"] as? String ?? "",
                          partitions: partitions, containers: containers)
    }

    static func plist(_ probe: Probe, _ query: Query, _ what: String) throws -> [String: Any] {
        guard let data = probe.run(query) else { throw LayoutError.commandFailed(what) }
        guard let dict = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] else {
            throw LayoutError.malformed("\(what) is not a property list")
        }
        return dict
    }

    static func uint(_ value: Any?) -> UInt64? {
        (value as? NSNumber).map { $0.uint64Value }
    }
}
