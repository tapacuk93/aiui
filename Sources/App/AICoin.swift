import Foundation
import CoreImage
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AICoinKit)
import AICoinKit
#endif

/// AICoin: AI calls paid in coins through proxy.aicoin.oeaio.com instead of a provider key.
/// The wallet (an Ed25519 key in iCloud Keychain, shared across the user's devices) is created
/// on first use, claims the free starter coins, and mints the API token the proxy accepts.
/// Requests keep Anthropic's own shape; `X-AI: anthropic` tells the proxy which provider.
final class AICoin {
    static let shared = AICoin()
    static let proxy = "https://proxy.aicoin.oeaio.com"
    var lastBalance: Double?

    /// AICoin is offered when this build has its own wallet, or a wallet was connected by QR.
    static var available: Bool { hasKit || AICoinLink.shared.connected != nil }

    #if canImport(AICoinKit)
    static let hasKit = true
    private let store = WalletKeychainStore(service: "com.oeaio.aiui.aicoin.wallet")
    private let client = WalletClient()
    private var token: (value: String, expires: Date)?

    /// The engine key for AICoin, if a wallet exists (a fresh token each 24 hours).
    func key() -> Provider.Key? {
        if let linked = AICoinLink.shared.key() { return linked }
        guard let identity = try? store.loadIdentity() else { return nil }
        if token == nil || token!.expires < Date().addingTimeInterval(3600) {
            guard let t = try? WalletSigner.issueAPIToken(identity: identity, validFor: 86_400) else { return nil }
            token = (t, Date().addingTimeInterval(86_400))
        }
        return Provider.Key(provider: "anthropic", name: "AICoin", key: token!.value, base: Self.proxy,
                            model: "claude-opus-5-5", headers: ["X-AI": "anthropic"])
    }

    /// Creates (or loads) the wallet, claims free coins when eligible, and reads the balance.
    func prepare(_ done: @escaping (Result<Double, Error>) -> Void) {
        if AICoinLink.shared.connected != nil { return AICoinLink.shared.prepare(done) }
        Task {
            do {
                let identity = try store.loadOrCreateIdentity()
                var balance = (try? await client.balance(address: identity.address)) ?? 0
                if balance < 1 {
                    let claim = try? await client.claimFreeCoins(identity: identity)
                    if claim?.granted == true { balance = (try? await client.balance(address: identity.address)) ?? balance }
                }
                lastBalance = balance
                await MainActor.run { done(.success(balance)) }
            } catch {
                await MainActor.run { done(.failure(error)) }
            }
        }
    }

    func refreshBalance() {
        if AICoinLink.shared.connected != nil { return AICoinLink.shared.refreshBalance() }
        guard let identity = try? store.loadIdentity() else { return }
        Task { lastBalance = try? await client.balance(address: identity.address) }
    }
    #else
    static let hasKit = false
    func key() -> Provider.Key? { AICoinLink.shared.key() }
    func prepare(_ done: @escaping (Result<Double, Error>) -> Void) {
        if AICoinLink.shared.connected != nil { return AICoinLink.shared.prepare(done) }
        done(.failure(aiError("Connect your AICoin wallet by scanning a code with the AICoin wallet app.")))
    }
    func refreshBalance() { AICoinLink.shared.refreshBalance() }
    #endif
}

/// A wallet connected from the AICoin wallet iOS app by scanning a code (CONTRACT.md, "Authorising
/// a service by showing it a code"). The app asks the proxy for an authorisation, shows its id as a
/// QR, and collects the token the wallet mints once the owner taps Allow. The secret the token is
/// collected with stays here: it never goes to the page, nor into the code on screen.
/// The token (it names the grant, so the owner can revoke this app alone) is kept in the Keychain.
final class AICoinLink {
    static let shared = AICoinLink()
    static let service = "aiui"

    struct Connected: Codable {
        var token: String
        var address: String
        var expires: Date
        var connected: Date
    }

    private struct Pending { let id: String; let secret: String; let expires: Date }
    private var pending: Pending?
    private var cached: Connected??

    /// The connected wallet, while its token is valid.
    var connected: Connected? {
        if cached == nil { cached = .some(Self.load()) }
        guard let c = cached!, c.expires > Date() else { return nil }
        return c
    }

    func key() -> Provider.Key? {
        guard let c = connected else { return nil }
        return Provider.Key(provider: "anthropic", name: "AICoin", key: c.token, base: AICoin.proxy,
                            model: "claude-opus-5-5", headers: ["X-AI": "anthropic"])
    }

    /// The `aicoin` endpoint: connect (start, returns the QR), cancel, status, disconnect.
    /// `use` switches the engine to AICoin once a wallet is connected.
    func handle(_ input: [String: Any], use: @escaping () -> Bool,
                send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        switch input["op"] as? String ?? "status" {
        case "connect":
            start(use: use, send: send, fail: fail)
        case "cancel":
            pending = nil
            send(status())
        case "disconnect":
            pending = nil
            Self.delete(); cached = .some(nil)
            AICoin.shared.lastBalance = nil
            send(status())
        default:
            send(status())
        }
    }

    func status() -> [String: Any] {
        guard let c = connected else { return ["connected": false] }
        var o: [String: Any] = ["connected": true, "address": c.address,
                                "expires": Int(c.expires.timeIntervalSince1970)]
        if let b = AICoin.shared.lastBalance { o["balance"] = b }
        return o
    }

    private func start(use: @escaping () -> Bool, send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        Task {
            do {
                let note = "AI UI on \(await Self.deviceName())"
                let r = try await Self.json("POST", "/wallet/api/authorize/new", body: ["service": Self.service, "note": note])
                guard let id = r["id"] as? String, let secret = r["secret"] as? String,
                      id.range(of: "^[0-9a-f-]{1,64}$", options: .regularExpression) != nil else {
                    throw aiError("The AICoin service gave an unexpected answer.")
                }
                let ttl = (r["expires_in"] as? Double) ?? 600
                // The code holds the id alone: the AICoin wallet app takes a bare id (or a link ending in one).
                guard let qr = Self.qrDataURL(id) else { throw aiError("Could not draw the code.") }
                let p = Pending(id: id, secret: secret, expires: Date().addingTimeInterval(ttl))
                await MainActor.run {
                    self.pending = p
                    send(["qr": qr, "payload": id, "expiresIn": Int(ttl), "service": Self.service, "note": note])
                }
                await poll(p, use: use)
            } catch {
                await MainActor.run { fail(error.localizedDescription) }
            }
        }
    }

    /// Asks every 2 seconds until the wallet allows it, the request expires, or it is cancelled.
    private func poll(_ p: Pending, use: @escaping () -> Bool) async {
        func current() async -> Bool { await MainActor.run { self.pending?.id == p.id } }
        while await current() {
            if Date() > p.expires { return await finish(p, ["type": "aicoinLink", "state": "expired"]) }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard await current() else { return }
            let r: [String: Any]
            do { r = try await Self.json("GET", "/wallet/api/authorize/\(p.id)?secret=\(p.secret)") }
            catch let e as NSError where e.domain == "aicoin" && e.code == 404 {
                // Gone: expired (ten minutes) - the secret is ours, so nobody else collected it.
                return await finish(p, ["type": "aicoinLink", "state": "expired"])
            } catch { continue }                   // offline for a moment: keep asking until it expires
            guard r["status"] as? String == "granted", let token = r["token"] as? String else { continue }
            guard let payload = Self.payload(of: token), let addr = payload["addr"] as? String,
                  addr.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
                return await finish(p, ["type": "aicoinLink", "state": "failed", "error": "The wallet sent a token this app can't read."])
            }
            let exp = (payload["exp"] as? Double).map { Date(timeIntervalSince1970: $0) } ?? Date().addingTimeInterval(7 * 86_400)
            let c = Connected(token: token, address: addr, expires: exp, connected: Date())
            guard Self.save(c) else {
                return await finish(p, ["type": "aicoinLink", "state": "failed", "error": "Could not save the wallet to the Keychain."])
            }
            let balance = try? await Self.balance(addr)
            await MainActor.run {
                self.cached = .some(c)
                if let balance { AICoin.shared.lastBalance = balance }
                let switched = use()
                var e: [String: Any] = ["type": "aicoinLink", "state": "connected", "address": addr,
                                        "expires": Int(exp.timeIntervalSince1970), "active": switched]
                if let balance { e["balance"] = balance }
                if self.pending?.id == p.id { self.pending = nil }
                API.emit(e)
            }
            return
        }
    }

    private func finish(_ p: Pending, _ event: [String: Any]) async {
        await MainActor.run {
            guard self.pending?.id == p.id else { return }
            self.pending = nil
            API.emit(event)
        }
    }

    func prepare(_ done: @escaping (Result<Double, Error>) -> Void) {
        guard let c = connected else { return done(.failure(aiError("No AICoin wallet is connected."))) }
        Task {
            let b = try? await Self.balance(c.address)
            await MainActor.run {
                if let b { AICoin.shared.lastBalance = b }
                done(.success(b ?? AICoin.shared.lastBalance ?? 0))
            }
        }
    }

    func refreshBalance() {
        guard let c = connected else { return }
        Task {
            guard let b = try? await Self.balance(c.address) else { return }
            await MainActor.run { AICoin.shared.lastBalance = b }
        }
    }

    // MARK: Network

    static func balance(_ address: String) async throws -> Double {
        let r = try await json("GET", "/wallet/api/balance/\(address)")
        guard let b = r["balance"] as? Double else { throw aiError("No balance in the answer.") }
        return b
    }

    /// One JSON call to the proxy; a non-2xx answer throws with the HTTP status as the error code.
    private static func json(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let url = URL(string: AICoin.proxy + path) else { throw aiError("bad URL") }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
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

    /// The token's payload: `<base64url(json)>.<base64url(signature)>`.
    static func payload(of token: String) -> [String: Any]? {
        guard let part = token.split(separator: ".").first else { return nil }
        var b64 = part.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
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
        let ctx = CIContext(options: [.useSoftwareRenderer: false])
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let png = ctx.pngRepresentation(of: image, format: .RGBA8, colorSpace: space) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    // MARK: Device

    static func deviceName() async -> String {
        #if os(macOS)
        return await Task.detached { Host.current().localizedName ?? "this Mac" }.value
        #else
        return await MainActor.run { UIDevice.current.name }
        #endif
    }

    // MARK: Keychain (as Provider keys: synced through iCloud Keychain where available)

    private static let keychainService = "com.oeaio.aiui.aicoin.link"

    private static func load() -> Connected? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Connected.self, from: data)
    }

    private static func save(_ c: Connected) -> Bool {
        delete()
        guard let data = try? JSONEncoder().encode(c) else { return false }
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                kSecAttrAccount as String: c.address, kSecValueData as String: data,
                                kSecAttrSynchronizable as String: true]
        if SecItemAdd(q as CFDictionary, nil) == errSecSuccess { return true }
        q[kSecAttrSynchronizable as String] = false
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    private static func delete() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                       kSecAttrSynchronizable as String: kSecAttrSynchronizableAny] as CFDictionary)
    }
}
