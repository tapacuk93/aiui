import Foundation
import CryptoKit
import CoreImage
import Security
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AICoinKit)
import AICoinKit
#endif

/// AICoin: AI calls paid in coins through proxy.aicoin.oeaio.com instead of a provider key.
/// AI UI has a wallet of its own (an Ed25519 key in the Keychain), created on first use; it claims
/// its own free starter coins and mints the API tokens the proxy accepts with its own key.
/// The AICoin wallet iPhone app can *link* it (CONTRACT.md, "Linked wallets"): the owner scans a
/// code holding only this wallet's public address and signs the link, and from then on the same
/// tokens are charged to the owner's coins, up to the limit the owner set.
/// Requests keep Anthropic's own shape; `X-AI: anthropic` tells the proxy which provider.
final class AICoin {
    static let shared = AICoin()
    /// `AIUI_AICOIN_PROXY` points at another proxy (a local stub in tests).
    static let proxy = ProcessInfo.processInfo.environment["AIUI_AICOIN_PROXY"] ?? "https://proxy.aicoin.oeaio.com"
    static let appName = "AI UI"

    /// What the AI can spend now: the owner's spendable coins while linked, else this wallet's own.
    var lastBalance: Double?
    /// The last `GET /wallet/api/balance/<address>` answer.
    private(set) var lastStatus: [String: Any]?
    private var token: (value: String, expires: Date)?
    private var watching: UUID?

    /// AICoin is always offered: the wallet is created when first chosen.
    static var available: Bool { true }

    // MARK: Wallet

    #if canImport(AICoinKit)
    private let store = WalletKeychainStore(service: "com.oeaio.aiui.aicoin.wallet")
    private func loadKey() -> Curve25519.Signing.PrivateKey? { (try? store.loadIdentity())?.privateKey }
    private func loadOrCreateKey() throws -> Curve25519.Signing.PrivateKey { try store.loadOrCreateIdentity().privateKey }
    #else
    // The same item AICoinKit's WalletKeychainStore keeps on this device: the 32-byte seed.
    private static let keychain: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                                   kSecAttrService as String: ProcessInfo.processInfo.environment["AIUI_AICOIN_WALLET"] ?? "com.oeaio.aiui.aicoin.wallet",
                                                   kSecAttrAccount as String: "wallet-seed"]
    private func loadKey() -> Curve25519.Signing.PrivateKey? {
        var q = Self.keychain
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let seed = out as? Data else { return nil }
        return try? Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }
    private func loadOrCreateKey() throws -> Curve25519.Signing.PrivateKey {
        if let k = loadKey() { return k }
        let k = Curve25519.Signing.PrivateKey()
        var q = Self.keychain
        q[kSecValueData as String] = k.rawRepresentation
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw aiError("Could not save the AICoin wallet to the Keychain (\(status)).") }
        return k
    }
    #endif

    var address: String? { loadKey().map(AICoinSign.address) }

    /// The engine key for AICoin, if the wallet exists (a fresh token each 24 hours).
    func key() -> Provider.Key? {
        guard let k = loadKey() else { return nil }
        if token == nil || token!.expires < Date().addingTimeInterval(3600) {
            guard let t = try? AICoinSign.token(k, validFor: 86_400) else { return nil }
            token = (t, Date().addingTimeInterval(86_400))
        }
        return Provider.Key(provider: "anthropic", name: "AICoin", key: token!.value, base: Self.proxy,
                            model: "claude-opus-5-5", headers: ["X-AI": "anthropic"])
    }

    /// Creates (or loads) the wallet, claims its own free coins when eligible, and reads the balance.
    func prepare(_ done: @escaping (Result<Double, Error>) -> Void) {
        Task {
            do {
                let k = try loadOrCreateKey()
                var st = try? await status(AICoinSign.address(k))
                if st?["linked_to"] == nil, (st?["balance"] as? Double ?? 0) < 1 {
                    _ = try? await Self.call("POST", "/wallet/api/claim", body: Data(), signer: k)
                    st = (try? await status(AICoinSign.address(k))) ?? st
                }
                await MainActor.run { done(.success(self.lastBalance ?? 0)) }
            } catch {
                await MainActor.run { done(.failure(error)) }
            }
        }
    }

    func refreshBalance() {
        guard let a = address else { return }
        Task { _ = try? await status(a) }
    }

    /// Reads the balance (own coins, and the link if any), remembers it, and tells the page when
    /// the link appeared or went away (the owner can remove it from the wallet app).
    @discardableResult
    private func status(_ address: String) async throws -> [String: Any] {
        let st = try await Self.call("GET", "/wallet/api/balance/\(address)")
        await MainActor.run {
            let was = self.lastStatus?["linked_to"] as? String
            self.lastStatus = st
            let linked = st["linked_to"] as? String
            self.lastBalance = linked != nil ? (st["spendable"] as? Double ?? st["balance"] as? Double)
                                             : st["balance"] as? Double
            if was != nil, linked == nil { API.emit(["type": "aicoinLink", "state": "unlinked"]) }
        }
        return st
    }

    // MARK: The `aicoin` endpoint: link (show the code), cancel, status, unlink

    /// `use` switches the engine to AICoin once the wallet is linked.
    func handle(_ input: [String: Any], use: @escaping () -> Bool,
                send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        let op = input["op"] as? String ?? "status"
        if op == "cancel" { watching = nil; return send(["ok": true]) }
        Task {
            do {
                let k = try loadOrCreateKey()
                let addr = AICoinSign.address(k)
                switch op {
                case "link":
                    let payload = Self.linkPayload(address: addr)
                    guard let qr = Self.qrDataURL(payload) else { throw aiError("Could not draw the code.") }
                    let st = try? await status(addr)
                    let id = UUID()
                    await MainActor.run { self.watching = id }
                    var out = Self.describe(addr, st)
                    out["qr"] = qr; out["payload"] = payload; out["app"] = Self.appName
                    let shown = out
                    await MainActor.run { send(shown) }
                    if st?["linked_to"] == nil { await watch(id, addr, use: use) }
                case "unlink":
                    let body = try JSONSerialization.data(withJSONObject: ["address": addr])
                    _ = try await Self.call("POST", "/wallet/api/links/remove", body: body, signer: k)
                    let st = try? await status(addr)
                    await MainActor.run { send(Self.describe(addr, st)) }
                default:
                    let st = try? await status(addr)
                    await MainActor.run { send(Self.describe(addr, st)) }
                }
            } catch {
                await MainActor.run { fail(error.localizedDescription) }
            }
        }
    }

    /// While the code is on screen: asks for the balance every 2 seconds until `linked_to` appears
    /// (then switches the AI to AICoin), the page cancels, or 30 minutes pass.
    private func watch(_ id: UUID, _ addr: String, use: @escaping () -> Bool) async {
        let until = Date().addingTimeInterval(1800)
        func current() async -> Bool { await MainActor.run { self.watching == id } }
        while await current() {
            if Date() > until {
                await MainActor.run { if self.watching == id { self.watching = nil; API.emit(["type": "aicoinLink", "state": "timeout"]) } }
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard await current(), let st = try? await status(addr), st["linked_to"] is String else { continue }
            await MainActor.run {
                guard self.watching == id else { return }
                self.watching = nil
                var e = Self.describe(addr, st)
                e["type"] = "aicoinLink"; e["state"] = "connected"; e["active"] = use()
                API.emit(e)
            }
            return
        }
    }

    /// What the page shows: the address (and its 6…6 form), whether linked, and the coins.
    private static func describe(_ addr: String, _ st: [String: Any]?) -> [String: Any] {
        var o: [String: Any] = ["address": addr, "short": short(addr), "linked": false]
        guard let st else { return o }
        for k in ["balance", "spendable", "limit", "spent"] { if let v = st[k], !(v is NSNull) { o[k] = v } }
        if let owner = st["linked_to"] as? String { o["linked"] = true; o["owner"] = owner; o["ownerShort"] = short(owner) }
        return o
    }

    static func short(_ a: String) -> String { a.count > 12 ? "\(a.prefix(6))…\(a.suffix(6))" : a }

    /// The code: `aicoin:link?address=<64 hex>&app=<percent-encoded name>`. Public address only.
    static func linkPayload(address: String, app: String = appName) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return "aicoin:link?address=\(address)&app=\(app.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
    }

    /// A proxy `402` as something to tell the user: the link's limit, or the coins ran out.
    static func paymentError(_ obj: [String: Any]) -> NSError {
        if obj["reason"] as? String == "link_limit" {
            let left = (obj["spendable"] as? Double).map { " (\(Int($0)) coins left under it)" } ?? ""
            return aiError("The AICoin link limit is reached\(left). Raise it in the AICoin wallet app.")
        }
        if shared.lastStatus?["linked_to"] is String {
            return aiError("The AICoin wallet linked to AI UI is out of coins. Add coins in the AICoin wallet app.")
        }
        return aiError("AI UI's AICoin wallet is out of coins. Link it to your AICoin wallet (AI Provider › Link AICoin wallet) or add coins.")
    }

    // MARK: Network

    /// One JSON call to the proxy, live-signed when a signer is given; a non-2xx answer throws
    /// with the HTTP status as the error code.
    static func call(_ method: String, _ path: String, body: Data? = nil,
                     signer: Curve25519.Signing.PrivateKey? = nil) async throws -> [String: Any] {
        guard let url = URL(string: proxy + path) else { throw aiError("bad URL") }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let signer {
            for (h, v) in try AICoinSign.liveHeaders(signer, method: method, path: path, body: body ?? Data()) {
                req.setValue(v, forHTTPHeaderField: h)
            }
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw NSError(domain: "aicoin", code: code,
                          userInfo: [NSLocalizedDescriptionKey: obj["error"] as? String ?? "AICoin answered \(code)."])
        }
        return obj
    }

    // MARK: QR

    /// The code drawn locally (CoreImage), black on white with a quiet zone, as a PNG data URL.
    static func qrDataURL(_ text: String) -> String? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let code = f.outputImage else { return nil }
        let scaled = code.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let margin: CGFloat = 4 * 12
        let canvas = scaled.extent.insetBy(dx: -margin, dy: -margin)
        let image = scaled.composited(over: CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: canvas))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let png = CIContext().pngRepresentation(of: image, format: .RGBA8, colorSpace: space) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}

/// CONTRACT.md's two signatures, exactly as AICoinKit's WalletSigner makes them.
enum AICoinSign {
    static func hex<D: DataProtocol>(_ d: D) -> String { d.map { String(format: "%02x", $0) }.joined() }

    static func base64url<D: DataProtocol>(_ d: D) -> String {
        Data(d).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// The address: the hex of the raw 32-byte public key.
    static func address(_ k: Curve25519.Signing.PrivateKey) -> String { hex(k.publicKey.rawRepresentation) }

    /// An API token: `<base64url(payload)>.<base64url(signature)>`, payload `{"addr","iat","exp"}`,
    /// the signature over the base64url payload string's bytes.
    static func token(_ k: Curve25519.Signing.PrivateKey, validFor: TimeInterval, now: Date = Date()) throws -> String {
        let iat = Int(now.timeIntervalSince1970), exp = iat + Int(validFor)
        let payload = base64url(Data("{\"addr\":\"\(address(k))\",\"iat\":\(iat),\"exp\":\(exp)}".utf8))
        return payload + "." + base64url(try k.signature(for: Data(payload.utf8)))
    }

    /// Live-signature headers: the signature over
    /// `address \n timestampMillis \n METHOD \n path-without-query \n hex(sha256(body))`, raw R‖S in hex.
    static func liveHeaders(_ k: Curve25519.Signing.PrivateKey, method: String, path: String, body: Data,
                            now: Date = Date()) throws -> [String: String] {
        let addr = address(k), ts = Int64((now.timeIntervalSince1970 * 1000).rounded())
        let bare = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        let message = "\(addr)\n\(ts)\n\(method)\n\(bare)\n\(hex(Data(SHA256.hash(data: body))))"
        return ["X-Api-Key": addr, "X-Api-Signature": hex(try k.signature(for: Data(message.utf8))),
                "X-Api-Timestamp": String(ts)]
    }
}
