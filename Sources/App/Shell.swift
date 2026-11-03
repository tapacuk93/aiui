import Foundation

/// Runs processes with the user's login-shell environment (GUI apps get a bare PATH).
enum Shell {
    static let loginEnvironment: [String: String] = {
        var env = ProcessInfo.processInfo.environment
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "printf %s \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        if (try? p.run()) != nil {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            if let path = String(data: data, encoding: .utf8), !path.isEmpty { env["PATH"] = path }
        }
        let home = NSHomeDirectory()
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        var parts = (env["PATH"] ?? "/usr/bin:/bin").split(separator: ":").map(String.init)
        for e in extra where !parts.contains(e) { parts.append(e) }
        env["PATH"] = parts.joined(separator: ":")
        return env
    }()

    static func which(_ name: String) -> String? {
        for dir in (loginEnvironment["PATH"] ?? "").split(separator: ":") {
            let path = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    struct Result { var code: Int32; var stdout: String; var stderr: String }

    /// Runs to completion off the main thread and calls back on the main thread.
    static func run(_ exe: String, _ args: [String], stdin: String? = nil, cwd: String? = nil,
                    completion: @escaping (Result) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let r = runSync(exe, args, stdin: stdin, cwd: cwd)
            DispatchQueue.main.async { completion(r) }
        }
    }

    static func runSync(_ exe: String, _ args: [String], stdin: String? = nil, cwd: String? = nil) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = loginEnvironment
        p.currentDirectoryURL = URL(fileURLWithPath: cwd ?? NSHomeDirectory())
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = inp
        do { try p.run() } catch {
            return Result(code: -1, stdout: "", stderr: "\(error)")
        }
        if let s = stdin { inp.fileHandleForWriting.write(s.data(using: .utf8)!) }
        try? inp.fileHandleForWriting.close()
        var outData = Data(), errData = Data()
        let g = DispatchGroup()
        g.enter(); DispatchQueue.global().async { outData = out.fileHandleForReading.readDataToEndOfFile(); g.leave() }
        g.enter(); DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); g.leave() }
        g.wait()
        p.waitUntilExit()
        return Result(code: p.terminationStatus,
                      stdout: String(decoding: outData, as: UTF8.self),
                      stderr: String(decoding: errData, as: UTF8.self))
    }
}
