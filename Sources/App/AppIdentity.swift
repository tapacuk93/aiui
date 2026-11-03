import CryptoKit
import Foundation
import Security

/// This installation's app id (docs/shared-and-users.md, "App identity"): an Ed25519 keypair
/// created on first use, the private key kept in the Keychain on this device only (separate from
/// the AICoin wallet key). The id is the lowercase hex of the 32-byte raw public key.
/// Writes to shared.aiui.oeaio.com and users.aiui.oeaio.com are signed with it.
final class AppIdentity {
    static let shared = AppIdentity()

    /// `AIUI_IDENTITY_SERVICE` keeps a test identity apart from the real one.
    private let keychain: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: ProcessInfo.processInfo.environment["AIUI_IDENTITY_SERVICE"] ?? "com.oeaio.aiui.identity",
        kSecAttrAccount as String: "app-id-seed",
    ]
    private var cached: Curve25519.Signing.PrivateKey?
    private let lock = NSLock()

    /// A given key (tests); the shared instance reads the Keychain.
    init(key: Curve25519.Signing.PrivateKey? = nil) { cached = key }

    /// The signing key, created and saved on first use.
    func key() throws -> Curve25519.Signing.PrivateKey {
        lock.lock(); defer { lock.unlock() }
        if let k = cached { return k }
        var q = keychain
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let seed = out as? Data,
           let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) {
            cached = k
            return k
        }
        let k = Curve25519.Signing.PrivateKey()
        var add = keychain
        add[kSecValueData as String] = k.rawRepresentation
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: "aiui.identity", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Could not save the app id to the Keychain (\(status))."])
        }
        cached = k
        return k
    }

    /// The app id (64 hex), creating the key if needed.
    var id: String? { (try? key()).map { Self.hex($0.publicKey.rawRepresentation) } }

    static func short(_ id: String) -> String { id.count > 12 ? "\(id.prefix(6))…\(id.suffix(6))" : id }

    // MARK: Signing (exactly as the contract)

    static func hex<S: Sequence>(_ d: S) -> String where S.Element == UInt8 { d.map { String(format: "%02x", $0) }.joined() }

    static func base64url<D: DataProtocol>(_ d: D) -> String {
        Data(d).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// `aiui/v1\n<METHOD>\n<path>\n<X-AIUI-Time>\n<sha256 hex of the raw body>`; the path without
    /// host or query.
    static func message(method: String, path: String, time: Int64, body: Data) -> String {
        let bare = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? path
        return "aiui/v1\n\(method.uppercased())\n\(bare)\n\(time)\n\(hex(SHA256.hash(data: body)))"
    }

    /// The three headers of a signed request.
    func headers(method: String, path: String, body: Data, now: Date = Date()) throws -> [String: String] {
        let k = try key()
        let time = Int64((now.timeIntervalSince1970 * 1000).rounded())
        let msg = Self.message(method: method, path: path, time: time, body: body)
        return ["X-AIUI-Id": Self.hex(k.publicKey.rawRepresentation),
                "X-AIUI-Time": String(time),
                "X-AIUI-Signature": Self.base64url(try k.signature(for: Data(msg.utf8)))]
    }
}

/// JSON over HTTPS to the two services. Base URLs: `AIUI_SHARED_URL`, `AIUI_USERS_URL`.
enum Services {
    static let sharedURL = base("AIUI_SHARED_URL", "https://shared.aiui.oeaio.com")
    static let usersURL = base("AIUI_USERS_URL", "https://users.aiui.oeaio.com")
    private static func base(_ env: String, _ fallback: String) -> String {
        var s = ProcessInfo.processInfo.environment[env] ?? fallback
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// A service error: the HTTP status as the code, the server's `error` as the message.
    static func error(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "aiui.services", code: code, userInfo: [NSLocalizedDescriptionKey: msg])
    }

    /// One request. `signed` adds the identity headers (GETs sign an empty body). Returns the raw
    /// body of a 2xx answer; anything else throws with the server's message.
    static func raw(_ base: String, _ method: String, _ path: String, query: [String: String] = [:],
                    json: Any? = nil, signed: Bool = false, identity: AppIdentity = .shared) async throws -> Data {
        guard var comps = URLComponents(string: base + path) else { throw error(400, "bad URL") }
        if !query.isEmpty { comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = comps.url else { throw error(400, "bad URL") }
        var req = URLRequest(url: url, timeoutInterval: 25)
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        var body = Data()
        if let json {
            body = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if signed {
            // The exact request path the server sees (a base URL may carry a prefix).
            for (h, v) in try identity.headers(method: method, path: url.path.isEmpty ? "/" : url.path, body: body) {
                req.setValue(v, forHTTPHeaderField: h)
            }
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw error(code, obj?["error"] as? String ?? "\(url.host ?? "service") answered \(code).")
        }
        return data
    }

    /// One request answered with a JSON object.
    static func call(_ base: String, _ method: String, _ path: String, query: [String: String] = [:],
                     json: Any? = nil, signed: Bool = false) async throws -> [String: Any] {
        let data = try await raw(base, method, path, query: query, json: json, signed: signed)
        if data.isEmpty { return [:] }
        guard let obj = try? JSONSerialization.jsonObject(with: data) else { throw error(502, "The service answered with something that is not JSON.") }
        if let d = obj as? [String: Any] { return d }
        if let a = obj as? [Any] { return ["items": a] }
        return [:]
    }

    static func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
    static func date(_ s: Any?) -> Date? {
        guard let s = s as? String else { return nil }
        let f = ISO8601DateFormatter()
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)
    }
}
