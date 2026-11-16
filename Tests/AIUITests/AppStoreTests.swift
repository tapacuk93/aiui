import XCTest
@testable import AIUI

final class AppStoreTests: AIUITestCase {
    func testSetGetAllAndPersist() {
        let dir = TestEnv.tempDir("app")
        let a = AppStore(dir: dir)
        XCTAssertNil(a.get("volume"))
        a.set("volume", 0.5)
        a.set("track", ["id": "t1"])
        XCTAssertEqual(a.get("volume") as? Double, 0.5)
        XCTAssertEqual((a.all()["track"] as? [String: Any])?["id"] as? String, "t1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("app.json").path))
        // Another device / launch reads it back.
        let b = AppStore(dir: dir)
        XCTAssertEqual(b.get("volume") as? Double, 0.5)
        XCTAssertEqual(b.all().count, 2)
    }

    func testReloadAnnouncesNewerValuesOnly() {
        let dir = TestEnv.tempDir("app")
        let a = AppStore(dir: dir), b = AppStore(dir: dir)
        var changes: [String: Any] = [:]
        a.onChange = { changes[$0] = $1 }
        a.reload()
        XCTAssertTrue(changes.isEmpty)
        b.set("player", "playing")
        a.reload()
        XCTAssertEqual(changes["player"] as? String, "playing")
        XCTAssertEqual(a.get("player") as? String, "playing")
        changes = [:]
        a.reload()                            // nothing new
        XCTAssertTrue(changes.isEmpty)
    }

    func testCorruptFileIsIgnored() {
        let dir = TestEnv.tempDir("app")
        try? Data("not json".utf8).write(to: dir.appendingPathComponent("app.json"))
        let a = AppStore(dir: dir)
        XCTAssertTrue(a.all().isEmpty)
        a.set("k", 1)
        XCTAssertEqual(AppStore(dir: dir).get("k") as? Int, 1)
    }
}
