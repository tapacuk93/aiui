import XCTest
import CryptoKit
@testable import AIUI

// MARK: - Fakes shared by the API tests

/// A scripted AI engine: records prompts, answers with the next scripted result (or holds the
/// callback until `answer` when nothing is scripted).
final class FakeEngine: AIEngine {
    let id: String, persistent: Bool, systemPrompt: String, schema: String
    var label: String { "Fake \(id)" }
    var prompts: [String] = []
    var script: [Result<[String: Any], Error>] = []
    var progressLines: [String] = []
    var held: ((Result<[String: Any], Error>) -> Void)?
    var cancels = 0, resets = 0

    init(id: String, persistent: Bool, systemPrompt: String, schema: String) {
        self.id = id; self.persistent = persistent; self.systemPrompt = systemPrompt; self.schema = schema
    }

    func next(prompt: String, progress: @escaping (String) -> Void, done: @escaping (Result<[String: Any], Error>) -> Void) {
        prompts.append(prompt)
        for l in progressLines { progress(l) }
        if script.isEmpty { held = done } else { done(script.removeFirst()) }
    }
    func cancel() { cancels += 1 }
    func reset() { resets += 1 }
    func answer(_ r: Result<[String: Any], Error>) { let d = held; held = nil; d?(r) }

    func succeed(_ obj: [String: Any]) { script.append(.success(obj)) }
    func failWith(_ msg: String) { script.append(.failure(aiError(msg))) }

    /// The JSON block of the last prompt (between ```json and ```), or the whole prompt as JSON.
    var lastInput: [String: Any] {
        guard let p = prompts.last else { return [:] }
        var text = p
        if let a = p.range(of: "```json\n"), let b = p.range(of: "\n```", range: a.upperBound..<p.endIndex) {
            text = String(p[a.upperBound..<b.lowerBound])
        } else if let a = p.range(of: "<<<SHARED-ITEM\n"), let b = p.range(of: "\nSHARED-ITEM>>>") {
            text = String(p[a.upperBound..<b.lowerBound])
        }
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
    }
}

/// A reply from handleAPI.
final class Answer {
    var status: Int?
    var data = Data()
    var json: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
    var error: String? { json["error"] as? String }
}

/// Base for API tests: fake engines (a fake `claude` CLI is "installed" so the API picks it),
/// captured page events, temp folders; restores API's global hooks afterwards.
class APITestCase: AIUITestCase {
    var api: API!
    var support: URL!, device: URL!
    var events: [[String: Any]] = []
    var built: [FakeEngine] = []
    private var saved: (eval: (String) -> Void, address: (([String], [(String, String)]) -> Void)?, full: ((Bool) -> Void)?,
                        paused: Bool, web: URL?, factory: ((String, Bool, String, String) -> AIEngine)?)!

    static let walletService = ProcessInfo.processInfo.environment["AIUI_AICOIN_WALLET"] ?? "none"

    override func setUp() {
        super.setUp()
        saved = (API.evalJS, API.setAddress, API.setFullScreen, API.paused, API.webRoot, API.engineFactory)
        API.paused = false
        API.evalJS = { [weak self] js in
            guard let a = js.range(of: "aiui._event("), js.hasSuffix(")") else { return }
            let body = String(js[a.upperBound..<js.index(before: js.endIndex)])
            if let o = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any] { self?.events.append(o) }
        }
        API.engineFactory = { [weak self] id, p, sp, sc in
            let e = FakeEngine(id: id, persistent: p, systemPrompt: sp, schema: sc)
            self?.built.append(e)
            return e
        }
        TestEnv.fakeTool("claude", "exit 1")
        support = TestEnv.tempDir("support")
        device = TestEnv.tempDir("device")
    }

    override func tearDown() {
        spin()                                         // events still queued belong to this test
        api?.shutdown()
        api = nil
        API.evalJS = saved.eval; API.setAddress = saved.address; API.setFullScreen = saved.full
        API.paused = saved.paused; API.webRoot = saved.web; API.engineFactory = saved.factory
        for t in ["claude", "codex", "gemini"] { TestEnv.removeFake(t) }
        Provider.deleteKey()
        Self.removeWallet()
        AICoin.shared.lastBalance = nil
        super.tearDown()
    }

    /// The page hook as it was before this test (the do-nothing default unless a host set one).
    var originalEvalJS: (String) -> Void { saved.eval }

    @discardableResult
    func makeAPI() -> API {
        api = API(support: support, device: device)
        return api
    }

    func fake(_ e: AIEngine?, file: StaticString = #filePath, line: UInt = #line) -> FakeEngine {
        guard let f = e as? FakeEngine else { XCTFail("not a fake engine", file: file, line: line); return FakeEngine(id: "?", persistent: false, systemPrompt: "", schema: "") }
        return f
    }

    /// Sends a request; the answer fills in when the endpoint replies.
    func request(_ path: String, _ body: [String: Any] = [:]) -> Answer {
        let a = Answer()
        api.handleAPI(path, body: (try? JSONSerialization.data(withJSONObject: body)) ?? Data()) { status, mime, data in
            XCTAssertEqual(mime, "application/json")
            a.status = status; a.data = data
        }
        return a
    }

    /// Sends a request and waits for its answer.
    @discardableResult
    func call(_ path: String, _ body: [String: Any] = [:], timeout: TimeInterval = 5,
              file: StaticString = #filePath, line: UInt = #line) -> Answer {
        let a = request(path, body)
        waitUntil(timeout, file: file, line: line) { a.status != nil }
        return a
    }

    /// Page events of a type (after letting queued main-queue work run).
    func events(_ type: String) -> [[String: Any]] {
        spin()
        return events.filter { $0["type"] as? String == type }
    }

    // Keychain items in the test-only services.
    static func putWallet(_ seed: Data = Curve25519.Signing.PrivateKey().rawRepresentation) {
        removeWallet()
        SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: walletService,
                    kSecAttrAccount as String: "wallet-seed", kSecValueData as String: seed] as CFDictionary, nil)
    }
    static func removeWallet() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: walletService] as CFDictionary)
    }
    static let anthropicKey = Provider.Key(provider: "anthropic", name: "Anthropic", key: "sk-ant-test", base: "https://api.anthropic.test", model: "claude-test")

    /// Stores a scene as if the user had opened it: a cached outcome plus usage.
    @discardableResult
    func scene(_ name: String, html: String = "<div>app</div>", kind: String = "html", title: String? = nil,
               cacheable: Bool = false, opened: Bool = true) -> String {
        let action: [String: Any] = ["event": "open", "path": [name], "language": api.language]
        let key = Cache.key(for: action)
        var outcome: [String: Any] = ["kind": kind, "title": title ?? name, "note": "opened \(name)", "cacheable": cacheable]
        if kind == "html" { outcome["html"] = html } else { outcome["circles"] = [["label": "x"]] }
        api.cache.store(key: key, action: action, flow: [], outcome: outcome)
        api.usage.record(["key": key, "title": title ?? name, "opened": opened])
        return key
    }
}

// MARK: - Engine choice

final class APIEngineTests: APITestCase {
    func testDefaultDeviceIsApplicationSupport() {
        XCTAssertTrue(API.defaultDevice.path.hasSuffix("Application Support/aiui"), API.defaultDevice.path)
    }

    func testInitPicksTheFirstCLIAndBuildsEveryRole() {
        makeAPI()
        XCTAssertEqual(api.engineID, "claude")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "engine"), "claude")
        let all: [AIEngine?] = [api.claude, api.pager, api.suggester, api.scout, api.refiner, api.reviser, api.translator,
                                api.profiler, api.librarian, api.quick, api.tester, api.menus, api.retro, api.improver,
                                api.componentImprover, api.reviewer, api.console]
        XCTAssertEqual(all.compactMap { $0 as? FakeEngine }.count, 17)
        XCTAssertEqual(built.count, 17)
        XCTAssertTrue(built.allSatisfy { $0.id == "claude" })
        XCTAssertEqual(built.filter(\.persistent).map(\.schema), [Prompts.screenSchema, Prompts.consoleSchema])   // the screen AI and the console
        let main = fake(api.claude)
        XCTAssertTrue(main.systemPrompt.hasPrefix(Prompts.system))
        XCTAssertTrue(main.systemPrompt.contains(api.cache.indexText.path))
        XCTAssertTrue(fake(api.pager).systemPrompt.hasSuffix(Prompts.pager))
        XCTAssertEqual(fake(api.translator).systemPrompt, Prompts.translate)
        XCTAssertEqual(fake(api.reviewer).schema, Prompts.sharedReviewSchema)
        XCTAssertEqual(api.cache.generation, Prompts.generation)
        // The stores live under `support`, device-only data under `device`.
        XCTAssertEqual(api.cache.dir.deletingLastPathComponent().standardizedFileURL, support.standardizedFileURL)
        XCTAssertEqual(api.libraries.dir.deletingLastPathComponent().standardizedFileURL, device.standardizedFileURL)
    }

    func testInitPrefersTheSavedChoice() {
        TestEnv.fakeTool("codex", "exit 1")
        UserDefaults.standard.set("codex", forKey: "engine")
        makeAPI()
        XCTAssertEqual(api.engineID, "codex")
        XCTAssertEqual(built.first?.id, "codex")
    }

    func testInitFallsBackToTheKeyThenAICoin() {
        TestEnv.removeFake("claude")
        UserDefaults.standard.set("gone", forKey: "engine")       // a saved choice no longer available
        XCTAssertTrue(Provider.saveKey(Self.anthropicKey))
        makeAPI()
        XCTAssertEqual(api.engineID, "key")
        api.shutdown()

        Provider.deleteKey()
        UserDefaults.standard.removeObject(forKey: "engine")
        Self.putWallet()
        makeAPI()
        XCTAssertEqual(api.engineID, "aicoin")
    }

    func testInitWithoutAnyAI() {
        TestEnv.removeFake("claude")
        makeAPI()
        XCTAssertNil(api.engineID)
        XCTAssertNil(api.claude)
        XCTAssertNil(api.reviewer)
        XCTAssertTrue(built.isEmpty)
        XCTAssertEqual(call("info").json["ai"] as? String, "none")
        XCTAssertNil(api.engineStatus()["active"])
    }

    func testUseSwitchesAndCancelsTheOldEngines() {
        makeAPI()
        let old = built
        TestEnv.fakeTool("gemini", "exit 1")
        XCTAssertTrue(api.use("gemini"))
        XCTAssertEqual(api.engineID, "gemini")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "engine"), "gemini")
        // The interactive engines are cancelled.
        for e in [old[0], old[1], old[2], old[3], old[4], old[5]] { XCTAssertEqual(e.cancels, 1, e.schema) }
        XCTAssertTrue(built.suffix(17).allSatisfy { $0.id == "gemini" })
        XCTAssertFalse(api.use("unknown"))
        XCTAssertFalse(api.use("codex"))                 // not installed
        XCTAssertFalse(api.use("key"))                   // no key saved
        XCTAssertFalse(api.use("aicoin"))                // no wallet
        TestEnv.removeFake("claude")
        XCTAssertFalse(api.use("claude"))
        XCTAssertEqual(api.engineID, "gemini")
    }

    /// The real engines (no factory): objects only, nothing is run.
    func testUseBuildsTheRealEngines() {
        makeAPI()
        API.engineFactory = nil
        XCTAssertTrue(api.use("claude"))
        XCTAssertTrue(api.claude is Claude)
        XCTAssertEqual((api.quick as? Claude)?.model, "haiku")
        XCTAssertEqual((api.reviewer as? Claude)?.readOnly, true)
        XCTAssertEqual((api.pager as? Claude)?.readOnly, false)

        TestEnv.fakeTool("codex", "exit 1")
        XCTAssertTrue(api.use("codex"))
        XCTAssertEqual(api.claude?.label, "Codex CLI")
        XCTAssertEqual((api.reviewer as? AgentCLI)?.readOnly, true)
        TestEnv.fakeTool("gemini", "exit 1")
        XCTAssertTrue(api.use("gemini"))
        XCTAssertEqual(api.claude?.label, "Gemini CLI")

        XCTAssertTrue(Provider.saveKey(Self.anthropicKey))
        XCTAssertTrue(api.use("key"))
        XCTAssertEqual(api.claude?.label, "Anthropic · claude-test")
        XCTAssertEqual((api.quick as? APIEngine)?.effort, "low")
        XCTAssertEqual((api.reviewer as? APIEngine)?.noShell, true)
        XCTAssertEqual((api.pager as? APIEngine)?.noShell, false)

        Self.putWallet()
        XCTAssertTrue(api.use("aicoin"))
        XCTAssertEqual((api.claude as? APIEngine)?.key.name, "AICoin")
        XCTAssertEqual((api.claude as? APIEngine)?.key.base, "https://aicoin.test")
        api.shutdown()
    }

    func testEngineStatus() {
        TestEnv.fakeTool("codex", "exit 1")
        makeAPI()
        AICoin.shared.lastBalance = 12.5
        XCTAssertTrue(Provider.saveKey(Self.anthropicKey))
        let s = api.engineStatus()
        let options = s["options"] as? [[String: Any]] ?? []
        XCTAssertEqual(options.map { $0["id"] as? String }, ["claude", "codex", "aicoin", "key"])
        XCTAssertEqual(options.map { $0["label"] as? String }, ["Claude Code", "Codex CLI", "AICoin", "Anthropic · claude-test"])
        XCTAssertEqual(options[2]["balance"] as? Double, 12.5)
        XCTAssertEqual((s["active"] as? [String: Any])?["id"] as? String, "claude")
        XCTAssertEqual((s["active"] as? [String: Any])?["label"] as? String, "Fake claude")
        AICoin.shared.lastBalance = nil
        XCTAssertNil((api.engineStatus()["options"] as? [[String: Any]])?[2]["balance"])
    }

    // MARK: The `engine` endpoint

    func testEngineEndpointStatusAndUse() {
        makeAPI()
        XCTAssertEqual(((call("engine").json["active"]) as? [String: Any])?["id"] as? String, "claude")
        let bad = call("engine", ["op": "use", "id": "codex"])
        XCTAssertEqual(bad.status, 500)
        XCTAssertEqual(bad.error, "That AI is not available.")
        TestEnv.fakeTool("codex", "exit 1")
        let ok = call("engine", ["op": "use", "id": "codex"])
        XCTAssertEqual(ok.status, 200)
        XCTAssertEqual((ok.json["active"] as? [String: Any])?["id"] as? String, "codex")
        XCTAssertNotNil(call("engine", ["op": "other"]).json["options"])
    }

    func testEngineEndpointKeyAndForget() {
        makeAPI()
        let bad = call("engine", ["op": "key", "text": "nonsense"])
        XCTAssertEqual(bad.status, 500)
        XCTAssertTrue(bad.error?.hasPrefix("Unrecognised key") ?? false)
        let ok = call("engine", ["op": "key", "text": "sk-ant-abc123"])
        XCTAssertEqual(ok.status, 200)
        XCTAssertEqual(api.engineID, "key")
        XCTAssertEqual(Provider.loadKey()?.key, "sk-ant-abc123")

        let gone = call("engine", ["op": "forget"])
        XCTAssertEqual(gone.status, 200)
        XCTAssertNil(Provider.loadKey())
        XCTAssertNil(api.engineID)
        XCTAssertNil(api.claude)
        XCTAssertNil(api.pager)
        XCTAssertNil(UserDefaults.standard.string(forKey: "engine"))
        XCTAssertNil(gone.json["active"])

        // Forgetting the key while a CLI is in use keeps the CLI.
        api.use("claude")
        call("engine", ["op": "forget"])
        XCTAssertEqual(api.engineID, "claude")
    }

    func testEngineEndpointAICoin() {
        makeAPI()
        MockURL.on("/wallet/api/balance/", .json(["balance": 50.0]))
        let a = call("engine", ["op": "aicoin"])
        XCTAssertEqual(a.status, 200)
        XCTAssertEqual(api.engineID, "aicoin")
        XCTAssertEqual((a.json["active"] as? [String: Any])?["id"] as? String, "aicoin")
        XCTAssertEqual(AICoin.shared.lastBalance, 50)
    }

    func testEngineEndpointAICoinFailure() {
        makeAPI()
        Self.putWallet(Data("not a seed".utf8))       // unreadable wallet: it can't be created either
        let a = call("engine", ["op": "aicoin"])
        XCTAssertEqual(a.status, 500)
        XCTAssertTrue(a.error?.contains("Keychain") ?? false, a.error ?? "")
        XCTAssertEqual(api.engineID, "claude")
    }

    func testAICoinEndpointDispatches() {
        makeAPI()
        XCTAssertEqual(call("aicoin", ["op": "cancel"]).json["ok"] as? Bool, true)
    }
}
