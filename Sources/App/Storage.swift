import Foundation

/// Where AI UI keeps what the AI learns — memory cache, flows, utilities, profile. In the iCloud
/// container when the app is signed for iCloud and the user is signed in, so the Mac and iOS
/// apps share one copy; otherwise on this device. Each store merges what is on disk before it
/// writes (newest wins, deletions kept as tombstones), so two devices don't overwrite each other.
enum Storage {
    static let container = "iCloud.com.oeaio.aiui"
    private(set) static var isICloud = false

    static func root(local: URL) -> URL {
        try? FileManager.default.createDirectory(at: local, withIntermediateDirectories: true)
        guard let c = FileManager.default.url(forUbiquityContainerIdentifier: container) else { return local }
        let r = c.appendingPathComponent("Documents/AIUI", isDirectory: true)
        try? FileManager.default.createDirectory(at: r, withIntermediateDirectories: true)
        isICloud = true
        migrate(from: local, to: r)
        return r
    }

    /// Once: copies data saved before iCloud was available into the container (merging happens
    /// naturally the next time each store writes).
    private static func migrate(from local: URL, to cloud: URL) {
        let fm = FileManager.default
        let marker = local.appendingPathComponent(".migrated-to-icloud")
        guard !fm.fileExists(atPath: marker.path) else { return }
        for name in ["cache", "utilities", "profile"] {
            let src = local.appendingPathComponent(name), dst = cloud.appendingPathComponent(name)
            guard fm.fileExists(atPath: src.path) else { continue }
            if !fm.fileExists(atPath: dst.path) { try? fm.copyItem(at: src, to: dst); continue }
            // Both exist: copy over the entry files the cloud copy lacks.
            for f in (try? fm.subpathsOfDirectory(atPath: src.path)) ?? [] {
                let to = dst.appendingPathComponent(f)
                if !fm.fileExists(atPath: to.path) {
                    try? fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? fm.copyItem(at: src.appendingPathComponent(f), to: to)
                }
            }
        }
        fm.createFile(atPath: marker.path, contents: Data())
    }

    /// Asks iCloud to download files in `dir` that exist only as placeholders on this device.
    static func download(_ dir: URL) {
        guard isICloud, let items = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for name in items where name.hasPrefix(".") && name.hasSuffix(".icloud") {
            let real = String(name.dropFirst().dropLast(".icloud".count))
            try? FileManager.default.startDownloadingUbiquitousItem(at: dir.appendingPathComponent(real))
        }
    }

    /// Reads a file through NSFileCoordinator (iCloud-safe).
    static func read(_ url: URL) -> Data? {
        var out: Data?
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &err) { out = try? Data(contentsOf: $0) }
        return out
    }

    /// Writes a file through NSFileCoordinator (iCloud-safe), atomically.
    static func write(_ data: Data, to url: URL) {
        var err: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &err) {
            try? data.write(to: $0, options: .atomic)
        }
    }
}
