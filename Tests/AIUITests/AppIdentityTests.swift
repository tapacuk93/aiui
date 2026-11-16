import CryptoKit
import XCTest
@testable import AIUI

/// Helpers for the shared / users / AICoin tests.
enum SharedTestKit {
    /// Removes the test identity's Keychain item (the test-only service).
    static func removeIdentityItem() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                       kSecAttrService as String: TestEnv.keychainPrefix + ".identity"] as CFDictionary)
    }
    static func removeWalletItem() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                       kSecAttrService as String: TestEnv.keychainPrefix + ".wallet"] as CFDictionary)
    }
    /// Runs an async throwing body to completion on a background task, spinning the main loop
    /// (the code under test hops to the main actor).
    static func wait<T>(_ test: AIUITestCase, timeout: TimeInterval = 10, _ body: @escaping () async throws -> T) -> Result<T, Error> {
        let box = SharedTestBox<Result<T, Error>>()
        Task.detached {
            let r: Result<T, Error>
            do { r = .success(try await body()) } catch { r = .failure(error) }
            box.set(r)
        }
        test.waitUntil(timeout) { box.get() != nil }
        return box.get() ?? .failure(NSError(domain: "test", code: -1))
    }
    /// Captures the events the app pushes into the page (API.emit) while `body` runs.
    static func events(_ test: AIUITestCase, _ body: () -> Void) -> [[String: Any]] {
        var js: [String] = []
        let old = API.evalJS
        API.evalJS = { js.append($0) }
        defer { API.evalJS = old }
        body()
        test.spin()
        return js.compactMap { s -> [String: Any]? in
            guard let a = s.range(of: "aiui._event("), s.hasSuffix(")") else { return nil }
            let inner = s[a.upperBound..<s.index(before: s.endIndex)]
            return (try? JSONSerialization.jsonObject(with: Data(inner.utf8))) as? [String: Any]
        }
    }
}

/// A value set from another thread.
final class SharedTestBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T?
    func set(_ x: T) { lock.lock(); v = x; lock.unlock() }
    func get() -> T? { lock.lock(); defer { lock.unlock() }; return v }
}

extension Result {
    var succeeded: Success? { if case .success(let v) = self { return v }; return nil }
    var failed: Error? { if case .failure(let e) = self { return e }; return nil }
}

final class AppIdentityTests: AIUITestCase {
    func testGivenKeyAndId() throws {
        let k = Curve25519.Signing.PrivateKey()
        let id = AppIdentity(key: k)
        XCTAssertEqual(try id.key().rawRepresentation, k.rawRepresentation)
        XCTAssertEqual(id.id, AppIdentity.hex(k.publicKey.rawRepresentation))
        XCTAssertEqual(id.id?.count, 64)
    }

    func testKeychainCreateThenLoad() throws {
        SharedTestKit.removeIdentityItem()
        let a = AppIdentity()
        let k1 = try a.key()
        XCTAssertEqual(try a.key().rawRepresentation, k1.rawRepresentation)   // cached
        let b = AppIdentity()                                                   // read back from the Keychain
        b.secAdd = { _, _ in XCTFail("must not add again"); return errSecSuccess }
        XCTAssertEqual(try b.key().rawRepresentation, k1.rawRepresentation)
        SharedTestKit.removeIdentityItem()
    }

    func testKeychainSaveFails() {
        SharedTestKit.removeIdentityItem()
        let a = AppIdentity()
        a.secAdd = { _, _ in errSecNotAvailable }
        XCTAssertThrowsError(try a.key()) { e in
            XCTAssertEqual((e as NSError).domain, "aiui.identity")
            XCTAssertEqual((e as NSError).code, Int(errSecNotAvailable))
            XCTAssertTrue(e.localizedDescription.contains("Could not save the app id"))
        }
        XCTAssertNil(a.id)
    }

    func testShort() {
        XCTAssertEqual(AppIdentity.short("abc"), "abc")
        XCTAssertEqual(AppIdentity.short("0123456789abcdef"), "012345…abcdef")
    }

    func testHexBase64urlMessage() {
        XCTAssertEqual(AppIdentity.hex([0, 15, 255]), "000fff")
        XCTAssertEqual(AppIdentity.base64url(Data([0xfb, 0xff])), "-_8")
        let m = AppIdentity.message(method: "post", path: "/v1/items?x=1", time: 42, body: Data())
        XCTAssertEqual(m, "aiui/v1\nPOST\n/v1/items\n42\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(AppIdentity.message(method: "GET", path: "", time: 1, body: Data()).split(separator: "\n", omittingEmptySubsequences: false)[2], "")
    }

    func testHeadersVerify() throws {
        let k = Curve25519.Signing.PrivateKey()
        let h = try AppIdentity(key: k).headers(method: "PUT", path: "/v1/profile", body: Data("{}".utf8), now: Date(timeIntervalSince1970: 1.0004))
        XCTAssertEqual(h["X-AIUI-Id"], AppIdentity.hex(k.publicKey.rawRepresentation))
        XCTAssertEqual(h["X-AIUI-Time"], "1000")
        var b64 = h["X-AIUI-Signature"]!.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let msg = AppIdentity.message(method: "PUT", path: "/v1/profile", time: 1000, body: Data("{}".utf8))
        XCTAssertTrue(k.publicKey.isValidSignature(Data(base64Encoded: b64)!, for: Data(msg.utf8)))
    }

    // MARK: Services

    func testBaseURLsAndHelpers() {
        XCTAssertEqual(Services.sharedURL, "https://shared.test")
        XCTAssertEqual(Services.usersURL, "https://users.test")
        let e = Services.error(418, "teapot")
        XCTAssertEqual(e.code, 418); XCTAssertEqual(e.localizedDescription, "teapot")
        let d = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(Services.iso(d), "2023-11-14T22:13:20Z")
        XCTAssertEqual(Services.date("2023-11-14T22:13:20Z"), d)
        XCTAssertEqual(Services.date("2023-11-14T22:13:20.500Z"), d.addingTimeInterval(0.5))
        XCTAssertNil(Services.date(5))
        XCTAssertNil(Services.date("nope"))
    }

    func testRawSignedWithQueryAndJSON() throws {
        MockURL.on("shared.test/v1/thing", .json(["ok": true]))
        let ident = AppIdentity(key: Curve25519.Signing.PrivateKey())
        let r = SharedTestKit.wait(self) {
            try await Services.call("https://shared.test", "POST", "/v1/thing", query: ["b": "2", "a": "1"], json: ["z": 1, "a": 2], signed: true, identity: ident)
        }
        XCTAssertEqual(r.succeeded?["ok"] as? Bool, true)
        let seen = MockURL.seen.last!
        XCTAssertEqual(seen.url.absoluteString, "https://shared.test/v1/thing?a=1&b=2")
        XCTAssertEqual(seen.method, "POST")
        XCTAssertEqual(String(decoding: seen.body, as: UTF8.self), #"{"a":2,"z":1}"#)
        XCTAssertEqual(seen.headers["Content-Type"], "application/json")
        XCTAssertEqual(seen.headers["X-AIUI-Id"], ident.id)
        XCTAssertNotNil(seen.headers["X-AIUI-Signature"])
    }

    func testCallShapes() {
        MockURL.on("/empty", .text(""))
        MockURL.on("/array", .json([1, 2]))
        MockURL.on("/scalar", .text("5"))
        MockURL.on("/notjson", .text("<html>"))
        XCTAssertEqual(SharedTestKit.wait(self) { try await Services.call("https://x.test", "GET", "/empty") }.succeeded?.count, 0)
        XCTAssertEqual((SharedTestKit.wait(self) { try await Services.call("https://x.test", "GET", "/array") }.succeeded?["items"] as? [Int]), [1, 2])
        XCTAssertEqual((SharedTestKit.wait(self) { try await Services.call("https://x.test", "GET", "/scalar") }.failed as NSError?)?.code, 502)
        let e = SharedTestKit.wait(self) { try await Services.call("https://x.test", "GET", "/notjson") }.failed as NSError?
        XCTAssertEqual(e?.code, 502)
        XCTAssertNil(MockURL.seen.last?.headers["X-AIUI-Id"])
    }

    func testErrors() {
        MockURL.on("/withmsg", .json(["error": "nope"], status: 403))
        MockURL.on("/bare", .text("x", status: 500))
        let a = SharedTestKit.wait(self) { try await Services.raw("https://x.test", "GET", "/withmsg") }.failed as NSError?
        XCTAssertEqual(a?.code, 403); XCTAssertEqual(a?.localizedDescription, "nope")
        let b = SharedTestKit.wait(self) { try await Services.raw("https://x.test", "GET", "/bare") }.failed as NSError?
        XCTAssertEqual(b?.code, 500); XCTAssertEqual(b?.localizedDescription, "x.test answered 500.")
        let c = SharedTestKit.wait(self) { try await Services.raw("https://x .test", "GET", "/bad url") }.failed as NSError?
        XCTAssertEqual(c?.code, 400); XCTAssertEqual(c?.localizedDescription, "bad URL")
        // A signed call whose identity can't make a key fails before sending.
        SharedTestKit.removeIdentityItem()
        let broken = AppIdentity(); broken.secAdd = { _, _ in errSecNotAvailable }
        let n = MockURL.seen.count
        let d = SharedTestKit.wait(self) { try await Services.raw("https://x.test", "GET", "/bare", signed: true, identity: broken) }.failed as NSError?
        XCTAssertEqual(d?.domain, "aiui.identity")
        XCTAssertEqual(MockURL.seen.count, n)
    }
}
