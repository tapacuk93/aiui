import Cocoa

// CEF needs its NSApplication subclass to be the shared application.
let app = AIUIApplication.shared
// Local data (CEF cache) stays on this Mac; the AI's memory, utilities and profile live in
// Storage.root, which is the iCloud container when available.
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("aiui", isDirectory: true)
try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
API.evalJS = { AIUICef.evalJS($0) }
API.setFullScreen = { on in
    guard let w = NSApp.windows.first(where: { $0.isVisible }) else { return }
    if w.styleMask.contains(.fullScreen) != on { w.toggleFullScreen(nil) }
}

// Settings saved under the app's earlier bundle identifier (dev.aiui.app) carry over once.
if UserDefaults.standard.string(forKey: "engine") == nil,
   let old = UserDefaults(suiteName: "dev.aiui.app")?.string(forKey: "engine") {
    UserDefaults.standard.set(old, forKey: "engine")
}

let delegate = AppDelegate(support: Storage.root(local: support))
app.delegate = delegate

// AIUI_WEB=/path/to/web serves the UI straight from a source tree (live edits + Cmd-R).
let webRoot = ProcessInfo.processInfo.environment["AIUI_WEB"]
    ?? Bundle.main.resourceURL!.appendingPathComponent("web").path

guard AIUICef.start(
    withArgc: CommandLine.argc,
    argv: CommandLine.unsafeArgv,
    host: delegate.api,
    webRoot: webRoot,
    cachePath: support.appendingPathComponent("cef").path,
    onReady: { delegate.openWindow() }
) else {
    FileHandle.standardError.write("aiui: failed to start CEF\n".data(using: .utf8)!)
    exit(1)
}

AIUICef.runMessageLoop()
delegate.api.shutdown()
AIUICef.shutdown()
