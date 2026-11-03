import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSToolbarDelegate {
    /// The address bar in the title bar: where you are, each level clickable.
    private let addressBar = AddressBar(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
    private static let addressItem = NSToolbarItem.Identifier("aiui.address")
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
        addressBar.onSelect = { i in AIUICef.evalJS("window.aiui && aiui.goTo(\(i))") }
        API.setAddress = { [weak self] items in self?.setAddress(items) }
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
        // The address: a plain path in the title bar, right after the window buttons (no toolbar,
        // so no bezel); the rest of the title bar stays draggable.
        if let zoom = w.standardWindowButton(.zoomButton), let titlebar = zoom.superview {
            addressBar.translatesAutoresizingMaskIntoConstraints = false
            titlebar.addSubview(addressBar)
            NSLayoutConstraint.activate([
                addressBar.leadingAnchor.constraint(equalTo: zoom.trailingAnchor, constant: 14),
                addressBar.centerYAnchor.constraint(equalTo: zoom.centerYAnchor),
                addressBar.trailingAnchor.constraint(lessThanOrEqualTo: titlebar.trailingAnchor, constant: -16),
            ])
        }

        AIUICef.createBrowser(in: content, url: "aiui://app/index.html")
    }

    // MARK: - Address bar

    func setAddress(_ items: [String]) { addressBar.set(items) }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [Self.addressItem, .flexibleSpace] }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [Self.addressItem, .flexibleSpace] }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard id == Self.addressItem else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        item.view = addressBar
        item.label = "Address"
        return item
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
    private func js(_ call: String) { AIUICef.evalJS("window.aiui && aiui.\(call)") }
    @objc func reloadScene(_ sender: Any?) { js("reloadScene()") }
    @objc func findInScene(_ sender: Any?) { js("find()") }
    @objc func goBack(_ sender: Any?) { js("back()") }
    @objc func goForward(_ sender: Any?) { js("forward()") }
    @objc func zoomIn(_ sender: Any?) { js("zoom(1)") }
    @objc func zoomOut(_ sender: Any?) { js("zoom(-1)") }
    @objc func zoomReset(_ sender: Any?) { js("zoom(0)") }
    @objc func printScene(_ sender: Any?) { js("print()") }

    @objc func showSystem(_ sender: Any?) { AIUICef.evalJS("window.aiui && aiui.system()") }
    @objc func showNetwork(_ sender: Any?) { AIUICef.evalJS("window.aiui && aiui.network()") }
    @objc func showActivity(_ sender: Any?) { AIUICef.evalJS("window.aiui && aiui.activityScreen()") }
    @objc func showJSLibraries(_ sender: Any?) { AIUICef.evalJS("window.aiui && aiui.jsLibraries()") }

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
        appMenu.addItem(withTitle: "Settings…", action: #selector(showSystem(_:)), keyEquivalent: ",").target = self
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
        view.addItem(withTitle: "Connect to Network…", action: #selector(showNetwork(_:)), keyEquivalent: "n").target = self
        view.addItem(withTitle: "Activity", action: #selector(showActivity(_:)), keyEquivalent: "i").target = self
        let newSession = view.addItem(withTitle: "New Session", action: #selector(newSession(_:)), keyEquivalent: "n")
        newSession.keyEquivalentModifierMask = [.command, .shift]
        newSession.target = self
        view.addItem(withTitle: "AI Provider…", action: #selector(chooseAI(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "What AI UI Knows About You…", action: #selector(showProfile(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "Utility Library…", action: #selector(showLibrary(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "Installed JS Libraries…", action: #selector(showJSLibraries(_:)), keyEquivalent: "").target = self
        let sys = view.addItem(withTitle: "Settings & System", action: #selector(showSystem(_:)), keyEquivalent: "d")
        sys.keyEquivalentModifierMask = [.command, .shift]
        sys.target = self
        view.addItem(withTitle: "Clear Memory Cache", action: #selector(clearCache(_:)), keyEquivalent: "").target = self
        view.addItem(withTitle: "Reload Scene", action: #selector(reloadScene(_:)), keyEquivalent: "r").target = self
        let reloadApp = view.addItem(withTitle: "Reload App", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reloadApp.keyEquivalentModifierMask = [.command, .shift]
        reloadApp.target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Find…", action: #selector(findInScene(_:)), keyEquivalent: "f").target = self
        view.addItem(withTitle: "Back", action: #selector(goBack(_:)), keyEquivalent: "[").target = self
        view.addItem(withTitle: "Forward", action: #selector(goForward(_:)), keyEquivalent: "]").target = self
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "=").target = self
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-").target = self
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset(_:)), keyEquivalent: "0").target = self
        view.addItem(withTitle: "Print…", action: #selector(printScene(_:)), keyEquivalent: "p").target = self
        view.addItem(.separator())
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
