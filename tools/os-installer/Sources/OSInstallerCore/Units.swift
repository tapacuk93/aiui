import Foundation

/// Sizes in bytes; GB is decimal (10^9), as `diskutil` and Finder show them.
public enum Size {
    public static let gb: UInt64 = 1_000_000_000
    /// Partition alignment (APFS and the installer work in 4 KiB blocks).
    public static let align: UInt64 = 4096
    /// AI UI OS target size (decision 2, docs/os-plan.md §7).
    public static let target: UInt64 = 25 * gb
    /// Free space the installer leaves macOS (upstream `MIN_FREE_OS`).
    public static let minFreeMacOS: UInt64 = 38 * gb
    /// The stub macOS container of every Asahi-style install.
    public static let stub: UInt64 = alignUp(2_500_000_000)

    public static func alignUp(_ n: UInt64) -> UInt64 { (n + align - 1) / align * align }
    public static func alignDown(_ n: UInt64) -> UInt64 { n / align * align }

    /// "37.4 GB". Rounded up, so "free X GB" is always enough.
    public static func gbText(_ n: UInt64) -> String {
        let tenths = (n + gb / 10 - 1) / (gb / 10)
        return "\(tenths / 10).\(tenths % 10) GB"
    }

    /// Parses "524288000B", "25GB", "25" (GB) or a JSON number (bytes).
    public static func parse(_ value: Any?) -> UInt64? {
        if let n = value as? NSNumber { return n.uint64Value }
        guard let s = value as? String else { return nil }
        if s.hasSuffix("GB"), let n = UInt64(s.dropLast(2)) { return n * gb }
        if s.hasSuffix("B"), let n = UInt64(s.dropLast()) { return n }
        return UInt64(s).map { $0 * gb }
    }
}
