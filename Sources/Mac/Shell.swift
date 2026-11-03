import Foundation

/// Runs processes with the user's login-shell environment (GUI apps get a bare PATH).
enum Shell {
    // MARK: - Things the AI starts must not outlive the app

    /// Process groups of everything the app launched (each launch gets its own group, so the
    /// players and helpers it spawns in the background are in it too).
    private static var groups = Set<pid_t>()
    /// Playback the AI started in other apps (e.g. Music), stopped when the app quits.
    private static var media = Set<String>()
    private static let lock = NSLock()

    static func adopt(_ p: Process) {
        let pid = p.processIdentifier
        guard pid > 0 else { return }
        setpgid(pid, pid)
        lock.lock(); groups.insert(pid); lock.unlock()
    }

    /// Notes playback a command starts (Music/Spotify via AppleScript, afplay, say, streams).
    static func noteMedia(in command: String) {
        let c = command.lowercased()
        var found: [String] = []
        if c.contains("\"music\"") && (c.contains("play") || c.contains("open location")) { found.append("Music") }
        if c.contains("\"spotify\"") && c.contains("play") { found.append("Spotify") }
        if c.contains("\"tv\"") && c.contains("play") { found.append("TV") }
        if c.contains("quicktime player") && c.contains("play") { found.append("QuickTime Player") }
        guard !found.isEmpty else { return }
        lock.lock(); media.formUnion(found); lock.unlock()
    }

    static let launched = Date()

    /// Media players started while the app ran (the AI's shell can detach them into their own
    /// process group, so group cleanup alone misses them): stopped on quit.
    private static func stopPlayersStartedSinceLaunch() {
        let players: Set<String> = ["ffplay", "afplay", "mpv", "mpg123", "vlc", "cvlc", "say", "play", "mplayer", "ffmpeg"]
        let r = runSync("/bin/ps", ["-axo", "pid=,etime=,comm="])
        let uptime = Date().timeIntervalSince(launched)
        for line in r.stdout.split(separator: "\n") {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            guard parts.count >= 3, let pid = Int32(parts[0]) else { continue }
            let name = (String(parts[2...].joined(separator: " ")) as NSString).lastPathComponent
            guard players.contains(name) else { continue }
            // etime: [[dd-]hh:]mm:ss
            var secs = 0.0
            let e = String(parts[1]), dayParts = e.split(separator: "-")
            let clock = dayParts.last!.split(separator: ":").compactMap { Double($0) }
            for v in clock { secs = secs * 60 + v }
            if dayParts.count == 2, let d = Double(dayParts[0]) { secs += d * 86_400 }
            if secs < uptime { kill(pid, SIGTERM) }
        }
    }

    /// On quit: stops playback the AI started elsewhere and ends every launched process group.
    static func stopEverything() {
        stopPlayersStartedSinceLaunch()
        lock.lock(); let gs = groups, ms = media; lock.unlock()
        for app in ms {
            _ = runSync("/usr/bin/osascript", ["-e", "if application \"\(app)\" is running then tell application \"\(app)\" to pause"])
        }
        for g in gs { kill(-g, SIGTERM) }
        usleep(300_000)
        for g in gs { kill(-g, SIGKILL) }
    }

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
        adopt(p)
        if exe.hasSuffix("osascript") || exe.hasSuffix("zsh") { noteMedia(in: (args + [stdin ?? ""]).joined(separator: " ")) }
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
