import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let api: API

    init(support: URL) {
        api = API(support: support)
        super.init()
    }
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMenu()
        NSApp.setActivationPolicy(.regular)
        // Other devices' changes arrive through iCloud: merge them in regularly.
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.api.syncNow() }
    }

    func applicationDidBecomeActive(_ notification: Notification) { api.syncNow() }

    func openWindow() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let size = NSSize(width: min(1180, screen.width * 0.85), height: min(800, screen.height * 0.85))
        let w = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        w.title = "AI UI"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        // Follows the system appearance; matches the page's --bg in both themes.
        w.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 11 / 255, green: 11 / 255, blue: 15 / 255, alpha: 1)
                : NSColor(red: 245 / 255, green: 245 / 255, blue: 248 / 255, alpha: 1)
        }
        w.minSize = NSSize(width: 520, height: 420)
        w.delegate = self
        w.setFrameAutosaveName("aiui.main")
        if !w.setFrameUsingName("aiui.main") { w.center() }
        w.isReleasedWhenClosed = false

        let content = NSView(frame: NSRect(origin: .zero, size: w.contentLayoutRect.size))
        content.autoresizingMask = [.width, .height]
        w.contentView = content
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = w

        AIUICef.createBrowser(in: content, url: "aiui://app/index.html")
    }

    // Closing the window closes the browser; CEF then ends the message loop.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        AIUICef.requestClose()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        AIUICef.requestClose()
        return .terminateCancel
    }

    @objc func showDevTools(_ sender: Any?) { AIUICef.showDevTools() }
    @objc func reloadPage(_ sender: Any?) { AIUICef.reload() }
    @objc func showLibrary(_ sender: Any?) {
        AIUICef.evalJS("window.aiui && aiui.library()")
    }

    @objc func showProfile(_ sender: Any?) {
        AIUICef.evalJS("window.aiui && aiui.profile()")
    }

    @objc func chooseAI(_ sender: Any?) {
        AIUICef.evalJS("window.aiui && aiui.setup()")
    }

    @objc func clearCache(_ sender: Any?) {
        api.cache.clear()
    }

    @objc func newSession(_ sender: Any?) {
        api.resetSession()
        AIUICef.evalJS("window.aiui && aiui.home()")
    }

    private func makeMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About AI UI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide AI UI", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit AI UI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "New Session", action: #selector(newSession(_:)), keyEquivalent: "n").target = self
        view.addItem(withTitle: "AI Provider…", action: #selector(chooseAI(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "What AI UI Knows About You…", action: #selector(showProfile(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "Utility Library…", action: #selector(showLibrary(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "Clear Memory Cache", action: #selector(clearCache(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r").target = self
        let dev = view.addItem(withTitle: "Developer Tools", action: #selector(showDevTools(_:)), keyEquivalent: "i")
        dev.keyEquivalentModifierMask = [.command, .option]
        dev.target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        main.addItem(windowItem)
        NSApp.windowsMenu = win

        return main
    }
}
