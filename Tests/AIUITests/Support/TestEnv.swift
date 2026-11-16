import Foundation
import XCTest
@testable import AIUI

/// One sandbox for the whole test run, installed before any test touches the app's code:
/// - files: a temporary root instead of Application Support (NativeLibraries.root, API device dir);
/// - Keychain: test-only service names (AIUI_*_SERVICE / AIUI_AICOIN_WALLET), removed at the end;
/// - network: every URLSession request goes to MockURL (unhandled requests fail, nothing leaves);
/// - processes: Shell's PATH starts with a folder of fake tools (TestEnv.fakeBin), so `claude`,
///   `codex`, `gemini` are scripts the tests write; the real CLIs are never run;
/// - UserDefaults: the xctest tool's own domain, wiped per test by AIUITestCase.
enum TestEnv {
    static let root: URL = {
        let r = FileManager.default.temporaryDirectory.appendingPathComponent("aiui-tests-\(getpid())", isDirectory: true)
        try? FileManager.default.removeItem(at: r)
        try? FileManager.default.createDirectory(at: r, withIntermediateDirectories: true)
        return r
    }()
    static var fakeBin: URL { root.appendingPathComponent("fakebin", isDirectory: true) }
    static let keychainPrefix = "com.oeaio.aiui.tests.\(getpid())"

    private static var installed = false
    static func install() {
        guard !installed else { return }
        installed = true
        setenv("AIUI_PROVIDER_SERVICE", keychainPrefix + ".provider", 1)
        setenv("AIUI_IDENTITY_SERVICE", keychainPrefix + ".identity", 1)
        setenv("AIUI_AICOIN_WALLET", keychainPrefix + ".wallet", 1)
        setenv("AIUI_AICOIN_PROXY", "https://aicoin.test", 1)
        setenv("AIUI_SHARED_URL", "https://shared.test", 1)
        setenv("AIUI_USERS_URL", "https://users.test", 1)
        setenv("AIUI_NATIVE_CATALOG", "https://native.test/native.json", 1)
        unsetenv("AIUI_MODEL"); unsetenv("AIUI_ENGINE"); unsetenv("AIUI_CACHE_MB")
        NativeLibraries.root = root.appendingPathComponent("native", isDirectory: true)
        try? FileManager.default.createDirectory(at: fakeBin, withIntermediateDirectories: true)
        // Only the fake tools and the system folders: no user installs (a real `claude`) are found.
        Shell.loginEnvironment = [
            "PATH": [fakeBin.path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":"),
            "HOME": NSHomeDirectory(),
        ]
        URLProtocol.registerClass(MockURL.self)
        NetworkControl.shared.interface = { nil }
        // The shared native-tool store (started by every API) stays offline, so its background
        // maintenance never sends requests into later tests.
        NativeLibraries.shared.networkOverride = { NativeLibraries.NetState(satisfied: false, constrained: false, expensive: false) }
        atexit {
            TestEnv.removeKeychainItems()
            try? FileManager.default.removeItem(at: TestEnv.root)
        }
    }

    static func removeKeychainItems() {
        for svc in ["provider", "provider.legacy", "identity", "wallet"] {
            SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                           kSecAttrService as String: "\(keychainPrefix).\(svc)",
                           kSecAttrSynchronizable as String: kSecAttrSynchronizableAny] as CFDictionary)
        }
    }

    /// A fresh empty folder for one test.
    static func tempDir(_ name: String = UUID().uuidString) -> URL {
        let d = root.appendingPathComponent("t-\(name)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// Writes an executable script into the fake PATH folder (removed by `removeFake`).
    @discardableResult
    static func fakeTool(_ name: String, _ script: String) -> URL {
        let u = fakeBin.appendingPathComponent(name)
        try? ("#!/bin/sh\n" + script).write(to: u, atomically: true, encoding: .utf8)
        chmod(u.path, 0o755)
        return u
    }
    static func removeFake(_ name: String) { try? FileManager.default.removeItem(at: fakeBin.appendingPathComponent(name)) }
}

/// Base class of every test: installs the sandbox and starts each test with clean defaults and
/// no mocked routes.
class AIUITestCase: XCTestCase {
    override class func setUp() {
        super.setUp()
        TestEnv.install()
    }

    override func setUp() {
        super.setUp()
        TestEnv.install()
        MockURL.reset()
        if let d = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: d) }
        for k in UserDefaults.standard.dictionaryRepresentation().keys where !k.hasPrefix("NS") && !k.hasPrefix("Apple") && !k.hasPrefix("com.apple") {
            UserDefaults.standard.removeObject(forKey: k)
        }
    }

    /// Runs the main run loop until `cond` holds (or fails after `timeout`).
    func waitUntil(_ timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line, _ cond: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while !cond() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertTrue(cond(), "timed out", file: file, line: line)
    }

    /// Lets queued main-queue work run.
    func spin(_ seconds: TimeInterval = 0.05) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
}
