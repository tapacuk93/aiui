import XCTest
import Security
@testable import AIUI

final class EnginesTests: AIUITestCase {
    private let schema = "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"}}}"

    override func tearDown() {
        Provider.deleteKey()
        TestEnv.removeFake("claude"); TestEnv.removeFake("codex"); TestEnv.removeFake("gemini")
        super.tearDown()
    }

    // MARK: helpers

    private func anthropicKey(model: String = "claude-opus-5-5", headers: [String: String]? = nil) -> Provider.Key {
        Provider.Key(provider: "anthropic", name: "Anthropic", key: "sk-ant-test", base: "https://anthropic.test", model: model, headers: headers)
    }
    private func openAIKey(base: String = "https://openai.test/v1") -> Provider.Key {
        Provider.Key(provider: "openai-compatible", name: "OpenAI", key: "sk-test", base: base, model: "gpt-5", headers: ["X-AI": "openai"])
    }

    /// Answers successive requests to `fragment` with `responses` (the last one repeats).
    private func script(_ fragment: String, _ responses: [MockURL.Response]) {
        var i = 0
        let lock = NSLock()
        MockURL.on(fragment) { _ in
            lock.lock(); defer { lock.unlock() }
            let r = responses[min(i, responses.count - 1)]; i += 1
            return r
        }
    }

    private func run(_ e: APIEngine, _ prompt: String = "event") -> (result: Swift.Result<[String: Any], Error>, progress: [String]) {
        var progress: [String] = []
        var result: Swift.Result<[String: Any], Error>?
        e.next(prompt: prompt, progress: { progress.append($0) }, done: { result = $0 })
        waitUntil(10) { result != nil }
        spin()
        return (result ?? .failure(aiError("no result")), progress)
    }

    private func message(_ r: Swift.Result<[String: Any], Error>) -> String? {
        if case .failure(let e) = r { return e.localizedDescription }
        return nil
    }

    private func bodies(_ fragment: String) -> [[String: Any]] {
        MockURL.seen.filter { $0.url.absoluteString.contains(fragment) }
            .map { (try? JSONSerialization.jsonObject(with: $0.body)) as? [String: Any] ?? [:] }
    }

    private func toolNames(_ body: [String: Any]) -> [String] {
        (body["tools"] as? [[String: Any]] ?? []).map { ($0["name"] as? String) ?? (($0["function"] as? [String: Any])?["name"] as? String ?? "") }
    }

    // MARK: free functions and Provider

    func testAIErrorAndExtractJSON() {
        XCTAssertEqual(aiError("x").localizedDescription, "x")
        XCTAssertEqual(aiError("x").domain, "aiui")
        XCTAssertEqual(extractJSON("a {\"b\": {\"c\": 2}} z")?["b"] as? [String: Int], ["c": 2])
        XCTAssertNil(extractJSON("no braces"))
        XCTAssertNil(extractJSON("} backwards {"))
        XCTAssertNil(extractJSON("{not json}"))
    }

    func testParseRecognisesProviders() {
        XCTAssertNil(Provider.parse(""))
        XCTAssertNil(Provider.parse("   \n"))
        XCTAssertNil(Provider.parse("unknown-key"))
        let ant = Provider.parse("sk-ant-abc")!
        XCTAssertEqual(ant.provider, "anthropic"); XCTAssertEqual(ant.model, "claude-opus-5-5"); XCTAssertEqual(ant.base, "https://api.anthropic.com")
        XCTAssertEqual(Provider.parse("sk-ant-abc claude-x")?.model, "claude-x")
        let cases: [(String, String, String, String)] = [
            ("sk-or-1", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter/auto"),
            ("AIza1", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-pro"),
            ("gsk_1", "Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
            ("xai-1", "xAI", "https://api.x.ai/v1", "grok-4"),
            ("sk-1", "OpenAI", "https://api.openai.com/v1", "gpt-5"),
        ]
        for (k, name, base, model) in cases {
            let p = Provider.parse(k)!
            XCTAssertEqual(p.provider, "openai-compatible"); XCTAssertEqual(p.name, name)
            XCTAssertEqual(p.base, base); XCTAssertEqual(p.model, model); XCTAssertEqual(p.key, k)
        }
        XCTAssertEqual(Provider.parse("sk-1\tgpt-4o")?.model, "gpt-4o")
        let custom = Provider.parse("https://llm.example.test/v1/ KEY model-1")!
        XCTAssertEqual(custom.name, "llm.example.test"); XCTAssertEqual(custom.base, "https://llm.example.test/v1")
        XCTAssertEqual(custom.key, "KEY"); XCTAssertEqual(custom.model, "model-1")
        let bare = Provider.parse("http://x KEY")!
        XCTAssertEqual(bare.base, "http://x"); XCTAssertEqual(bare.model, "")
        XCTAssertEqual(Provider.parse("http:// KEY")?.name, "Custom")
        // A URL alone is not a key.
        XCTAssertNil(Provider.parse("https://only.test"))
    }

    func testKeychainServiceNames() {
        XCTAssertTrue(Provider.serviceNames([:]) == ("com.oeaio.aiui.provider", "dev.aiui.app.provider"))
        XCTAssertTrue(Provider.serviceNames(["AIUI_PROVIDER_SERVICE": "x.test"]) == ("x.test", "x.test.legacy"))
    }

    func testDetectedCLIs() {
        XCTAssertEqual(Provider.clis.map(\.id), ["claude", "codex", "gemini"])
        XCTAssertEqual(Provider.detectedCLIs(), [])
        TestEnv.fakeTool("codex", "exit 0")
        TestEnv.fakeTool("gemini", "exit 0")
        XCTAssertEqual(Provider.detectedCLIs(), ["codex", "gemini"])
    }

    func testKeychainSaveLoadDelete() {
        Provider.deleteKey()
        XCTAssertNil(Provider.loadKey())
        let k = Provider.Key(provider: "anthropic", name: "Anthropic", key: "sk-ant-1", base: "https://a.test", model: "m", headers: ["X-AI": "a"])
        XCTAssertTrue(Provider.saveKey(k))
        let loaded = Provider.loadKey()
        XCTAssertEqual(loaded?.key, "sk-ant-1"); XCTAssertEqual(loaded?.headers?["X-AI"], "a")
        // Saving again replaces it.
        var k2 = k; k2.key = "sk-ant-2"
        XCTAssertTrue(Provider.saveKey(k2))
        XCTAssertEqual(Provider.loadKey()?.key, "sk-ant-2")
        Provider.deleteKey()
        XCTAssertNil(Provider.loadKey())
    }

    func testLegacyKeyIsMigrated() throws {
        let legacy = TestEnv.keychainPrefix + ".provider.legacy"
        let old = Provider.Key(provider: "openai-compatible", name: "OpenAI", key: "sk-old", base: "https://o.test", model: "gpt")
        let data = try JSONEncoder().encode(old)
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: legacy] as CFDictionary)
        XCTAssertEqual(SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: legacy,
                                   kSecAttrAccount as String: "OpenAI", kSecValueData as String: data] as CFDictionary, nil), errSecSuccess)
        Provider.deleteKey()
        XCTAssertEqual(Provider.loadKey()?.key, "sk-old")
        // Moved: now under the current service, gone from the legacy one.
        var out: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: legacy,
                                            kSecReturnData as String: true] as CFDictionary, &out), errSecItemNotFound)
        XCTAssertEqual(Provider.loadKey()?.key, "sk-old")
    }

    // MARK: Anthropic loop

    func testAnthropicLoopRunsShellToolsThenShowsTheScreen() throws {
        script("anthropic.test/v1/messages", [
            .json(["stop_reason": "tool_use", "content": [
                ["type": "thinking", "thinking": "plan"],
                ["type": "tool_use", "id": "t1", "name": "shell", "input": ["command": "echo hi"]],
                ["type": "tool_use", "id": "t2", "name": "shell", "input": ["command": "echo bad >&2; exit 2"]],
            ]]),
            .json(["stop_reason": "end_turn", "content": [["type": "text", "text": "Done thinking."]]]),
            .json(["stop_reason": "tool_use", "content": [
                ["type": "tool_use", "id": "s1", "name": "screen", "input": ["title": "Hello"]],
            ]]),
        ])
        let e = APIEngine(key: anthropicKey(headers: ["X-AI": "anthropic"]), persistent: true, systemPrompt: "SYS", schema: schema)
        XCTAssertEqual(e.label, "Anthropic · claude-opus-5-5")
        let r = run(e, "first")
        XCTAssertEqual(try r.result.get()["title"] as? String, "Hello")
        XCTAssertEqual(r.progress, ["thinking", "shell · echo hi", "shell · echo bad >&2; exit 2"])

        let seen = MockURL.seen
        XCTAssertEqual(seen.count, 3)
        XCTAssertEqual(seen[0].headers["x-api-key"], "sk-ant-test")
        XCTAssertEqual(seen[0].headers["anthropic-version"], "2026-10-21")
        XCTAssertEqual(seen[0].headers["anthropic-beta"], "server-side-fallback-2026-07-01")
        XCTAssertEqual(seen[0].headers["X-AI"], "anthropic")
        XCTAssertEqual(seen[0].headers["content-type"] ?? seen[0].headers["Content-Type"], "application/json")
        let b = bodies("anthropic.test")
        XCTAssertEqual(b[0]["fallbacks"] as? String, "default")
        XCTAssertEqual((b[0]["output_config"] as? [String: String])?["effort"], "medium")
        XCTAssertEqual(toolNames(b[0]), ["shell", "screen"])
        XCTAssertTrue((b[0]["system"] as? String ?? "").hasPrefix("SYS"))
        XCTAssertTrue((b[0]["system"] as? String ?? "").contains("## Tools in this app"))
        let screenTool = (b[0]["tools"] as? [[String: Any]])?[1]
        XCTAssertNotNil((screenTool?["input_schema"] as? [String: Any])?["properties"])
        // Tool results go back together in one user message.
        let msgs1 = b[1]["messages"] as? [[String: Any]] ?? []
        let results = msgs1.last?["content"] as? [[String: Any]] ?? []
        XCTAssertEqual(results.map { $0["tool_use_id"] as? String }, ["t1", "t2"])
        XCTAssertEqual(results[0]["content"] as? String, "exit 0\nhi\n")
        XCTAssertEqual(results[1]["content"] as? String, "exit 2\n\nstderr:\nbad\n")
        // A turn without tools gets a nudge.
        let msgs2 = b[2]["messages"] as? [[String: Any]] ?? []
        let nudge = (msgs2.last?["content"] as? [[String: Any]])?.first?["text"] as? String
        XCTAssertEqual(nudge, "Call the screen tool now with the next screen.")

        // Persistent: the next call continues the conversation, answers the open screen call and
        // carries an attached image.
        MockURL.reset()
        script("anthropic.test/v1/messages", [.json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "s2", "name": "screen", "input": ["title": "Second"]]]])])
        e.attachImage(Data([1, 2, 3]))
        XCTAssertEqual(try run(e, "second").result.get()["title"] as? String, "Second")
        let next = bodies("anthropic.test")[0]["messages"] as? [[String: Any]] ?? []
        XCTAssertEqual(next.count, 7)
        let first = next.last?["content"] as? [[String: Any]] ?? []
        XCTAssertEqual(first[0]["tool_use_id"] as? String, "s1")
        XCTAssertEqual(first[1]["type"] as? String, "image")
        XCTAssertEqual((first[1]["source"] as? [String: String])?["data"], Data([1, 2, 3]).base64EncodedString())
        XCTAssertEqual(first[2]["text"] as? String, "second")

        // reset forgets the conversation.
        e.reset()
        MockURL.reset()
        script("anthropic.test/v1/messages", [.json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "s3", "name": "screen", "input": ["title": "Third"]]]])])
        _ = run(e, "third")
        let fresh = bodies("anthropic.test")[0]["messages"] as? [[String: Any]] ?? []
        XCTAssertEqual(fresh.count, 1)
        XCTAssertEqual((fresh[0]["content"] as? [[String: Any]])?.count, 1)
    }

    func testAnthropicScreenWithOtherCallsAndNoShell() throws {
        script("anthropic.test/v1/messages", [.json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "x1", "name": "shell", "input": ["command": "echo never"]],
            ["type": "tool_use", "id": "s1", "name": "screen"],
        ]])])
        let e = APIEngine(key: anthropicKey(model: "claude-other"), persistent: true, systemPrompt: "S", schema: schema)
        e.noShell = true
        e.effort = "low"
        let r = run(e)
        XCTAssertEqual(try r.result.get().count, 0)
        XCTAssertEqual(r.progress, ["thinking"])
        let b = bodies("anthropic.test")[0]
        XCTAssertEqual(toolNames(b), ["screen"])
        XCTAssertNil(b["fallbacks"])
        XCTAssertNil(MockURL.seen[0].headers["anthropic-beta"])
        XCTAssertEqual((b["output_config"] as? [String: String])?["effort"], "low")

        // The skipped calls were answered, so no screen call is open: the next turn starts plainly.
        MockURL.reset()
        script("anthropic.test/v1/messages", [.json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "s9", "name": "screen", "input": ["title": "n"]]]])])
        _ = run(e)
        let msgs = bodies("anthropic.test")[0]["messages"] as? [[String: Any]] ?? []
        let skipped = msgs[2]["content"] as? [[String: Any]] ?? []
        XCTAssertEqual(skipped.map { $0["content"] as? String }, ["skipped", "Screen shown.", nil])
        XCTAssertEqual(skipped.last?["text"] as? String, "(continuing)")
        XCTAssertEqual((msgs.last?["content"] as? [[String: Any]])?.count, 1)
    }

    func testAnthropicStopReasonsAndGivingUp() {
        let e = APIEngine(key: anthropicKey(), persistent: false, systemPrompt: "S", schema: schema)
        script("anthropic.test", [.json(["stop_reason": "refusal", "content": []])])
        XCTAssertEqual(message(run(e).result), "The model declined this request.")
        MockURL.reset()
        script("anthropic.test", [.json(["stop_reason": "max_tokens"])])
        XCTAssertEqual(message(run(e).result), "The model ran out of output tokens.")
        MockURL.reset()
        script("anthropic.test", [.json(["stop_reason": "end_turn", "content": [["type": "text", "text": "no"]]])])
        XCTAssertEqual(message(run(e).result), "The model did not produce a screen.")
        XCTAssertEqual(MockURL.seen.count, 30)
    }

    func testNonPersistentEngineStartsFreshEachTime() {
        script("anthropic.test", [.json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "s1", "name": "screen", "input": ["title": "a"]]]])])
        let e = APIEngine(key: anthropicKey(), persistent: false, systemPrompt: "S", schema: "not json")
        _ = run(e); _ = run(e)
        let b = bodies("anthropic.test")
        XCTAssertEqual((b[1]["messages"] as? [Any])?.count, 1)
        XCTAssertEqual(((b[1]["tools"] as? [[String: Any]])?[1]["input_schema"] as? [String: Any])?.count, 0)
    }

    // MARK: HTTP errors

    func testHTTPErrors() {
        let e = APIEngine(key: openAIKey(), persistent: false, systemPrompt: "S", schema: schema)
        MockURL.on("openai.test", .json(["error": ["message": "Invalid API key"]], status: 401))
        XCTAssertEqual(message(run(e).result), "OpenAI error 401: Invalid API key")
        MockURL.on("openai.test", .text("Bad gateway", status: 502))
        XCTAssertEqual(message(run(e).result), "OpenAI error 502: Bad gateway")
        // 402 from another base is an ordinary error.
        MockURL.on("openai.test", .json(["reason": "link_limit"], status: 402))
        XCTAssertTrue(message(run(e).result)?.hasPrefix("OpenAI error 402") ?? false)
        MockURL.on("openai.test", .fail())
        XCTAssertNotNil(message(run(e).result))
    }

    func testPaymentErrorFromTheAICoinProxy() {
        let k = Provider.Key(provider: "openai-compatible", name: "AICoin", key: "w", base: AICoin.proxy, model: "m")
        let e = APIEngine(key: k, persistent: true, systemPrompt: "S", schema: schema)
        MockURL.on("aicoin.test", .json(["reason": "link_limit", "spendable": 3.0], status: 402))
        XCTAssertEqual(message(run(e).result), AICoin.paymentError(["reason": "link_limit", "spendable": 3.0]).localizedDescription)
    }

    // MARK: OpenAI-compatible loop

    func testOpenAILoopRunsShellToolsThenShowsTheScreen() throws {
        script("openai.test/v1/chat/completions", [
            .json(["choices": [["message": ["content": NSNull(), "tool_calls": [
                ["id": "c1", "type": "function", "function": ["name": "shell", "arguments": "{\"command\":\"echo one\"}"]],
                ["id": "c2", "type": "function", "function": ["name": "shell", "arguments": "not json"]],
            ]]]]]),
            .json(["choices": [["message": ["content": "Just text."]]]]),
            .json(["choices": [["message": ["tool_calls": [
                ["id": "c3", "type": "function", "function": ["name": "shell", "arguments": "{}"]],
                ["id": "s1", "type": "function", "function": ["name": "screen", "arguments": "{\"title\":\"OA\"}"]],
                ["id": "c4"],
            ]]]]]),
        ])
        let e = APIEngine(key: openAIKey(), persistent: true, systemPrompt: "SYS", schema: schema)
        let r = run(e, "go")
        XCTAssertEqual(try r.result.get()["title"] as? String, "OA")
        XCTAssertEqual(r.progress, ["thinking", "shell · echo one", "shell · "])
        let seen = MockURL.seen
        XCTAssertEqual(seen[0].headers["Authorization"], "Bearer sk-test")
        XCTAssertEqual(seen[0].headers["X-AI"], "openai")
        let b = bodies("openai.test")
        XCTAssertEqual(b[0]["tool_choice"] as? String, "auto")
        XCTAssertEqual(toolNames(b[0]), ["shell", "screen"])
        let m0 = b[0]["messages"] as? [[String: Any]] ?? []
        XCTAssertEqual(m0[0]["role"] as? String, "system")
        XCTAssertEqual(m0[1]["content"] as? String, "go")
        let m1 = b[1]["messages"] as? [[String: Any]] ?? []
        XCTAssertEqual(m1[2]["tool_calls"] as? [[String: Any]] == nil, false)
        XCTAssertEqual(m1[3]["tool_call_id"] as? String, "c1")
        XCTAssertEqual(m1[3]["content"] as? String, "exit 0\none\n")
        XCTAssertEqual(m1[4]["tool_call_id"] as? String, "c2")
        let m2 = b[2]["messages"] as? [[String: Any]] ?? []
        XCTAssertEqual(m2[5]["content"] as? String, "Just text.")
        XCTAssertNil(m2[5]["tool_calls"])
        XCTAssertEqual(m2[6]["content"] as? String, "Call the screen tool now with the next screen.")

        // Persistent: the skipped calls and the open screen call are answered on the next turn.
        MockURL.reset()
        script("openai.test/v1/chat/completions", [.json(["choices": [["message": ["content": "{\"title\":\"Inline\"}"]]]])])
        e.attachImage(Data([9]))
        XCTAssertEqual(try run(e, "again").result.get()["title"] as? String, "Inline")
        let m = bodies("openai.test")[0]["messages"] as? [[String: Any]] ?? []
        let tail = Array(m.suffix(4))
        XCTAssertEqual(tail[0]["content"] as? String, "skipped"); XCTAssertEqual(tail[0]["tool_call_id"] as? String, "c3")
        XCTAssertEqual(tail[1]["content"] as? String, "skipped"); XCTAssertEqual(tail[1]["tool_call_id"] as? String, "c4")
        XCTAssertEqual(tail[2]["tool_call_id"] as? String, "s1"); XCTAssertEqual(tail[2]["content"] as? String, "Screen shown.")
        let user = tail[3]["content"] as? [[String: Any]] ?? []
        XCTAssertEqual((user[0]["image_url"] as? [String: String])?["url"], "data:image/jpeg;base64," + Data([9]).base64EncodedString())
        XCTAssertEqual(user[1]["text"] as? String, "again")
    }

    func testOpenAIUnexpectedResponseAndGivingUp() {
        let e = APIEngine(key: openAIKey(), persistent: false, systemPrompt: "S", schema: schema)
        e.noShell = true
        MockURL.on("openai.test", .json(["choices": []]))
        XCTAssertEqual(message(run(e).result), "Unexpected response from OpenAI.")
        XCTAssertEqual(toolNames(bodies("openai.test")[0]), ["screen"])
        MockURL.reset()
        MockURL.on("openai.test", .json(["choices": [["message": ["content": "nothing"]]]]))
        XCTAssertEqual(message(run(e).result), "The model did not produce a screen.")
        XCTAssertEqual(MockURL.seen.count, 30)
    }

    // MARK: cancellation

    func testCancelReportsOnceAndDropsTheLateAnswer() {
        var d = MockURL.Response.json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "s1", "name": "screen", "input": ["title": "late"]]]])
        d.delay = 0.3
        MockURL.on("anthropic.test", d)
        let e = APIEngine(key: anthropicKey(), persistent: true, systemPrompt: "S", schema: schema)
        var results: [Swift.Result<[String: Any], Error>] = []
        var progress: [String] = []
        e.next(prompt: "p", progress: { progress.append($0) }, done: { results.append($0) })
        spin(0.05)
        e.cancel()
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(message(results[0]), "cancelled")
        spin(0.6)
        XCTAssertEqual(results.count, 1)
        e.cancel()
        XCTAssertEqual(results.count, 1)
    }

    func testSupersededRequestKeepsNoState() throws {
        // The first request's answer arrives after a newer request started: it is neither
        // delivered nor stored.
        var slow = MockURL.Response.json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "old", "name": "screen", "input": ["title": "old"]]]])
        slow.delay = 0.4
        var n = 0
        MockURL.on("anthropic.test") { _ in
            n += 1
            if n == 1 { return slow }
            return .json(["stop_reason": "tool_use", "content": [
                ["type": "tool_use", "id": "new", "name": "shell", "input": ["command": "sleep 0.6; echo slow"]]]])
        }
        let e = APIEngine(key: anthropicKey(), persistent: true, systemPrompt: "S", schema: schema)
        var first: [Swift.Result<[String: Any], Error>] = []
        e.next(prompt: "a", progress: { _ in }, done: { first.append($0) })
        spin(0.05)
        var second: [Swift.Result<[String: Any], Error>] = []
        var progress2: [String] = []
        e.next(prompt: "b", progress: { progress2.append($0) }, done: { second.append($0) })
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(message(first[0]), "cancelled")
        spin(0.2)
        // A third request supersedes the second while its shell tool is still running; the
        // second's progress line from before arrives, later ones are dropped.
        MockURL.on("anthropic.test", .json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "s3", "name": "screen", "input": ["title": "third"]]]]))
        let r = run(e, "c")
        XCTAssertEqual(try r.result.get()["title"] as? String, "third")
        spin(1.0)
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(second.count, 1)
        XCTAssertEqual(message(second[0]), "cancelled")
        // Only the third call's state was kept: the next call answers s3.
        MockURL.on("anthropic.test", .json(["stop_reason": "tool_use", "content": [
            ["type": "tool_use", "id": "s4", "name": "screen", "input": ["title": "4"]]]]))
        _ = run(e, "d")
        let msgs = bodies("anthropic.test").last?["messages"] as? [[String: Any]] ?? []
        let firstBlock = (msgs[msgs.count - 1]["content"] as? [[String: Any]])?.first
        XCTAssertEqual(firstBlock?["tool_use_id"] as? String, "s3")
        XCTAssertFalse(msgs.contains { ($0["content"] as? [[String: Any]])?.contains { $0["id"] as? String == "old" } ?? false })
    }
}
