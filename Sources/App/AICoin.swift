import Foundation
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
    private(set) var lastBalance: Double?

    #if canImport(AICoinKit)
    static let available = true
    private let store = WalletKeychainStore(service: "com.oeaio.aiui.aicoin.wallet")
    private let client = WalletClient()
    private var token: (value: String, expires: Date)?

    /// The engine key for AICoin, if a wallet exists (a fresh token each 24 hours).
    func key() -> Provider.Key? {
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
        guard let identity = try? store.loadIdentity() else { return }
        Task { lastBalance = try? await client.balance(address: identity.address) }
    }
    #else
    static let available = false
    func key() -> Provider.Key? { nil }
    func prepare(_ done: @escaping (Result<Double, Error>) -> Void) {
        done(.failure(aiError("AICoin is available in the App Store builds of AI UI.")))
    }
    func refreshBalance() {}
    #endif
}
