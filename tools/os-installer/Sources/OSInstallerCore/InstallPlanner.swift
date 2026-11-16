import Foundation

public enum PlanError: Error, Equatable, CustomStringConvertible {
    case layout(String)
    case notEnoughSpace(toFree: UInt64)
    case alreadyInstalled
    case targetTooSmall(minimum: UInt64)

    public var description: String {
        switch self {
        case .layout(let why): return why
        case .notEnoughSpace(let n): return "not enough space: free \(Size.gbText(n)) in macOS first"
        case .alreadyInstalled: return "AI UI OS is already installed: uninstall it first"
        case .targetTooSmall(let n): return "AI UI OS needs at least \(Size.gbText(n)) for this package"
        }
    }
}

/// Step 2 happens in One True Recovery and only the person can do it: this is the guide the app shows.
public enum Guide {
    public static let step2 = [
        "Shut the Mac down and wait 10 seconds.",
        "Press and hold the power button until \"Loading startup options\" appears.",
        "Choose \"AI UI OS\" and click Continue: its recovery opens and finishes the setup.",
        "When asked, type your macOS user name and password (twice). This allows AI UI OS to boot; macOS keeps Full Security.",
        "The Mac restarts into AI UI OS. To go back to macOS, hold the power button at startup and choose Macintosh HD.",
    ]
}

/// Computes the install (step 1) the installer fork would perform, as a dry run. Writes nothing.
public enum InstallPlanner {
    public static let stubName = Ownership.product
    public static let espLabel = "AIUI-EFI"

    public static func plan(layout: DiskLayout, manifest: OSManifest, target: UInt64 = Size.target,
                            packagePath: String = "<package>") throws -> Plan {
        let space = Preflight.space(layout, target: target)
        guard let toFree = space.data["toFree"] as? UInt64 else { throw PlanError.layout(space.summary) }
        guard toFree == 0 else { throw PlanError.notEnoughSpace(toFree: toFree) }
        guard !layout.partitions.contains(where: Ownership.isOurs) else { throw PlanError.alreadyInstalled }
        let mac = layout.macPartition!
        let container = layout.container(onStore: mac.id)!

        let fixed = Size.stub + manifest.partitions.filter { !$0.expand }.reduce(0) { $0 + Size.alignUp($1.size) }
        let expandMin = Size.alignUp(manifest.partitions.first(where: \.expand)!.size)
        guard target >= fixed + expandMin else { throw PlanError.targetTooSmall(minimum: fixed + expandMin) }
        let expandSize = Size.alignDown(target - fixed)
        let total = fixed + expandSize
        let gap = layout.gapAfterMac
        let shrink = total > gap ? Size.alignUp(total - gap) : 0
        let newCeiling = container.ceiling - shrink

        var steps: [Step] = []
        if shrink > 0 {
            steps.append(.command(["diskutil", "apfs", "resizeContainer", mac.id, "\(newCeiling)B"],
                                  "shrink macOS by \(Size.gbText(shrink)); it keeps \(Size.gbText(container.free - shrink)) free"))
        }
        steps.append(.command(["diskutil", "addPartition", mac.id, "APFS", stubName, "\(Size.stub)B"],
                              "stub macOS container that boots AI UI OS (new partition: <new:stub>)"))
        steps.append(.installer("name the stub partition \"\(Ownership.name("Stub"))\", stream the boot components of macOS \(manifest.supportedFW.last ?? "?") from Apple's IPSW into it, set its APFS bootable flag (macOS 27) and record its GUID and VGID"))
        var partitions: [[String: Any]] = [["role": "stub", "name": Ownership.name("Stub"), "type": "APFS", "size": Size.stub]]
        var previous = "<new:stub>"
        for part in manifest.partitions {
            let role = part.type == "EFI" ? "esp" : part.name.lowercased()
            let size = part.expand ? expandSize : Size.alignUp(part.size)
            let guid = part.type == "EFI" ? PartitionType.efiGUID : PartitionType.linuxGUID
            let new = "<new:\(role)>"
            steps.append(.command(["diskutil", "addPartition", previous, "%\(guid)%", "%noformat%", "\(size)B"],
                                  "\(part.name) partition (new: \(new))"))
            steps.append(.installer("name \(new) \"\(Ownership.name(part.name))\" and record its GUID"))
            if part.format == "fat" {
                steps.append(.command(["newfs_msdos", "-F", "32", "-v", espLabel, "/dev/r\(new)"], "format the EFI system partition"))
            }
            if let image = part.image {
                steps.append(.command(["dd", "if=\(packagePath)/\(image)", "of=/dev/r\(new)", "bs=8m"], "write \(image)"))
            }
            partitions.append(["role": role, "name": Ownership.name(part.name), "type": part.type, "size": size])
            previous = new
        }
        steps.append(.installer("copy the package's esp/ tree, Apple's firmware and the installer data to the EFI partition, and write \(InstallMarker.pathInESP) with the GUIDs recorded above"))
        steps.append(.command(["bless", "--mount", "/Volumes/\(stubName)", "--setBoot"], "make AI UI OS the default startup disk"))
        steps += Guide.step2.map(Step.user)

        let marker = InstallMarker(
            format: 1, product: Ownership.product, disk: .init(mediaName: layout.mediaName, size: layout.size),
            stubVGID: "<recorded at install>",
            partitions: partitions.map { .init(role: $0["role"] as! String, partitionUUID: "<recorded at install>", name: $0["name"] as! String) })
        var plan = Plan(kind: .install, steps: steps, macPartition: mac.id,
                        protected: layout.partitions.filter { $0.content != PartitionType.apfs || $0.id == mac.id }.map(\.id))
        plan.details = [
            "target": target, "total": total, "partitions": partitions,
            "resize": ["partition": mac.id, "from": container.ceiling, "to": newCeiling, "shrinkBy": shrink],
            "marker": try! JSONSerialization.jsonObject(with: marker.encoded()),
        ]
        return plan
    }
}
