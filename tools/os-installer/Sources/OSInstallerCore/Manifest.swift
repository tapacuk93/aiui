import Foundation

/// An `os_list` entry of `installer_data.json` (docs/os-plan.md §1.3): the package's partitions.
public struct OSManifest: Equatable {
    public struct Part: Equatable {
        public var name: String
        /// "EFI" or "Linux".
        public var type: String
        public var size: UInt64
        public var format: String?
        public var image: String?
        public var expand: Bool
    }

    public var name: String
    public var package: String
    public var supportedFW: [String]
    public var partitions: [Part]

    public enum ManifestError: Error, Equatable, CustomStringConvertible {
        case invalid(String)
        public var description: String {
            switch self { case .invalid(let why): return "package manifest: \(why)" }
        }
    }

    /// Accepts a whole `installer_data.json` (takes the first `os_list` entry) or a single entry.
    public static func parse(_ data: Data) throws -> OSManifest {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ManifestError.invalid("not a JSON object")
        }
        let entry = (json["os_list"] as? [[String: Any]])?.first ?? json
        guard let name = entry["name"] as? String, let parts = entry["partitions"] as? [[String: Any]], !parts.isEmpty else {
            throw ManifestError.invalid("needs a name and partitions")
        }
        var result: [Part] = []
        for p in parts {
            guard let pname = p["name"] as? String, let type = p["type"] as? String, ["EFI", "Linux"].contains(type),
                  let size = Size.parse(p["size"]), size > 0 else {
                throw ManifestError.invalid("partition \(p["name"] ?? "?") needs a name, type EFI or Linux and a size")
            }
            result.append(Part(name: pname, type: type, size: size, format: p["format"] as? String,
                               image: p["image"] as? String, expand: p["expand"] as? Bool ?? false))
        }
        guard result.filter(\.expand).count == 1, result.first?.type == "EFI" else {
            throw ManifestError.invalid("needs the EFI partition first and exactly one expandable partition")
        }
        return OSManifest(name: name, package: entry["package"] as? String ?? "",
                          supportedFW: entry["supported_fw"] as? [String] ?? [], partitions: result)
    }

    /// Our entry until the M2 image is measured: Fedora Asahi Minimal sizes, Root ~7 GiB.
    public static let builtIn = OSManifest(
        name: "AI UI OS", package: "aiui-os.zip", supportedFW: ["12.3", "12.3.1", "13.5", "14.8.3"],
        partitions: [
            Part(name: "EFI", type: "EFI", size: 524_288_000, format: "fat", image: nil, expand: false),
            Part(name: "Boot", type: "Linux", size: 1_073_741_824, format: nil, image: "boot.img", expand: false),
            Part(name: "Root", type: "Linux", size: 7_516_192_768, format: nil, image: "root.img", expand: true),
        ])
}
