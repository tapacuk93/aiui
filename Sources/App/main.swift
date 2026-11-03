import Cocoa

// CEF needs its NSApplication subclass to be the shared application.
let app = AIUIApplication.shared
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("aiui", isDirectory: true)
try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)

let delegate = AppDelegate(support: support)
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
