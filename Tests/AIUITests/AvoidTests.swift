import XCTest
@testable import AIUI

final class AvoidTests: AIUITestCase {
    private var t0 = Date()

    private func make(_ dir: URL = TestEnv.tempDir()) -> Avoid {
        let a = Avoid(dir: dir)
        a.now = { [unowned self] in self.t0 }
        return a
    }
    private func keys(_ a: Avoid) -> Set<String> { Set(a.list().compactMap { $0["key"] as? String }) }

    func testRecordOverviewAndList() {
        let a = make()
        a.record([["url": "https://cdn.test/a.js", "reason": "404"], ["url": "mailto:x"], ["reason": "403"],
                  ["url": "https://blocked.test/x.png", "reason": "403"]])
        XCTAssertEqual(keys(a), ["cdn.test", "https://cdn.test/a.js", "blocked.test", "https://blocked.test/x.png"])
        // One 404 does not make a host fail; a refusal does; URLs always count.
        var ov = a.overview()
        XCTAssertEqual(ov.count, 3)
        XCTAssertTrue(ov[0].hasPrefix("blocked.test — 403 ×1 since "))
        XCTAssertFalse(ov.contains { $0.hasPrefix("cdn.test ") })
        a.record([["url": "https://cdn.test/b.js"]])
        ov = a.overview()
        XCTAssertTrue(ov.contains { $0.hasPrefix("cdn.test — failed ×2") })
        XCTAssertEqual(a.overview(limit: 1).count, 1)
        // Hosts first, then the most failing.
        a.record([["url": "https://cdn.test/b.js"]])
        ov = a.overview()
        XCTAssertEqual(ov.prefix(2).allSatisfy { !$0.hasPrefix("https://") }, true)
        XCTAssertTrue(ov[2].hasPrefix("https://cdn.test/b.js — failed ×2"))

        let row = a.list().first { $0["key"] as? String == "cdn.test" }!
        XCTAssertEqual(row["kind"] as? String, "host")
        XCTAssertEqual(row["failures"] as? Int, 3)
        XCTAssertEqual(row["active"] as? Bool, true)
        XCTAssertEqual(row["checks"] as? Int, 0)
        XCTAssertEqual(row["nextCheck"] as? String, ISO8601DateFormatter().string(from: t0.addingTimeInterval(600)))

        a.clear()
        XCTAssertTrue(a.list().isEmpty)
        XCTAssertTrue(make(TestEnv.tempDir()).list().isEmpty)
    }

    func testRecheckSuccessClearsTheHostAndItsURLs() {
        let a = make()
        MockURL.on("ok.test", .text("fine"))
        a.record([["url": "https://ok.test/1.png", "reason": "403"]])
        t0 += 500
        a.record([["url": "https://ok.test/2.png", "reason": "403"]])
        a.record([["url": "https://other.test/x", "reason": "403"]])
        t0 += 200
        a.recheckDue()
        waitUntil { self.keys(a) == ["other.test", "https://other.test/x"] }
        let reqs = MockURL.seen.filter { $0.url.host == "ok.test" }
        XCTAssertEqual(reqs.count, 2, "the host and its first URL were due, the second URL was not")
        XCTAssertEqual(reqs.first?.headers["Range"], "bytes=0-1023")
        XCTAssertEqual(reqs.first?.method, "GET")
    }

    func testRecheckFailureDoublesTheWait() {
        let dir = TestEnv.tempDir()
        let a = make(dir)
        MockURL.on("err.test", .text("no", status: 500))
        MockURL.on("slow.test", .fail(.timedOut))
        MockURL.on("down.test", .fail(.cannotFindHost))
        a.record([["url": "https://err.test/a"], ["url": "https://slow.test/a"], ["url": "https://down.test/a"]])
        t0 += 601
        a.recheckDue()
        waitUntil { a.list().allSatisfy { $0["checks"] as? Int == 1 } }
        let reason = Dictionary(uniqueKeysWithValues: a.list().map { ($0["key"] as! String, $0["reason"] as! String) })
        XCTAssertEqual(reason["err.test"], "500")
        XCTAssertEqual(reason["https://slow.test/a"], "timeout")
        XCTAssertEqual(reason["down.test"], "failed")
        let next = a.list().first { $0["key"] as? String == "err.test" }?["nextCheck"] as? String
        XCTAssertEqual(next, ISO8601DateFormatter().string(from: t0.addingTimeInterval(1200)))
        // Persisted: another instance sees the checks.
        XCTAssertEqual(Avoid(dir: dir).list().first?["checks"] as? Int, 1)
        // Not due again yet.
        let n = MockURL.seen.count
        a.recheckDue()
        spin()
        XCTAssertEqual(MockURL.seen.count, n)
    }

    func testBackoffIsCappedAndBadSamplesDropped() {
        let dir = TestEnv.tempDir()
        let past = StoreFiles.iso(Date().addingTimeInterval(-60)), at = StoreFiles.iso(Date())
        func entry(_ key: String, _ sample: String, backoff: Double) -> [String: Any] {
            ["key": key, "kind": "host", "sample": sample, "reason": "403", "failures": 1, "first": at, "last": at,
             "nextCheck": past, "backoff": backoff, "checks": 0]
        }
        StoreFiles.write([entry("capped.test", "https://capped.test/", backoff: 6 * 86_400), entry("bad", "", backoff: 600)],
                         dir.appendingPathComponent("avoid.json"))
        MockURL.on("capped.test", .text("", status: 404))
        let a = Avoid(dir: dir)
        a.recheckDue()
        XCTAssertEqual(keys(a), ["capped.test"], "an entry without a usable URL is dropped")
        waitUntil { a.list().first?["checks"] as? Int == 1 }
        let next = ISO8601DateFormatter().date(from: a.list().first?["nextCheck"] as? String ?? "")!
        XCTAssertEqual(next.timeIntervalSinceNow, Avoid.maxBackoff, accuracy: 5)
    }

    func testRecheckInFlightIsNotRepeatedAndIgnoresClearedEntries() {
        let a = make()
        var r = MockURL.Response.text("ok"); r.delay = 0.3
        MockURL.on("wait.test", r)
        a.record([["url": "https://wait.test/a", "reason": "dns"]])
        t0 += 700
        a.recheckDue()
        a.recheckDue()
        a.clear()
        spin(0.6)
        XCTAssertEqual(MockURL.seen.filter { $0.url.host == "wait.test" }.count, 2, "one request per entry, not repeated while in flight")
        XCTAssertTrue(a.list().isEmpty, "a cleared entry stays cleared")
    }

    func testMergesDiskNewestWinsAndKeepsAtMost500() {
        let dir = TestEnv.tempDir()
        let a = make(dir)
        a.record([["url": "https://mine.test/a", "reason": "mine"], ["url": "https://shared.test/a", "reason": "here"]])
        let url = dir.appendingPathComponent("avoid.json")
        var list = StoreFiles.json(url) as? [[String: Any]] ?? []
        for i in list.indices {
            switch list[i]["key"] as? String {
            case "shared.test": list[i]["reason"] = "there"; list[i]["last"] = StoreFiles.iso(t0.addingTimeInterval(60))
            case "mine.test": list[i]["reason"] = "stale"; list[i]["last"] = StoreFiles.iso(t0.addingTimeInterval(-60))
            default: break
            }
        }
        var other = list[0]; other["key"] = "other.test"
        list.append(other)
        StoreFiles.write(list, url)
        a.reload()
        let reason = Dictionary(uniqueKeysWithValues: a.list().map { ($0["key"] as! String, $0["reason"] as! String) })
        XCTAssertEqual(reason["shared.test"], "there")
        XCTAssertEqual(reason["mine.test"], "mine")
        XCTAssertNotNil(reason["other.test"])
        try? Data("junk".utf8).write(to: url)
        a.reload()
        XCTAssertEqual(a.list().count, 5)

        let big = make()
        big.record((0..<251).map { ["url": "https://h\($0).test/x"] })
        XCTAssertEqual(big.list().count, 500)
    }

    // MARK: - Two devices sharing one synced folder

    private func removedFile(_ dir: URL) -> [String: Any] {
        StoreFiles.json(dir.appendingPathComponent("avoid-removed.json")) as? [String: Any] ?? [:]
    }

    func testSavesMergeWithAnotherDevicesEntries() {
        let dir = TestEnv.tempDir()
        let mac = make(dir), phone = make(dir)
        mac.record([["url": "https://a.test/1", "reason": "403"]])
        phone.record([["url": "https://b.test/1", "reason": "403"]])   // phone never read the Mac's entry
        mac.record([["url": "https://c.test/1", "reason": "403"]])
        // Nobody's entries were overwritten.
        XCTAssertEqual(keys(make(dir)), ["a.test", "https://a.test/1", "b.test", "https://b.test/1", "c.test", "https://c.test/1"])
        // The list file keeps the format older app versions read: a plain array of entries.
        XCTAssertNotNil(StoreFiles.json(dir.appendingPathComponent("avoid.json")) as? [[String: Any]])
    }

    func testAClearedEntryStaysClearedOnOtherDevices() {
        let dir = TestEnv.tempDir()
        let mac = make(dir)
        mac.record([["url": "https://gone.test/1", "reason": "403"]])
        let phone = make(dir)                                         // has the entry in memory
        t0 += 5
        mac.clear()
        XCTAssertNotNil(removedFile(dir)["gone.test"])
        t0 += 5
        phone.record([["url": "https://other.test/1", "reason": "403"]])   // saves its older copy
        XCTAssertEqual(keys(phone), ["other.test", "https://other.test/1"], "the deletion record wins over the older copy")
        XCTAssertEqual(keys(make(dir)), ["other.test", "https://other.test/1"])
    }

    func testARecheckSuccessIsRecordedForOtherDevices() {
        let dir = TestEnv.tempDir()
        let mac = make(dir)
        MockURL.on("back.test", .text("fine"))
        mac.record([["url": "https://back.test/1", "reason": "403"], ["url": "https://bad.test/x", "reason": "403"]])
        let phone = make(dir)
        t0 += 700
        mac.recheckDue()
        waitUntil { !self.keys(mac).contains("back.test") }
        XCTAssertNotNil(removedFile(dir)["back.test"])
        XCTAssertNotNil(removedFile(dir)["https://back.test/1"], "the host's URLs are recorded too")
        phone.reload()
        XCTAssertFalse(keys(phone).contains("back.test"))
        XCTAssertFalse(keys(phone).contains("https://back.test/1"))
    }

    func testFailingAgainInTheSameSecondAsTheClearCounts() {
        let dir = TestEnv.tempDir()
        let mac = make(dir)
        t0 = Date(timeIntervalSince1970: 1_800_000_000.2)
        mac.record([["url": "https://flaky.test/1", "reason": "403"]])
        mac.clear()
        t0 = Date(timeIntervalSince1970: 1_800_000_000.7)              // same whole second as the clear
        mac.record([["url": "https://flaky.test/1", "reason": "403"]])
        XCTAssertTrue(keys(make(dir)).contains("flaky.test"), "the new failure outlives the older deletion on every device")
    }

    func testOldDeletionRecordsArePruned() {
        let dir = TestEnv.tempDir()
        let a = make(dir)
        a.record([["url": "https://old.test/1", "reason": "403"]])
        a.clear()
        XCTAssertNotNil(removedFile(dir)["old.test"])
        t0 += Avoid.removedKeep + 60
        a.record([["url": "https://new.test/1", "reason": "403"]])
        XCTAssertNil(removedFile(dir)["old.test"])
        XCTAssertNil(removedFile(dir)["new.test"], "only deletions are recorded")
    }
}
