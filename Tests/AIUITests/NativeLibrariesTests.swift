import XCTest
@testable import AIUI

/// Catalogs, artifacts (small tar/zip/file payloads with their real SHA-256) and packs for the
/// NativeLibraries tests, all under one temporary folder. The "tools" are sh scripts that echo.
final class NativeFixture {
    let base = TestEnv.tempDir("native")
    var dir: URL { base.appendingPathComponent("store", isDirectory: true) }
    var src: URL { base.appendingPathComponent("src", isDirectory: true) }
    var pack: URL { base.appendingPathComponent("pack", isDirectory: true) }
    init() {
        try? FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: pack, withIntermediateDirectories: true)
    }

    static let ok = NativeLibraries.NetState(satisfied: true, constrained: false, expensive: false)

    static func script(_ exe: String, _ version: String, body: String = "") -> String {
        "#!/bin/sh\n\(body)echo \"\(exe) \(version) $*\"\n"
    }

    /// Packs `files` (relative path → text, executable) as tar, zip or a plain file.
    func artifact(_ name: String, format: String = "tar", files: [String: String], bin: [String: String]) -> [String: Any] {
        let fm = FileManager.default
        let out = src.appendingPathComponent(name)
        try? fm.removeItem(at: out)
        if format == "file" {
            try! files.values.first!.write(to: out, atomically: true, encoding: .utf8)
        } else {
            let folder = src.appendingPathComponent("tree-\(UUID().uuidString)")
            for (rel, text) in files {
                let f = folder.appendingPathComponent(rel)
                try! fm.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
                try! text.write(to: f, atomically: true, encoding: .utf8)
                chmod(f.path, 0o755)
            }
            let r = format == "zip"
                ? NativeLibraries.run("/usr/bin/ditto", ["-c", "-k", folder.path, out.path], timeout: 30)
                : NativeLibraries.run("/usr/bin/tar", ["-cf", out.path, "-C", folder.path, "."], timeout: 30)
            precondition(r.code == 0, r.out)
        }
        let size = (try? Data(contentsOf: out))?.count ?? 0
        return ["url": "https://dl.test/\(UUID().uuidString)/\(name)", "name": name, "format": format,
                "sha256": NativeLibraries.sha256(of: out)!, "bytes": size, "bin": bin]
    }

    func tool(_ id: String, _ version: String = "1.0", isDefault: Bool = false, exe: String? = nil, body: String = "",
              format: String = "tar", extra: [String: Any] = [:]) -> [String: Any] {
        let exe = exe ?? id
        let name = "\(id)-\(version)-\(UUID().uuidString.prefix(6)).\(format == "file" ? "bin" : format)"
        let a = artifact(name, format: format, files: ["bin/\(exe)": Self.script(exe, version, body: body)],
                         bin: [exe: format == "file" ? exe : "bin/\(exe)"])
        var t: [String: Any] = ["id": id, "version": version, "default": isDefault, "description": "\(id) tool",
                                "purpose": "testing", "executables": [exe], "check": [exe, "--version"],
                                "artifacts": [a], "bytes": a["bytes"]!]
        t.merge(extra) { $1 }
        return t
    }

    func catalogData(_ tools: [[String: Any]], version: Int = 1) -> Data {
        try! JSONSerialization.data(withJSONObject: ["version": version, "platform": "macos-arm64", "tools": tools] as [String: Any])
    }

    func catalog(_ tools: [[String: Any]], version: Int = 1) -> URL {
        let u = src.appendingPathComponent("native-\(version)-\(UUID().uuidString).json")
        try! catalogData(tools, version: version).write(to: u)
        return u
    }

    func file(_ a: [String: Any]) -> URL { src.appendingPathComponent(a["name"] as! String) }
    func arts(_ t: [String: Any]) -> [[String: Any]] { t["artifacts"] as! [[String: Any]] }

    func serve(_ t: [String: Any], delay: TimeInterval = 0) {
        for a in arts(t) { MockURL.on(a["url"] as! String, MockURL.Response(body: try! Data(contentsOf: file(a)), delay: delay)) }
    }

    func addToPack(_ t: [String: Any]) {
        for a in arts(t) {
            try? FileManager.default.copyItem(at: file(a), to: pack.appendingPathComponent("\(a["sha256"]!)-\(a["name"]!)"))
        }
    }

    func store(_ catalogURL: URL?, pack usePack: Bool = false) -> NativeLibraries {
        let n = NativeLibraries(dir: dir)
        n.bundledCatalog = catalogURL
        n.packDir = usePack ? pack : nil
        n.networkOverride = { Self.ok }
        n.loadCatalog()
        return n
    }

    /// Writes installed tools straight into the store (folders, links and installed.json).
    func fakeInstalled(_ list: [NativeLibraries.Installed]) {
        let fm = FileManager.default
        for i in list {
            let v = dir.appendingPathComponent("\(i.id)/\(i.version)")
            try! fm.createDirectory(at: v.appendingPathComponent("payload/bin"), withIntermediateDirectories: true)
            try! fm.createDirectory(at: v.appendingPathComponent("bin"), withIntermediateDirectories: true)
            for exe in i.executables {
                let f = v.appendingPathComponent("payload/bin/\(exe)")
                try! Self.script(exe, i.version).write(to: f, atomically: true, encoding: .utf8)
                chmod(f.path, 0o755)
                try? fm.createSymbolicLink(atPath: v.appendingPathComponent("bin/\(exe)").path, withDestinationPath: "../payload/bin/\(exe)")
            }
            try? fm.createSymbolicLink(atPath: dir.appendingPathComponent("\(i.id)/current").path, withDestinationPath: i.version)
        }
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        try! enc.encode(list).write(to: dir.appendingPathComponent("installed.json"))
    }

    static func installed(_ id: String, version: String = "1.0", exes: [String]? = nil, bytes: Int = 1000, isDefault: Bool = false,
                          installed: Date = Date(), lastUsed: Date = Date()) -> NativeLibraries.Installed {
        .init(id: id, version: version, previous: nil, executables: exes ?? [id], bytes: bytes, isDefault: isDefault,
              installed: installed, lastUsed: lastUsed, uses: 0, fromPack: nil)
    }
}

final class NativeLibrariesTests: AIUITestCase {
    var fx: NativeFixture!
    private var savedForced = NativeLibraries.adminForced
    private var savedCapacity = Libraries.availableCapacity
    private var savedEval = API.evalJS
    private var events: [String] = []
    private let lock = NSLock()

    override func setUp() {
        super.setUp()
        fx = NativeFixture()
        savedForced = NativeLibraries.adminForced
        savedCapacity = Libraries.availableCapacity
        savedEval = API.evalJS
        Libraries.availableCapacity = { 105_000_000_000 }   // a 10 GB shared budget
        API.paused = false
        events = []
        API.evalJS = { [weak self] js in self?.lock.lock(); self?.events.append(js.replacingOccurrences(of: "\\/", with: "/")); self?.lock.unlock() }
    }

    override func tearDown() {
        NativeLibraries.adminForced = savedForced
        Libraries.availableCapacity = savedCapacity
        API.evalJS = savedEval
        API.paused = false
        super.tearDown()
    }

    // MARK: helpers

    func install(_ n: NativeLibraries, _ id: String, background: Bool = false, packOnly: Bool = false,
                 file: StaticString = #filePath, line: UInt = #line) -> String? {
        var result: String?? = .none
        n.install(id, background: background, packOnly: packOnly) { result = .some($0) }
        waitUntil(15, file: file, line: line) { result != nil }
        return result ?? "no answer"
    }

    func row(_ n: NativeLibraries, _ id: String) -> [String: Any] {
        (n.status()["tools"] as! [[String: Any]]).first { $0["id"] as? String == id } ?? [:]
    }

    func runBin(_ n: NativeLibraries, _ exe: String, _ args: [String] = []) -> String {
        NativeLibraries.run(n.dir.appendingPathComponent("bin/\(exe)").path, args, timeout: 10).out
    }

    func link(_ n: NativeLibraries, _ exe: String) -> String? {
        try? FileManager.default.destinationOfSymbolicLink(atPath: n.dir.appendingPathComponent("bin/\(exe)").path)
    }

    func maintain(_ n: NativeLibraries, force: Bool = false) {
        var done = false
        n.maintain(force: force) { done = true }
        waitUntil(15) { done }
    }

    func handle(_ n: NativeLibraries, _ input: [String: Any]) -> [String: Any] {
        var out: [String: Any]?
        n.handle(input, send: { out = $0 }, fail: { out = ["error": $0] })
        waitUntil(15) { out != nil }
        return out ?? [:]
    }

    var sharedEvents: [String] { lock.lock(); defer { lock.unlock() }; return events }

    // MARK: catalog

    func testCatalogValidation() {
        let art: [String: Any] = ["sha256": String(repeating: "a", count: 64), "url": "https://x.test/y", "bin": ["jq": "bin/jq"]]
        func cat(_ tool: [String: Any] = [:], _ a: [String: Any] = [:], top: [String: Any] = [:]) -> [String: Any] {
            var arts = art; arts.merge(a) { $1 }
            var t: [String: Any] = ["id": "jq", "version": "1", "artifacts": [arts]]; t.merge(tool) { $1 }
            var c: [String: Any] = ["version": 1, "platform": "macos-arm64", "tools": [t]]; c.merge(top) { $1 }
            return c
        }
        XCTAssertTrue(NativeLibraries.valid(cat()))
        XCTAssertTrue(NativeLibraries.valid(["version": 1, "platform": "macos-arm64", "tools": [[String: Any]]()]))
        XCTAssertFalse(NativeLibraries.valid(cat(top: ["version": "1"])))
        XCTAssertFalse(NativeLibraries.valid(cat(top: ["platform": "linux-x64"])))
        XCTAssertFalse(NativeLibraries.valid(cat(top: ["tools": "none"])))
        XCTAssertFalse(NativeLibraries.valid(cat(["id": "../jq"])))
        XCTAssertFalse(NativeLibraries.valid(cat(["version": 1])))
        XCTAssertFalse(NativeLibraries.valid(cat(["artifacts": [[String: Any]]()])))
        XCTAssertFalse(NativeLibraries.valid(cat([:], ["sha256": "abc"])))
        XCTAssertFalse(NativeLibraries.valid(cat([:], ["url": "http://x.test/y"])))
        XCTAssertFalse(NativeLibraries.valid(cat([:], ["bin": "jq"])))
        XCTAssertFalse(NativeLibraries.valid(cat([:], ["bin": ["j q": "bin/jq"]])))
        XCTAssertFalse(NativeLibraries.valid(cat([:], ["bin": ["jq": "../jq"]])))
        XCTAssertFalse(NativeLibraries.valid(cat([:], ["bin": ["jq": "/bin/jq"]])))
        XCTAssertFalse(NativeLibraries.valid(cat([:], ["bin": ["jq": ""]])))
        XCTAssertTrue(NativeLibraries.safeID("yt-dlp_2.0+x"))
        XCTAssertFalse(NativeLibraries.safeID(".hidden"))
        XCTAssertFalse(NativeLibraries.safeID(String(repeating: "a", count: 65)))

        let f = fx.src.appendingPathComponent("c.json")
        XCTAssertNil(NativeLibraries.readCatalog(f))
        try! "not json".write(to: f, atomically: true, encoding: .utf8)
        XCTAssertNil(NativeLibraries.readCatalog(f))
        try! JSONSerialization.data(withJSONObject: cat(top: ["platform": "x"])).write(to: f)
        XCTAssertNil(NativeLibraries.readCatalog(f))
        try! JSONSerialization.data(withJSONObject: cat()).write(to: f)
        XCTAssertEqual(NativeLibraries.readCatalog(f)?["version"] as? Int, 1)
    }

    func testLoadCatalogTakesTheNewerOfBundledAndLive() {
        let a = fx.tool("aa"), b = fx.tool("bb")
        let n = fx.store(fx.catalog([a], version: 3))
        XCTAssertEqual(n.tools.map { $0["id"] as! String }, ["aa"])
        XCTAssertNotNil(n.entry("aa")); XCTAssertNil(n.entry("bb"))
        try! fx.catalogData([b], version: 5).write(to: fx.dir.appendingPathComponent("catalog.json"))
        n.loadCatalog()
        XCTAssertEqual(n.catalog["version"] as? Int, 5)
        XCTAssertEqual(n.tools.map { $0["id"] as! String }, ["bb"])
        try! fx.catalogData([b], version: 2).write(to: fx.dir.appendingPathComponent("catalog.json"))
        n.loadCatalog()
        XCTAssertEqual(n.catalog["version"] as? Int, 3)
        n.bundledCatalog = nil
        try? FileManager.default.removeItem(at: fx.dir.appendingPathComponent("catalog.json"))
        n.loadCatalog()
        XCTAssertTrue(n.tools.isEmpty)
    }

    func testSharedInstanceAndStatics() {
        XCTAssertEqual(NativeLibraries.shared.dir, NativeLibraries.root)
        XCTAssertEqual(NativeLibraries.binDir, NativeLibraries.root.appendingPathComponent("bin", isDirectory: true))
        XCTAssertEqual(NativeLibraries.liveCatalogURL.absoluteString, "https://native.test/native.json")
        XCTAssertEqual(NativeLibraries.catalogURL(env: [:]).absoluteString, "https://aiui.oeaio.com/native.json")
        XCTAssertEqual(NativeLibraries.catalogURL(env: ["AIUI_NATIVE_CATALOG": "https://x.test/n.json"]).absoluteString, "https://x.test/n.json")
        XCTAssertTrue(NativeLibraries.adminForced("AllowNativeDownloadsTestKey") == false)
    }

    // MARK: helpers (static)

    func testHelpers() {
        XCTAssertEqual(NativeLibraries.mb(10), "1 KB")
        XCTAssertEqual(NativeLibraries.mb(5_000), "5 KB")
        XCTAssertEqual(NativeLibraries.mb(3_000_000), "3 MB")
        let f = fx.src.appendingPathComponent("abc.txt")
        try! "abc".write(to: f, atomically: true, encoding: .utf8)
        XCTAssertEqual(NativeLibraries.sha256(of: f), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertNil(NativeLibraries.sha256(of: fx.src.appendingPathComponent("missing")))
        XCTAssertGreaterThan(NativeLibraries.size(of: fx.src), 0)
        XCTAssertEqual(NativeLibraries.size(of: fx.src.appendingPathComponent("missing")), 0)

        let echo = NativeLibraries.run("/bin/echo", ["hi"], timeout: 10)
        XCTAssertEqual(echo.code, 0); XCTAssertEqual(echo.out, "hi\n")
        XCTAssertEqual(NativeLibraries.run(fx.src.appendingPathComponent("nope").path, [], timeout: 10).code, -1)
        let start = Date()
        let slow = NativeLibraries.run("/bin/sleep", ["5"], timeout: 0.2)
        XCTAssertEqual(slow.code, -2); XCTAssertEqual(slow.out, "timed out")
        XCTAssertLessThan(Date().timeIntervalSince(start), 4)
    }

    func testVerifyAndUnpack() {
        let payload = fx.base.appendingPathComponent("payload")
        try! FileManager.default.createDirectory(at: payload, withIntermediateDirectories: true)
        let missing = NativeLibraries.verifyAndUnpack(fx.src.appendingPathComponent("x"), sha256: "", artifact: ["name": "x"], into: payload)
        XCTAssertEqual(missing, "cannot read x")

        let plain = fx.src.appendingPathComponent("tool.sh")
        try! "#!/bin/sh\necho t\n".write(to: plain, atomically: true, encoding: .utf8)
        let sha = NativeLibraries.sha256(of: plain)!
        let bad = NativeLibraries.verifyAndUnpack(plain, sha256: String(repeating: "0", count: 64), artifact: ["name": "tool.sh"], into: payload)!
        XCTAssertTrue(bad.hasPrefix("SHA-256 mismatch for tool.sh"), bad)
        XCTAssertFalse(FileManager.default.fileExists(atPath: payload.appendingPathComponent("tool.sh").path))
        // No format: a plain file, made executable; upper-case hashes match too.
        XCTAssertNil(NativeLibraries.verifyAndUnpack(plain, sha256: sha.uppercased(), artifact: ["name": "tool.sh"], into: payload))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: payload.appendingPathComponent("tool.sh").path))
        XCTAssertEqual(NativeLibraries.verifyAndUnpack(plain, sha256: sha, artifact: ["name": "tool.sh", "format": "file"], into: payload),
                       "cannot place tool.sh")
        // Not an archive.
        XCTAssertTrue(NativeLibraries.verifyAndUnpack(plain, sha256: sha, artifact: ["name": "t.zip", "format": "zip"], into: payload)!
            .hasPrefix("cannot unpack t.zip"))
        XCTAssertTrue(NativeLibraries.verifyAndUnpack(plain, sha256: sha, artifact: ["name": "t.tar", "format": "tar"], into: payload)!
            .hasPrefix("cannot unpack t.tar"))
        // Real archives.
        let zip = fx.artifact("z.zip", format: "zip", files: ["bin/z": "#!/bin/sh\necho z\n"], bin: [:])
        XCTAssertNil(NativeLibraries.verifyAndUnpack(fx.file(zip), sha256: zip["sha256"] as! String, artifact: zip, into: payload))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: payload.appendingPathComponent("bin/z").path))
        let tar = fx.artifact("t.tar", files: ["lib/t": "#!/bin/sh\necho t\n"], bin: [:])
        XCTAssertNil(NativeLibraries.verifyAndUnpack(fx.file(tar), sha256: tar["sha256"] as! String, artifact: tar, into: payload))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: payload.appendingPathComponent("lib/t").path))
    }

    func testFinishStaging() {
        let fm = FileManager.default
        func staging(_ files: [String: String]) -> URL {
            let s = fx.base.appendingPathComponent("staging-\(UUID().uuidString)")
            for (rel, text) in files {
                let f = s.appendingPathComponent("payload/\(rel)")
                try! fm.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
                try! text.write(to: f, atomically: true, encoding: .utf8)
                chmod(f.path, 0o755)
            }
            try? fm.createDirectory(at: s.appendingPathComponent("payload"), withIntermediateDirectories: true)
            return s
        }
        let evil = staging([:])
        try! fm.createSymbolicLink(atPath: evil.appendingPathComponent("payload/etc").path, withDestinationPath: "/etc")
        XCTAssertEqual(NativeLibraries.finishStaging(evil, bins: [:], check: []), "unpacked link points outside: etc")

        let inner = staging(["bin/a": "#!/bin/sh\necho a\n"])
        try! fm.createSymbolicLink(atPath: inner.appendingPathComponent("payload/alias").path, withDestinationPath: "bin/a")
        XCTAssertNil(NativeLibraries.finishStaging(inner, bins: ["a": "bin/a"], check: ["a", "-v"]))
        XCTAssertEqual(try? fm.destinationOfSymbolicLink(atPath: inner.appendingPathComponent("bin/a").path), "../payload/bin/a")

        XCTAssertEqual(NativeLibraries.finishStaging(staging([:]), bins: ["../a": "bin/a"], check: []), "bad executable path bin/a")
        XCTAssertEqual(NativeLibraries.finishStaging(staging([:]), bins: ["a": "../a"], check: []), "bad executable path ../a")
        XCTAssertEqual(NativeLibraries.finishStaging(staging([:]), bins: ["a": "bin/a"], check: []), "a missing from the package (bin/a)")

        let taken = staging(["bin/a": "#!/bin/sh\n"])
        try! fm.createDirectory(at: taken.appendingPathComponent("bin/a"), withIntermediateDirectories: true)
        XCTAssertEqual(NativeLibraries.finishStaging(taken, bins: ["a": "bin/a"], check: []), "cannot link a")

        let failing = staging(["bin/f": "#!/bin/sh\necho broken\nexit 3\n"])
        XCTAssertEqual(NativeLibraries.finishStaging(failing, bins: ["f": "bin/f"], check: ["f"]), "f does not run here (exit 3): broken\n")
        let tolerated = staging(["bin/f": "#!/bin/sh\nexit 3\n"])
        XCTAssertNil(NativeLibraries.finishStaging(tolerated, bins: ["f": "bin/f"], check: ["f", "--help"], codes: [0, 3]))
    }

    // MARK: install

    func testInstallByDownloadLinksPersistsAndReports() {
        let t = fx.tool("jq", "1.7")
        let n = fx.store(fx.catalog([t]))
        fx.serve(t)
        XCTAssertNil(install(n, "jq"))
        XCTAssertEqual(runBin(n, "jq", ["x"]), "jq 1.7 x\n")
        XCTAssertEqual(link(n, "jq"), "../jq/current/payload/bin/jq")
        XCTAssertEqual(try? FileManager.default.destinationOfSymbolicLink(atPath: n.dir.appendingPathComponent("jq/current").path), "1.7")
        let r = row(n, "jq")
        XCTAssertEqual(r["installed"] as? Bool, true)
        XCTAssertEqual(r["installedVersion"] as? String, "1.7")
        XCTAssertEqual(r["fromPack"] as? Bool, false)
        XCTAssertTrue(r["previous"] is NSNull)
        XCTAssertGreaterThan(r["diskBytes"] as? Int ?? 0, 0)
        XCTAssertGreaterThan(n.used, 0)
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: n.dir.path))?.filter { $0.hasPrefix(".") } ?? []
        XCTAssertEqual(leftovers, [])
        spin()
        XCTAssertTrue(sharedEvents.contains { $0.contains("\"id\":\"native-jq\"") && $0.contains("downloading jq 1.7") })
        XCTAssertTrue(sharedEvents.contains { $0.contains("\"id\":\"native-jq\"") && $0.contains("\"done\":true") })

        // Again: nothing to do, no request.
        let requests = MockURL.seen.count
        XCTAssertNil(install(n, "jq"))
        XCTAssertEqual(MockURL.seen.count, requests)
        XCTAssertEqual(MockURL.seen.last?.headers["User-Agent"], "aiui")

        // A new instance reads the state back.
        let again = fx.store(fx.catalog([t]))
        XCTAssertEqual(again.used, n.used)
        XCTAssertEqual(row(again, "jq")["installedVersion"] as? String, "1.7")
    }

    func testDownloadReportsProgress() {
        let t = fx.tool("slow")
        let n = fx.store(fx.catalog([t]))
        n.progressInterval = 0.05
        fx.serve(t, delay: 1)
        XCTAssertNil(install(n, "slow"))
        spin()
        XCTAssertTrue(sharedEvents.contains { $0.contains("\"id\":\"native-slow\"") && $0.contains(" / ") }, "\(sharedEvents)")
    }

    func testZipAndFileFormats() {
        let z = fx.tool("zz", format: "zip"), f = fx.tool("ff", format: "file")
        let n = fx.store(fx.catalog([z, f]))
        fx.serve(z); fx.serve(f)
        XCTAssertNil(install(n, "zz"))
        XCTAssertNil(install(n, "ff"))
        XCTAssertEqual(runBin(n, "zz"), "zz 1.0 \n")
        XCTAssertEqual(runBin(n, "ff"), "ff 1.0 \n")
        let fname = (fx.arts(f)[0]["name"] as! String)
        XCTAssertEqual(link(n, "ff"), "../ff/current/payload/\(fname)")
    }

    func testUpdateRollbackAndPrune() {
        let v1 = fx.tool("jq", "1"), v2 = fx.tool("jq", "2"), v3 = fx.tool("jq", "3")
        fx.serve(v1); fx.serve(v2); fx.serve(v3)
        let n = fx.store(fx.catalog([v1]))
        XCTAssertNil(install(n, "jq"))
        n.bundledCatalog = fx.catalog([v2], version: 2); n.loadCatalog()
        XCTAssertNil(install(n, "jq"))
        XCTAssertEqual(runBin(n, "jq"), "jq 2 \n")
        XCTAssertEqual(row(n, "jq")["previous"] as? String, "1")

        XCTAssertNil(n.rollback("jq"))
        XCTAssertEqual(runBin(n, "jq"), "jq 1 \n")
        XCTAssertEqual(row(n, "jq")["installedVersion"] as? String, "1")
        XCTAssertEqual(row(n, "jq")["previous"] as? String, "2")
        XCTAssertNil(n.rollback("jq"))
        XCTAssertEqual(runBin(n, "jq"), "jq 2 \n")

        n.bundledCatalog = fx.catalog([v3], version: 3); n.loadCatalog()
        XCTAssertNil(install(n, "jq"))
        let versions = Set((try? FileManager.default.contentsOfDirectory(atPath: n.dir.appendingPathComponent("jq").path)) ?? [])
        XCTAssertEqual(versions, ["current", "2", "3"])
        XCTAssertEqual(n.rollback("nope"), "no earlier version of nope")

        // current cannot be replaced (a folder in its way): the rollback says so.
        let cur = n.dir.appendingPathComponent("jq/current")
        try! FileManager.default.removeItem(at: cur)
        try! FileManager.default.createDirectory(at: cur.appendingPathComponent("x"), withIntermediateDirectories: true)
        XCTAssertEqual(n.rollback("jq"), "could not switch jq back")
    }

    func testInstallFailures() {
        let mismatch = fx.tool("mm"), missing = fx.tool("nf"), offline = fx.tool("off"), broken = fx.tool("br", body: "echo no >&2\nexit 3\n")
        let tolerated = fx.tool("tol", body: "exit 3\n", extra: ["checkCodes": [3]])
        var badURL = fx.tool("bu"); var a = fx.arts(badURL)[0]; a["url"] = "https://[bad"; badURL["artifacts"] = [a]
        let moved = fx.tool("mv"), swapped = fx.tool("sw")
        let n = fx.store(fx.catalog([mismatch, missing, offline, broken, tolerated, badURL, moved, swapped]))
        MockURL.on(fx.arts(mismatch)[0]["url"] as! String, .text("something else"))
        MockURL.on(fx.arts(missing)[0]["url"] as! String, .text("", status: 404))
        MockURL.on(fx.arts(offline)[0]["url"] as! String, .fail())
        fx.serve(broken); fx.serve(tolerated); fx.serve(moved); fx.serve(swapped)

        XCTAssertEqual(install(n, "zz"), "zz is not in the native catalog")
        let err = install(n, "mm")!
        XCTAssertTrue(err.hasPrefix("SHA-256 mismatch"), err)
        XCTAssertEqual(n.errors["mm"], err)
        XCTAssertEqual(row(n, "mm")["error"] as? String, err)
        XCTAssertEqual(install(n, "nf"), "download failed for \(fx.arts(missing)[0]["name"]!): HTTP 404")
        XCTAssertTrue(install(n, "off")!.hasPrefix("download failed for \(fx.arts(offline)[0]["name"]!): "))
        XCTAssertEqual(install(n, "br"), "br does not run here (exit 3): no\n")
        XCTAssertNil(install(n, "tol"))
        XCTAssertEqual(install(n, "bu"), "bad url for \(a["name"]!)")

        try! "x".write(to: n.dir.appendingPathComponent("mv"), atomically: true, encoding: .utf8)
        XCTAssertTrue(install(n, "mv")!.hasPrefix("could not move into place: "))
        try! FileManager.default.createDirectory(at: n.dir.appendingPathComponent("sw/current/x"), withIntermediateDirectories: true)
        XCTAssertEqual(install(n, "sw"), "could not switch to 1.0")

        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: n.dir.path))?.filter { $0.hasPrefix(".") } ?? []
        XCTAssertEqual(leftovers, [])
        XCTAssertEqual(row(n, "tol")["installed"] as? Bool, true)
        XCTAssertEqual(row(n, "br")["installed"] as? Bool, false)

        XCTAssertEqual(install(n, "nf", packOnly: true), "not in the pack")
        NativeLibraries.settingOn = false
        XCTAssertEqual(install(n, "nf"), "downloads blocked: turned off in Settings (Download native libraries)")
        XCTAssertEqual(n.policy()["lastBlocked"] as? String, "turned off in Settings (Download native libraries)")
    }

    func testCancel() {
        // While downloading.
        let dl = fx.tool("dl")
        // Between artifacts: both come from the pack; the first is unpacking when the cancel comes.
        var two = fx.tool("two")
        let second = fx.artifact("two-b.tar", files: ["lib/b": "#!/bin/sh\n"], bin: [:])
        two["artifacts"] = fx.arts(two) + [second]
        fx.addToPack(two)
        // While its check runs.
        let marker = fx.base.appendingPathComponent("checking")
        let chk = fx.tool("chk", body: "touch '\(marker.path)'\nsleep 0.5\n")
        let n = fx.store(fx.catalog([dl, two, chk]), pack: true)
        fx.serve(dl, delay: 3); fx.serve(chk)

        n.cancel("nothing")   // not installing: no-op
        var r1: String?, r2: String?, r3: String?
        n.install("dl") { r1 = $0 }
        waitUntil { MockURL.seen.contains { $0.url.absoluteString.contains("dl.test") } }
        n.cancel("dl")
        waitUntil { r1 != nil }
        XCTAssertEqual(r1, "cancelled")

        n.install("two") { r2 = $0 }
        n.cancel("two")
        waitUntil { r2 != nil }
        XCTAssertEqual(r2, "cancelled")

        n.install("chk") { r3 = $0 }
        waitUntil { FileManager.default.fileExists(atPath: marker.path) }
        n.cancel("chk")
        waitUntil { r3 != nil }
        XCTAssertEqual(r3, "cancelled")
        for id in ["dl", "two", "chk"] {
            XCTAssertEqual(row(n, id)["installed"] as? Bool, false)
            XCTAssertEqual(row(n, id)["error"] as? String, "cancelled")
        }
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: n.dir.path))?.filter { $0.hasPrefix(".") } ?? []
        XCTAssertEqual(leftovers, [])
    }

    func testConcurrentInstallsShareOneJob() {
        let t = fx.tool("one")
        let n = fx.store(fx.catalog([t]))
        fx.serve(t, delay: 0.2)
        var a: String?? = .none, b: String?? = .none
        n.install("one") { a = .some($0) }
        n.install("one") { b = .some($0) }
        XCTAssertEqual(n.status()["installing"] as? [String], ["one"])
        XCTAssertNotNil(n.overview()["installing"])
        waitUntil { a != nil && b != nil }
        XCTAssertEqual(a, .some(nil)); XCTAssertEqual(b, .some(nil))
        XCTAssertEqual(MockURL.seen.filter { $0.url.absoluteString.contains("dl.test") }.count, 1)
    }

    // MARK: policy

    func testPolicy() {
        let n = fx.store(nil)
        var net: NativeLibraries.NetState? = nil
        n.networkOverride = { net }
        XCTAssertNil(n.blocked(background: true))
        XCTAssertEqual(n.policy()["network"] as? String, "unknown")
        XCTAssertEqual(n.policy()["allowed"] as? Bool, true)
        XCTAssertTrue(n.policy()["managed"] is NSNull)
        XCTAssertTrue(n.policy()["reason"] is NSNull)

        net = .init(satisfied: false, constrained: false, expensive: false)
        XCTAssertEqual(n.blocked(background: false), "offline")
        XCTAssertEqual(n.policy()["network"] as? String, "offline")
        net = .init(satisfied: true, constrained: true, expensive: true)
        XCTAssertEqual(n.blocked(background: false), "Low Data Mode is on")
        XCTAssertEqual(n.policy()["network"] as? String, "low data mode")
        net = .init(satisfied: true, constrained: false, expensive: true)
        XCTAssertEqual(n.blocked(background: false), "the network is metered")
        XCTAssertEqual(n.policy()["network"] as? String, "metered")
        net = NativeFixture.ok
        XCTAssertEqual(n.policy()["network"] as? String, "ok")

        API.paused = true
        XCTAssertEqual(n.blocked(background: true), "background work is paused")
        XCTAssertNil(n.blocked(background: false))
        XCTAssertEqual(n.policy()["allowed"] as? Bool, false)
        XCTAssertEqual(n.policy()["foregroundAllowed"] as? Bool, true)
        XCTAssertEqual(n.policy()["paused"] as? Bool, true)
        API.paused = false

        NativeLibraries.settingOn = false
        XCTAssertEqual(n.blocked(background: false), "turned off in Settings (Download native libraries)")
        XCTAssertEqual(n.policy()["setting"] as? Bool, false)
        NativeLibraries.settingOn = true

        NativeLibraries.adminForced = { $0 == "AllowNativeDownloads" }
        UserDefaults.standard.set(false, forKey: "AllowNativeDownloads")
        XCTAssertEqual(n.blocked(background: false), "denied by an administrator policy (AllowNativeDownloads)")
        XCTAssertEqual(n.policy()["managed"] as? Bool, false)
        UserDefaults.standard.set(true, forKey: "AllowNativeDownloads")
        XCTAssertNil(n.blocked(background: false))
        XCTAssertEqual(n.policy()["managed"] as? Bool, true)
    }

    func testNetworkMonitorReportsThePath() {
        let n = NativeLibraries(dir: fx.dir)
        waitUntil(10) { n.monitoredPath != nil }
        // Without an override the policy uses what the monitor reported.
        XCTAssertNotEqual(n.policy()["network"] as? String, "unknown")
    }

    // MARK: disk budget

    func testBudgetAndEviction() {
        let old = Date().addingTimeInterval(-2 * 86400)
        fx.fakeInstalled([NativeFixture.installed("old1", lastUsed: old),
                          NativeFixture.installed("new1"),
                          NativeFixture.installed("def1", isDefault: true, lastUsed: old)])
        let want = fx.tool("want"), other = fx.tool("other")
        let n = fx.store(fx.catalog([want, other, fx.tool("old1"), fx.tool("new1"), fx.tool("def1", isDefault: true)]))
        fx.serve(want); fx.serve(other)
        XCTAssertEqual(n.used, 3000)
        XCTAssertEqual(n.budget, 10_000_000_000)
        UserDefaults.standard.set(1.0, forKey: "budgetGB")
        n.otherBytes = { 100 }
        XCTAssertEqual(n.budget, 999_999_900)

        n.otherBytes = { Int.max / 2 }
        XCTAssertEqual(n.budget, 0)
        XCTAssertEqual(install(n, "want", background: true), "no room in the disk budget")
        XCTAssertEqual(row(n, "old1")["installed"] as? Bool, false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: n.dir.appendingPathComponent("old1").path))
        XCTAssertEqual(row(n, "new1")["installed"] as? Bool, true)
        XCTAssertEqual(row(n, "def1")["installed"] as? Bool, true)
        // Asked for in the foreground: installed anyway while the disk itself has room.
        XCTAssertNil(install(n, "want"))
        // The disk is tight (under 5 GB free): nothing more.
        Libraries.availableCapacity = { 4_000_000_000 }
        XCTAssertEqual(install(n, "other"), "no room in the disk budget")
    }

    func testShellUseCountsAsUse() {
        let installedAt = Date().addingTimeInterval(-86400), used = Date(timeIntervalSince1970: Double(Int(Date().timeIntervalSince1970) - 3600))
        fx.fakeInstalled([NativeFixture.installed("sh1", installed: installedAt, lastUsed: Date().addingTimeInterval(-2 * 86400))])
        let f = fx.dir.appendingPathComponent("sh1/1.0/payload/bin/sh1")
        var times = [timeval(tv_sec: Int(used.timeIntervalSince1970), tv_usec: 0), timeval(tv_sec: Int(used.timeIntervalSince1970), tv_usec: 0)]
        XCTAssertEqual(utimes(f.path, &times), 0)
        let n = fx.store(fx.catalog([fx.tool("sh1")]))
        XCTAssertEqual(row(n, "sh1")["lastUsed"] as? String, ISO8601DateFormatter().string(from: used))
    }

    // MARK: maintenance

    func testPackInstallsOfflineThenStopsWhenBlocked() {
        let pk = fx.tool("pk", isDefault: true), dl = fx.tool("dl", isDefault: true)
        fx.addToPack(pk)
        let n = fx.store(fx.catalog([pk, dl]), pack: true)
        n.networkOverride = { .init(satisfied: false, constrained: false, expensive: false) }
        maintain(n)
        XCTAssertEqual(row(n, "pk")["installed"] as? Bool, true)
        XCTAssertEqual(row(n, "pk")["fromPack"] as? Bool, true)
        XCTAssertEqual(row(n, "dl")["installed"] as? Bool, false)
        XCTAssertEqual(n.lastBlocked, "offline")
        XCTAssertEqual(n.status()["pack"] as? Bool, true)
        XCTAssertTrue(MockURL.seen.isEmpty)
        XCTAssertEqual(runBin(n, "pk"), "pk 1.0 \n")
        XCTAssertEqual(install(n, "dl", packOnly: true), "not in the pack")
        n.packDir = nil
        XCTAssertEqual(n.status()["pack"] as? Bool, false)

        // A pass already running: the second returns at once.
        var first = false, second = false
        n.networkOverride = { NativeFixture.ok }   // so the pass waits on the catalog check
        n.maintain { first = true }
        n.maintain { second = true }
        XCTAssertTrue(second)
        waitUntil { first }
    }

    func testMaintainUpdatesCatalogAndInstallsDueTools() {
        let a = fx.tool("aa", isDefault: true), b1 = fx.tool("bb", "1.0"), b2 = fx.tool("bb", "2.0"), c = fx.tool("cc")
        fx.serve(a); fx.serve(b1); fx.serve(b2)
        let n = fx.store(fx.catalog([a, b1], version: 1))
        XCTAssertNil(install(n, "bb"))
        MockURL.on("native.test/native.json", MockURL.Response(body: fx.catalogData([a, b2, c], version: 5)))
        maintain(n)
        XCTAssertEqual(n.catalog["version"] as? Int, 5)
        XCTAssertTrue(FileManager.default.fileExists(atPath: n.dir.appendingPathComponent("catalog.json").path))
        XCTAssertEqual(row(n, "aa")["installed"] as? Bool, true)
        XCTAssertEqual(row(n, "bb")["installedVersion"] as? String, "2.0")
        XCTAssertEqual(row(n, "cc")["installed"] as? Bool, false)
        XCTAssertFalse(n.status()["lastUpdateCheck"] is NSNull)
        XCTAssertNil(n.lastBlocked)
        let fetches = { MockURL.seen.filter { $0.url.absoluteString.contains("native.test") }.count }
        XCTAssertEqual(fetches(), 1)
        XCTAssertEqual(MockURL.seen.first { $0.url.absoluteString.contains("native.test") }?.headers["User-Agent"], "aiui")
        // Checked within the hour: not again.
        maintain(n)
        XCTAssertEqual(fetches(), 1)
        // "update" checks now; a bad answer changes nothing.
        MockURL.on("native.test/native.json", .text("{bad"))
        _ = handle(n, ["op": "update"])
        XCTAssertEqual(fetches(), 2)
        XCTAssertEqual(n.catalog["version"] as? Int, 5)
        MockURL.on("native.test/native.json", .text("", status: 500))
        _ = handle(n, ["op": "update"])
        XCTAssertEqual(n.catalog["version"] as? Int, 5)
    }

    func testFailedDefaultsWaitUntilANewCatalog() {
        let d = fx.tool("dd", isDefault: true)
        let n = fx.store(fx.catalog([d], version: 1))
        let url = fx.arts(d)[0]["url"] as! String
        MockURL.on(url, .text("", status: 404))
        MockURL.on("native.test/native.json", .fail())
        maintain(n)
        XCTAssertNotNil(n.errors["dd"])
        let tries = { MockURL.seen.filter { $0.url.absoluteString == url }.count }
        XCTAssertEqual(tries(), 1)
        _ = handle(n, ["op": "update"])
        XCTAssertEqual(tries(), 1)
        // A newer catalog clears earlier failures: tried again.
        fx.serve(d)
        MockURL.on("native.test/native.json", MockURL.Response(body: fx.catalogData([d], version: 2)))
        _ = handle(n, ["op": "update"])
        XCTAssertEqual(tries(), 2)
        XCTAssertNil(n.errors["dd"])
        XCTAssertEqual(row(n, "dd")["installed"] as? Bool, true)
    }

    func testBlockedWhileCheckingStopsTheQueue() {
        let d = fx.tool("dd", isDefault: true)
        let n = fx.store(fx.catalog([d]))
        MockURL.on("native.test/native.json", MockURL.Response(status: 404, delay: 1))
        var net = NativeFixture.ok
        n.networkOverride = { net }
        var done = false
        n.maintain { done = true }
        waitUntil { MockURL.seen.contains { $0.url.absoluteString.contains("native.test") } }
        net = .init(satisfied: true, constrained: false, expensive: true)
        waitUntil { done }
        XCTAssertEqual(n.lastBlocked, "the network is metered")
        XCTAssertEqual(row(n, "dd")["installed"] as? Bool, false)
        XCTAssertTrue(MockURL.seen.allSatisfy { !$0.url.absoluteString.contains("dl.test") })
    }

    // MARK: links and removal

    func testSharedExecutableNamesAndRemoval() {
        let a = fx.tool("ta", exe: "same"), b = fx.tool("tb", exe: "same")
        let n = fx.store(fx.catalog([a, b]))
        fx.serve(a); fx.serve(b)
        // A link left by a tool that is no longer installed is taken over.
        try! FileManager.default.createSymbolicLink(atPath: n.dir.appendingPathComponent("bin/same").path,
                                                    withDestinationPath: "../ghost/current/payload/bin/same")
        XCTAssertNil(install(n, "ta"))
        XCTAssertEqual(link(n, "same"), "../ta/current/payload/bin/same")
        XCTAssertNil(install(n, "tb"))
        XCTAssertEqual(link(n, "same"), "../ta/current/payload/bin/same")   // stays the first tool's
        XCTAssertEqual(runBin(n, "same"), "same 1.0 \n")

        n.remove("../evil")   // not an id: ignored
        n.remove("ta")
        XCTAssertNil(link(n, "same"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: n.dir.appendingPathComponent("ta").path))
        n.start(after: 1000)   // links what is installed
        XCTAssertEqual(link(n, "same"), "../tb/current/payload/bin/same")
        // Removing a tool whose name is someone else's leaves that link.
        try! FileManager.default.removeItem(at: n.dir.appendingPathComponent("bin/same"))
        try! FileManager.default.createSymbolicLink(atPath: n.dir.appendingPathComponent("bin/same").path, withDestinationPath: "../zz/x")
        n.remove("tb")
        XCTAssertEqual(link(n, "same"), "../zz/x")
        XCTAssertEqual(row(n, "tb")["installed"] as? Bool, false)
    }

    func testLinksThatCannotBeMade() {
        // An installed tool whose executable is not a link into its payload is skipped.
        fx.fakeInstalled([NativeFixture.installed("odd", exes: ["odd", "ghost"])])
        try! FileManager.default.removeItem(at: fx.dir.appendingPathComponent("odd/1.0/bin/ghost"))
        let t = fx.tool("blk")
        let n = fx.store(fx.catalog([t, fx.tool("odd")]))
        fx.serve(t)
        n.start(after: 1000)
        XCTAssertEqual(link(n, "odd"), "../odd/current/payload/bin/odd")
        XCTAssertNil(link(n, "ghost"))
        // A folder where the link should go: the link is not made, the install still is.
        try! FileManager.default.createDirectory(at: n.dir.appendingPathComponent("bin/blk/x"), withIntermediateDirectories: true)
        XCTAssertNil(install(n, "blk"))
        XCTAssertNil(link(n, "blk"))
        XCTAssertEqual(row(n, "blk")["installed"] as? Bool, true)
        // No bin folder at all: nothing can be linked or written there.
        try! FileManager.default.removeItem(at: n.dir.appendingPathComponent("bin"))
        n.start(after: 1000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: n.dir.appendingPathComponent("bin").path))
    }

    func testInitDropsLeftoversAndMissingInstalls() {
        fx.fakeInstalled([NativeFixture.installed("kept"), NativeFixture.installed("gone")])
        try! FileManager.default.removeItem(at: fx.dir.appendingPathComponent("gone"))
        let staging = fx.dir.appendingPathComponent(".staging-x-1")
        try! FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let n = fx.store(fx.catalog([fx.tool("kept"), fx.tool("gone")]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertEqual(row(n, "kept")["installed"] as? Bool, true)
        XCTAssertEqual(row(n, "gone")["installed"] as? Bool, false)
    }

    // MARK: requests

    func testEnsure() {
        fx.fakeInstalled([NativeFixture.installed("have")])
        let get = fx.tool("get"), slow = fx.tool("slow"), bad = fx.tool("bad")
        let n = fx.store(fx.catalog([fx.tool("have"), get, slow, bad]))
        fx.serve(get); fx.serve(slow, delay: 2)
        MockURL.on(fx.arts(bad)[0]["url"] as! String, .text("", status: 404))

        var r: [String: Any]?
        n.ensure(["have", "get", "nope", "bad"], wait: 10) { r = $0 }
        waitUntil { r != nil }
        XCTAssertEqual(r?["ready"] as? [String], ["have", "get"])
        let failed = r?["failed"] as? [String: String]
        XCTAssertEqual(failed?["nope"], "not in the native catalog")
        XCTAssertEqual(failed?["bad"], "download failed for \(fx.arts(bad)[0]["name"]!): HTTP 404")
        XCTAssertEqual(r?["executables"] as? [String], ["have", "get"])
        XCTAssertEqual(r?["path"] as? String, n.dir.appendingPathComponent("bin").path)
        XCTAssertNil(r?["downloads"])
        XCTAssertEqual(row(n, "have")["uses"] as? Int, 1)

        r = nil
        n.ensure(["slow"], wait: 0.1) { r = $0 }
        waitUntil { r != nil }
        XCTAssertEqual(r?["pending"] as? [String], ["slow"])
        XCTAssertEqual(r?["ready"] as? [String], [])
        waitUntil { self.row(n, "slow")["installed"] as? Bool == true }

        NativeLibraries.settingOn = false
        n.remove("get")
        r = nil
        n.ensure(["get"], wait: 10) { r = $0 }
        waitUntil { r != nil }
        XCTAssertEqual(r?["downloads"] as? String, "blocked: turned off in Settings (Download native libraries)")
        XCTAssertEqual((r?["failed"] as? [String: String])?["get"], "downloads blocked: turned off in Settings (Download native libraries)")
    }

    func testHandleOps() {
        let v1 = fx.tool("jq", "1"), v2 = fx.tool("jq", "2"), other = fx.tool("yq")
        fx.serve(v1); fx.serve(v2); fx.serve(other)
        let n = fx.store(fx.catalog([v1, other]))
        XCTAssertNotNil(handle(n, [:])["tools"])
        XCTAssertNotNil(handle(n, ["action": "status"])["tools"])
        let ensured = handle(n, ["op": "ensure", "id": "yq"])
        XCTAssertEqual(ensured["ready"] as? [String], ["yq"])
        XCTAssertEqual(handle(n, ["op": "ensure", "ids": ["jq"], "wait": 10.0])["ready"] as? [String], ["jq"])
        XCTAssertEqual(handle(n, ["op": "rollback", "id": "jq"])["error"] as? String, "no earlier version of jq")
        n.bundledCatalog = fx.catalog([v2, other], version: 2); n.loadCatalog()
        XCTAssertNil(install(n, "jq"))
        XCTAssertNotNil(handle(n, ["op": "rollback", "id": "jq"])["tools"])
        XCTAssertEqual(row(n, "jq")["installedVersion"] as? String, "1")
        XCTAssertNotNil(handle(n, ["op": "cancel", "id": "jq"])["tools"])
        let removed = handle(n, ["op": "remove", "id": "yq"])
        XCTAssertEqual((removed["tools"] as? [[String: Any]])?.first { $0["id"] as? String == "yq" }?["installed"] as? Bool, false)
        XCTAssertNil(link(n, "yq"))

        MockURL.on("native.test/native.json", .fail())
        XCTAssertNotNil(handle(n, ["op": "update"])["catalogVersion"])
        XCTAssertEqual((handle(n, ["op": "setting", "on": false])["policy"] as? [String: Any])?["setting"] as? Bool, false)
        XCTAssertFalse(NativeLibraries.settingOn)
        XCTAssertEqual((handle(n, ["op": "setting"])["policy"] as? [String: Any])?["setting"] as? Bool, false)   // no "on": unchanged
        XCTAssertEqual((handle(n, ["op": "setting", "on": true])["policy"] as? [String: Any])?["setting"] as? Bool, true)
        XCTAssertTrue(NativeLibraries.settingOn)
        // Turning it on starts a maintenance pass: the outdated jq is brought up to date.
        waitUntil { self.row(n, "jq")["installedVersion"] as? String == "2" && n.status()["installing"] as? [String] == [] }
    }

    func testOverview() {
        let v1 = fx.tool("jq", "1"), v2 = fx.tool("jq", "2"), yq = fx.tool("yq"), zq = fx.tool("zq", extra: ["bytes": 3_000_000])
        fx.serve(v1); fx.serve(yq)
        let n = fx.store(fx.catalog([v1, yq, zq]))
        XCTAssertNil(install(n, "jq")); XCTAssertNil(install(n, "yq"))
        n.bundledCatalog = fx.catalog([v2, yq, zq], version: 2); n.loadCatalog()
        let o = n.overview()
        let inst = o["installed"] as? [String] ?? []
        XCTAssertTrue(inst.contains("jq 2 [jq] — jq tool; for testing (installed: 1)"), "\(inst)")
        XCTAssertTrue(inst.contains("yq 1.0 [yq] — yq tool; for testing"), "\(inst)")
        XCTAssertEqual(o["installable"] as? [String], ["zq 1.0 [zq] — zq tool; for testing · 3 MB download"])
        XCTAssertTrue((o["how"] as? String ?? "").contains(n.dir.appendingPathComponent("bin").path))
        XCTAssertNil(o["installing"]); XCTAssertNil(o["downloads"])
        NativeLibraries.settingOn = false
        XCTAssertEqual(n.overview()["downloads"] as? String,
                       "blocked: turned off in Settings (Download native libraries) — say so if a needed tool is missing")
    }

    func testRequestFolderAndHelper() throws {
        let t = fx.tool("jq")
        let n = fx.store(fx.catalog([t]))
        n.start(after: 1000)
        let helper = n.dir.appendingPathComponent("bin/aiui-native")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: helper.path))
        let req = n.dir.appendingPathComponent("requests")

        try Data(#"{"op":"list"}"#.utf8).write(to: req.appendingPathComponent("q1.json"))
        try Data("garbage".utf8).write(to: req.appendingPathComponent("q2.json"))
        try Data(#"{"op":"rollback","id":"zz"}"#.utf8).write(to: req.appendingPathComponent("q3.json"))
        try Data("{}".utf8).write(to: req.appendingPathComponent("bad name.json"))
        let out = { (name: String) in req.appendingPathComponent(name + ".out") }
        waitUntil { ["q1", "q2", "q3"].allSatisfy { FileManager.default.fileExists(atPath: out($0).path) } }
        let j = { (name: String) in (try? JSONSerialization.jsonObject(with: Data(contentsOf: out(name)))) as? [String: Any] ?? [:] }
        XCTAssertNotNil(j("q1")["tools"])
        XCTAssertNotNil(j("q2")["tools"])
        XCTAssertEqual(j("q3")["error"] as? String, "no earlier version of zz")
        XCTAssertTrue(FileManager.default.fileExists(atPath: req.appendingPathComponent("bad name.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: req.appendingPathComponent("q1.json").path))

        // The helper the AI uses, end to end (the app answers on this run loop).
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [helper.path, "list", "jq", "bad;id"]
        let pipe = Pipe()
        p.standardOutput = pipe
        try p.run()
        waitUntil(15) { !p.isRunning }
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        XCTAssertEqual(p.terminationStatus, 0)
        XCTAssertTrue(text.contains("\"tools\""), text)
    }

    func testRequestFolderThatCannotBeWatched() {
        let n = fx.store(fx.catalog([]))
        try! FileManager.default.createSymbolicLink(atPath: n.dir.appendingPathComponent("requests").path,
                                                    withDestinationPath: fx.base.appendingPathComponent("nowhere/at/all").path)
        n.start(after: 1000)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: n.dir.appendingPathComponent("bin/aiui-native").path))
        XCTAssertNotNil(n.status()["tools"])
    }
}
