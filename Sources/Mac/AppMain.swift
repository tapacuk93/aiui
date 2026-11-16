import Cocoa

/// What the process does from launch to quit (main.swift calls `run`). The parameters are the
/// outside world — folders, environment, settings, cleanup — so tests can drive a whole launch.
enum AppMain {
    static let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("aiui", isDirectory: true)

    /// Starts CEF and runs until the window closes; returns the process exit status.
    static func run(support: URL = support,
                    environment: [String: String] = ProcessInfo.processInfo.environment,
                    resources: URL? = Bundle.main.resourceURL,
                    defaults: UserDefaults = .standard,
                    legacy: UserDefaults? = UserDefaults(suiteName: "dev.aiui.app"), stop: () -> Void = Shell.stopEverything) -> Int32 {
        // CEF needs its NSApplication subclass to be the shared application.
        let app = AIUIApplication.shared
        // Local data (CEF cache) stays on this Mac; the AI's memory, utilities and profile live in
        // Storage.root, which is the iCloud container when available.
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        API.evalJS = { AIUICef.evalJS($0) }
        API.setFullScreen = { on in setFullScreen(on, windows: NSApp.windows) }
        migrateEngine(from: legacy, to: defaults)

        // AIUI_WEB=/path/to/web serves the UI straight from a source tree (live edits + Cmd-R).
        let webRoot = environment["AIUI_WEB"] ?? resources!.appendingPathComponent("web").path
        API.webRoot = URL(fileURLWithPath: webRoot)

        let delegate = AppDelegate(support: Storage.root(local: support), device: support)
        AIUICef.setVendorRoot(delegate.api.libraries.dir.path)
        app.delegate = delegate

        guard AIUICef.start(
            withArgc: CommandLine.argc,
            argv: CommandLine.unsafeArgv,
            host: delegate.api,
            webRoot: webRoot,
            cachePath: support.appendingPathComponent("cef").path,
            onReady: { delegate.openWindow() }
        ) else {
            FileHandle.standardError.write("aiui: failed to start CEF\n".data(using: .utf8)!)
            return 1
        }

        AIUICef.runMessageLoop()
        delegate.api.shutdown()
        stop()   // nothing the AI started outlives the app (players, background processes)
        AIUICef.shutdown()
        return 0
    }

    /// Settings saved under the app's earlier bundle identifier (dev.aiui.app) carry over once.
    static func migrateEngine(from legacy: UserDefaults?, to defaults: UserDefaults) {
        if defaults.string(forKey: "engine") == nil, let old = legacy?.string(forKey: "engine") {
            defaults.set(old, forKey: "engine")
        }
    }

    /// Puts the app's (first visible) window in or out of full screen.
    static func setFullScreen(_ on: Bool, windows: [NSWindow]) {
        guard let w = windows.first(where: { $0.isVisible }) else { return }
        if w.styleMask.contains(.fullScreen) != on { w.toggleFullScreen(nil) }
    }
}
