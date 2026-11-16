import CryptoKit
import XCTest
@testable import AIUI

final class AICoinTests: AIUITestCase {
    private func unb64url(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
    private func hexData(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let j = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<j], radix: 16)!); i = j }
        return d
    }

    /// A fresh wallet in the test Keychain service; returns its address.
    @discardableResult
    private func freshWallet(_ coin: AICoin = AICoin()) -> String {
        SharedTestKit.removeWalletItem()
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 3.0]))
        var done: Result<Double, Error>?
        coin.prepare { done = $0 }
        waitUntil { done != nil }
        return coin.address!
    }

    override func tearDown() {
        SharedTestKit.removeWalletItem()
        super.tearDown()
    }

    // MARK: Signatures

    func testSignHelpers() throws {
        XCTAssertEqual(AICoinSign.hex(Data([1, 171])), "01ab")
        XCTAssertEqual(AICoinSign.base64url(Data([0xfb, 0xff])), "-_8")
        let k = Curve25519.Signing.PrivateKey()
        let addr = AICoinSign.address(k)
        XCTAssertEqual(addr, AICoinSign.hex(k.publicKey.rawRepresentation))

        let t = try AICoinSign.token(k, validFor: 60, now: Date(timeIntervalSince1970: 100))
        let parts = t.split(separator: ".").map(String.init)
        XCTAssertEqual(parts.count, 2)
        let payload = try JSONSerialization.jsonObject(with: unb64url(parts[0])!) as! [String: Any]
        XCTAssertEqual(payload["addr"] as? String, addr)
        XCTAssertEqual(payload["iat"] as? Int, 100)
        XCTAssertEqual(payload["exp"] as? Int, 160)
        XCTAssertTrue(k.publicKey.isValidSignature(unb64url(parts[1])!, for: Data(parts[0].utf8)))

        let h = try AICoinSign.liveHeaders(k, method: "POST", path: "/wallet/api/claim?x=1", body: Data(), now: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(h["X-Api-Key"], addr)
        XCTAssertEqual(h["X-Api-Timestamp"], "2000")
        let msg = "\(addr)\n2000\nPOST\n/wallet/api/claim\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        XCTAssertTrue(k.publicKey.isValidSignature(hexData(h["X-Api-Signature"]!), for: Data(msg.utf8)))
    }

    func testShortPayloadQR() throws {
        XCTAssertTrue(AICoin.available)
        XCTAssertEqual(AICoin.proxy, "https://aicoin.test")
        XCTAssertEqual(AICoin.env("AIUI_TEST_UNSET_VARIABLE", "fallback"), "fallback")
        XCTAssertEqual(AICoin.short("abc"), "abc")
        XCTAssertEqual(AICoin.short(String(repeating: "a", count: 6) + "xyz" + String(repeating: "b", count: 6)), "aaaaaa…bbbbbb")
        XCTAssertEqual(AICoin.linkPayload(address: "ab12"), "aicoin:link?address=ab12&app=AI%20UI")
        XCTAssertEqual(AICoin.linkPayload(address: "x", app: "a-b.c_d~e/f"), "aicoin:link?address=x&app=a-b.c_d~e%2Ff")
        let qr = try XCTUnwrap(AICoin.qrDataURL("aicoin:link?address=00"))
        XCTAssertTrue(qr.hasPrefix("data:image/png;base64,"))
        let png = try XCTUnwrap(Data(base64Encoded: String(qr.dropFirst("data:image/png;base64,".count))))
        XCTAssertEqual(Array(png.prefix(4)), [0x89, 0x50, 0x4e, 0x47])
    }

    // MARK: Wallet

    func testNoWalletNoKey() {
        SharedTestKit.removeWalletItem()
        let c = AICoin()
        XCTAssertNil(c.address)
        XCTAssertNil(c.key())
        c.refreshBalance()                       // nothing to ask for
        spin()
        XCTAssertTrue(MockURL.seen.isEmpty)
    }

    func testPrepareClaimsWhenEmpty() throws {
        SharedTestKit.removeWalletItem()
        let c = AICoin()
        var claimed = false
        MockURL.on("aicoin.test/wallet/api/balance/") { _ in .json(["balance": claimed ? 5.0 : 0.0]) }
        MockURL.on("aicoin.test/wallet/api/claim", method: "POST") { _ in claimed = true; return .json(["ok": true]) }
        var done: Result<Double, Error>?
        c.prepare { done = $0 }
        waitUntil { done != nil }
        XCTAssertEqual(done?.succeeded, 5)
        let addr = try XCTUnwrap(c.address)
        let claim = try XCTUnwrap(MockURL.seen.first { $0.url.path == "/wallet/api/claim" })
        XCTAssertEqual(claim.headers["X-Api-Key"], addr)
        XCTAssertEqual(claim.headers["Content-Type"], "application/json")
        XCTAssertNotNil(claim.headers["X-Api-Signature"])
        XCTAssertEqual(c.lastStatus?["balance"] as? Double, 5)

        // The engine key: a token for this wallet, reused while valid.
        let k = try XCTUnwrap(c.key())
        XCTAssertEqual(k.provider, "anthropic"); XCTAssertEqual(k.name, "AICoin")
        XCTAssertEqual(k.base, "https://aicoin.test"); XCTAssertEqual(k.headers, ["X-AI": "anthropic"])
        XCTAssertEqual(c.key()?.key, k.key)
        let payload = try JSONSerialization.jsonObject(with: unb64url(String(k.key.split(separator: ".")[0]))!) as! [String: Any]
        XCTAssertEqual(payload["addr"] as? String, addr)

        // A second prepare loads the same wallet and doesn't claim when there are coins.
        let n = MockURL.seen.filter { $0.url.path == "/wallet/api/claim" }.count
        let again = AICoin()
        var d2: Result<Double, Error>?
        again.prepare { d2 = $0 }
        waitUntil { d2 != nil }
        XCTAssertEqual(d2?.succeeded, 5)
        XCTAssertEqual(again.address, addr)
        XCTAssertEqual(MockURL.seen.filter { $0.url.path == "/wallet/api/claim" }.count, n)
    }

    func testPrepareOfflineStillSucceeds() {
        SharedTestKit.removeWalletItem()
        let c = AICoin()
        var done: Result<Double, Error>?
        c.prepare { done = $0 }                  // no routes: balance and claim fail
        waitUntil { done != nil }
        XCTAssertEqual(done?.succeeded, 0)
        XCTAssertNotNil(c.address)
    }

    func testPrepareKeychainFailure() {
        SharedTestKit.removeWalletItem()
        let c = AICoin()
        c.secAdd = { _, _ in errSecNotAvailable }
        var done: Result<Double, Error>?
        c.prepare { done = $0 }
        waitUntil { done != nil }
        XCTAssertTrue(done?.failed?.localizedDescription.contains("Could not save the AICoin wallet") == true)
        XCTAssertNil(c.address)
    }

    func testRefreshBalanceLinkedThenUnlinked() {
        let c = AICoin()
        freshWallet(c)
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 1.0, "spendable": 40.0, "linked_to": "owner"]))
        let none = SharedTestKit.events(self) {
            c.refreshBalance()
            waitUntil { c.lastBalance == 40 }
        }
        XCTAssertTrue(none.isEmpty)
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 2.0]))
        let ev = SharedTestKit.events(self) {
            c.refreshBalance()
            waitUntil { c.lastBalance == 2 }
        }
        XCTAssertEqual(ev.first?["type"] as? String, "aicoinLink")
        XCTAssertEqual(ev.first?["state"] as? String, "unlinked")
        // Linked without `spendable`: the balance.
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 7.0, "linked_to": "owner"]))
        c.refreshBalance()
        waitUntil { c.lastBalance == 7 }
    }

    // MARK: The endpoint

    private func handle(_ c: AICoin, _ input: [String: Any], use: @escaping () -> Bool = { false }) -> (sent: [[String: Any]], failed: String?) {
        var sent: [[String: Any]] = [], failed: String?
        c.handle(input, use: use, send: { sent.append($0) }, fail: { failed = $0 })
        waitUntil { !sent.isEmpty || failed != nil }
        return (sent, failed)
    }

    func testCancelAndStatus() {
        let c = AICoin()
        let addr = freshWallet(c)
        XCTAssertEqual(handle(c, ["op": "cancel"]).sent.first?["ok"] as? Bool, true)
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 9.0, "spendable": NSNull(), "linked_to": "f" + String(repeating: "0", count: 63)]))
        let st = handle(c, [:]).sent.first!
        XCTAssertEqual(st["address"] as? String, addr)
        XCTAssertEqual(st["short"] as? String, AICoin.short(addr))
        XCTAssertEqual(st["linked"] as? Bool, true)
        XCTAssertEqual(st["balance"] as? Double, 9)
        XCTAssertNil(st["spendable"])
        XCTAssertEqual(st["ownerShort"] as? String, "f00000…000000")
        // Offline: only the address.
        MockURL.reset()
        let off = handle(c, ["op": "status"]).sent.first!
        XCTAssertEqual(off["linked"] as? Bool, false)
        XCTAssertNil(off["balance"])
    }

    func testUnlink() {
        let c = AICoin()
        let addr = freshWallet(c)
        MockURL.on("aicoin.test/wallet/api/links/remove", method: "POST", .json(["ok": true]))
        let r = handle(c, ["op": "unlink"])
        XCTAssertNil(r.failed)
        XCTAssertEqual(r.sent.first?["address"] as? String, addr)
        let req = MockURL.seen.first { $0.url.path == "/wallet/api/links/remove" }!
        XCTAssertEqual((try? JSONSerialization.jsonObject(with: req.body)) as? [String: String], ["address": addr])
        XCTAssertEqual(req.headers["X-Api-Key"], addr)
        // The proxy refuses: the error's message reaches the page.
        MockURL.on("aicoin.test/wallet/api/links/remove", method: "POST", .json(["error": "not linked"], status: 404))
        XCTAssertEqual(handle(c, ["op": "unlink"]).failed, "not linked")
        MockURL.on("aicoin.test/wallet/api/links/remove", method: "POST", .text("", status: 500))
        XCTAssertEqual(handle(c, ["op": "unlink"]).failed, "AICoin answered 500.")
    }

    func testHandleKeychainFailure() {
        SharedTestKit.removeWalletItem()
        let c = AICoin()
        c.secAdd = { _, _ in errSecNotAvailable }
        XCTAssertTrue(handle(c, ["op": "status"]).failed?.contains("Keychain") == true)
    }

    func testLinkAlreadyLinked() {
        let c = AICoin()
        let addr = freshWallet(c)
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 1.0, "linked_to": "owner"]))
        let r = handle(c, ["op": "link"])
        let shown = r.sent.first!
        XCTAssertEqual(shown["payload"] as? String, AICoin.linkPayload(address: addr))
        XCTAssertEqual(shown["app"] as? String, "AI UI")
        XCTAssertTrue((shown["qr"] as? String)?.hasPrefix("data:image/png;base64,") == true)
        XCTAssertEqual(shown["linked"] as? Bool, true)
    }

    func testLinkWatchConnects() {
        let c = AICoin()
        freshWallet(c)
        c.watchEvery = 20_000_000
        var calls = 0
        MockURL.on("aicoin.test/wallet/api/balance/") { _ in
            calls += 1
            return calls >= 3 ? .json(["balance": 1.0, "spendable": 50.0, "linked_to": "owner"]) : .json(["balance": 1.0])
        }
        var used = false
        var events: [[String: Any]] = []
        events = SharedTestKit.events(self) {
            let r = handle(c, ["op": "link"], use: { used = true; return true })
            XCTAssertEqual(r.sent.first?["linked"] as? Bool, false)
            waitUntil { used }
            spin(0.1)
        }
        let e = events.first { $0["state"] as? String == "connected" }
        XCTAssertEqual(e?["type"] as? String, "aicoinLink")
        XCTAssertEqual(e?["active"] as? Bool, true)
        XCTAssertEqual(e?["spendable"] as? Double, 50)
        XCTAssertGreaterThanOrEqual(calls, 3)
    }

    func testLinkWatchTimesOut() {
        let c = AICoin()
        freshWallet(c)
        c.watchFor = 0
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 1.0]))
        let events = SharedTestKit.events(self) {
            _ = handle(c, ["op": "link"])
            spin(0.2)
        }
        XCTAssertTrue(events.contains { $0["state"] as? String == "timeout" })
    }

    func testLinkWatchCancelled() {
        let c = AICoin()
        freshWallet(c)
        c.watchEvery = 100_000_000
        var calls = 0
        MockURL.on("aicoin.test/wallet/api/balance/") { _ in calls += 1; return .json(["balance": 1.0]) }
        let events = SharedTestKit.events(self) {
            _ = handle(c, ["op": "link"])
            _ = handle(c, ["op": "cancel"])
            spin(0.3)
        }
        XCTAssertEqual(calls, 1)                     // only the status shown with the code
        XCTAssertTrue(events.isEmpty)
    }

    func testPaymentError() {
        XCTAssertEqual(AICoin.paymentError(["reason": "link_limit", "spendable": 3.7]).localizedDescription,
                       "The AICoin link limit is reached (3 coins left under it). Raise it in the AICoin wallet app.")
        XCTAssertEqual(AICoin.paymentError(["reason": "link_limit"]).localizedDescription,
                       "The AICoin link limit is reached. Raise it in the AICoin wallet app.")
        freshWallet(AICoin.shared)
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 0.0, "linked_to": "owner"]))
        _ = handle(AICoin.shared, ["op": "status"])
        XCTAssertTrue(AICoin.paymentError([:]).localizedDescription.contains("linked to AI UI is out of coins"))
        MockURL.on("aicoin.test/wallet/api/balance/", .json(["balance": 0.0]))
        _ = handle(AICoin.shared, ["op": "status"])
        XCTAssertTrue(AICoin.paymentError([:]).localizedDescription.contains("Link it to your AICoin wallet"))
    }

    func testCallBadURL() {
        let r = SharedTestKit.wait(self) { try await AICoin.call("GET", "/a b\u{0}") }
        XCTAssertNotNil(r.failed)
    }
}
