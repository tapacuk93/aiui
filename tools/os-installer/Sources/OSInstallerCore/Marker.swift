import Foundation

/// `<ESP>/asahi/aiui-install.json`: written by the installer fork after it creates the partitions.
/// The uninstaller deletes nothing that is not listed here (docs/os-plan.md §1.7).
public struct InstallMarker: Codable, Equatable {
    public struct Disk: Codable, Equatable {
        public var mediaName: String
        public var size: UInt64
    }
    public struct Part: Codable, Equatable {
        /// stub, esp, boot or root.
        public var role: String
        /// GPT unique partition GUID.
        public var partitionUUID: String
        /// GPT partition name, "… - AI UI OS".
        public var name: String
    }

    public static let fileName = "aiui-install.json"
    public static let pathInESP = "asahi/" + fileName
    public static let roles = ["stub", "esp", "boot", "root"]

    public var format: Int
    public var product: String
    public var disk: Disk
    public var stubVGID: String
    public var partitions: [Part]

    public static func decode(_ data: Data) throws -> InstallMarker {
        let marker = try JSONDecoder().decode(InstallMarker.self, from: data)
        guard marker.format == 1, marker.product == Ownership.product else {
            throw UninstallError.refused("\(fileName) is not an AI UI OS install marker (format 1)")
        }
        return marker
    }

    public func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try! encoder.encode(self)
    }
}
