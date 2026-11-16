import XCTest
@testable import AIUI

final class StorageTests: AIUITestCase {
    private var savedLookup: ((String) -> URL?)!
    private var savedICloud = false
    private let fm = FileManager.default

    override func setUp() {
        super.setUp()
        savedLookup = Storage.ubiquityContainer
        savedICloud = Storage.isICloud
    }

    override func tearDown() {
        Storage.ubiquityContainer = savedLookup
        Storage.isICloud = savedICloud
        super.tearDown()
    }

    private func write(_ s: String, _ url: URL) {
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data(s.utf8).write(to: url)
    }
    private func text(_ url: URL) -> String? { (try? Data(contentsOf: url)).map { String(decoding: $0, as: UTF8.self) } }

    func testRootWithoutICloudIsTheLocalFolder() {
        Storage.isICloud = false
        var asked: String?
        Storage.ubiquityContainer = { asked = $0; return nil }
        let local = TestEnv.tempDir("local").appendingPathComponent("AIUI", isDirectory: true)
        XCTAssertEqual(Storage.root(local: local), local)
        XCTAssertEqual(asked, "iCloud.com.oeaio.aiui")
        XCTAssertTrue(fm.fileExists(atPath: local.path))   // created
        XCTAssertFalse(Storage.isICloud)
    }

    func testRootInICloudMigratesOnce() {
        Storage.isICloud = false
        let local = TestEnv.tempDir("local"), container = TestEnv.tempDir("container")
        Storage.ubiquityContainer = { _ in container }
        // cache: only local (copied whole); utilities: both (missing files copied, existing kept);
        // profile: nowhere (skipped).
        write("c1", local.appendingPathComponent("cache/entries/a.json"))
        write("u-local", local.appendingPathComponent("utilities/library.json"))
        write("u-new", local.appendingPathComponent("utilities/sub/extra.json"))
        let cloud = container.appendingPathComponent("Documents/AIUI", isDirectory: true)
        write("u-cloud", cloud.appendingPathComponent("utilities/library.json"))

        let r = Storage.root(local: local)
        XCTAssertEqual(r.standardizedFileURL, cloud.standardizedFileURL)
        XCTAssertTrue(Storage.isICloud)
        XCTAssertEqual(text(cloud.appendingPathComponent("cache/entries/a.json")), "c1")
        XCTAssertEqual(text(cloud.appendingPathComponent("utilities/library.json")), "u-cloud")
        XCTAssertEqual(text(cloud.appendingPathComponent("utilities/sub/extra.json")), "u-new")
        XCTAssertFalse(fm.fileExists(atPath: cloud.appendingPathComponent("profile").path))
        XCTAssertTrue(fm.fileExists(atPath: local.appendingPathComponent(".migrated-to-icloud").path))

        // Second launch: already migrated, nothing more is copied.
        write("later", local.appendingPathComponent("cache/entries/b.json"))
        _ = Storage.root(local: local)
        XCTAssertFalse(fm.fileExists(atPath: cloud.appendingPathComponent("cache/entries/b.json").path))
    }

    func testDownloadOnlyInICloud() {
        let dir = TestEnv.tempDir("dl")
        write("", dir.appendingPathComponent(".entry.json.icloud"))
        write("x", dir.appendingPathComponent("plain.json"))
        Storage.isICloud = false
        Storage.download(dir)                          // no-op
        Storage.isICloud = true
        Storage.download(dir)                          // asks for entry.json (not a ubiquitous item here: ignored)
        Storage.download(dir.appendingPathComponent("missing"))
        XCTAssertEqual(text(dir.appendingPathComponent("plain.json")), "x")
        XCTAssertFalse(fm.fileExists(atPath: dir.appendingPathComponent("entry.json").path))
    }

    func testReadWrite() {
        let f = TestEnv.tempDir("rw").appendingPathComponent("a.json")
        XCTAssertNil(Storage.read(f))
        Storage.write(Data("one".utf8), to: f)
        XCTAssertEqual(Storage.read(f), Data("one".utf8))
        Storage.write(Data("two".utf8), to: f)
        XCTAssertEqual(Storage.read(f), Data("two".utf8))
    }
}
