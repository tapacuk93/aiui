import Cocoa
import XCTest
@testable import AIUI

/// Collects what the Swift side asked the (stubbed) CEF bridge to do.
final class CefCalls {
    private(set) var all: [String] = []
    private var token: NSObjectProtocol?
    init() {
        token = NotificationCenter.default.addObserver(forName: Notification.Name("AIUICefStub"), object: nil, queue: nil) { [weak self] n in
            self?.all.append(n.object as? String ?? "")
        }
    }
    deinit { token.map(NotificationCenter.default.removeObserver) }
    var js: [String] { all.filter { $0.hasPrefix("js ") }.map { String($0.dropFirst(3)) } }
}

/// A window that says it is visible without ever being on screen, and records full-screen toggles.
final class FakeVisibleWindow: NSWindow {
    var toggles = 0
    var fullScreen = false
    override var isVisible: Bool { true }
    override var styleMask: NSWindow.StyleMask {
        get { fullScreen ? [.titled, .fullScreen] : [.titled] }
        set {}
    }
    override func toggleFullScreen(_ sender: Any?) { toggles += 1; fullScreen.toggle() }
}

class MacUITestCase: AIUITestCase {
    var cef: CefCalls!
    var presented: [NSWindow] = []
    var installed: [NSMenu] = []
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
        cef = CefCalls()
        // Never on screen, never a Dock icon: windows and menus are only recorded.
        AppDelegate.present = { [unowned self] in self.presented.append($0) }
        AppDelegate.install = { [unowned self] in self.installed.append($0) }
    }
    override func tearDown() {
        API.evalJS = { _ in }
        API.setFullScreen = nil
        API.setAddress = nil
        API.webRoot = nil
        NSApp.delegate = nil
        unsetenv("AIUI_CEF_STUB_FAIL")
        cef = nil
        super.tearDown()
    }
    func makeDelegate() -> AppDelegate { AppDelegate(support: TestEnv.tempDir("support"), device: TestEnv.tempDir("device")) }
    func click(_ v: NSView) {
        let e = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
                                   context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        v.mouseDown(with: e)
    }
}

final class AddressBarTests: MacUITestCase {
    private func labels(_ bar: AddressBar) -> [NSTextField] {
        (bar.subviews.first as? NSStackView)?.arrangedSubviews.compactMap { $0 as? NSTextField } ?? []
    }

    func testStartsWithTheAppName() {
        let bar = AddressBar(frame: .zero)
        XCTAssertEqual(labels(bar).map(\.stringValue), ["AI UI"])
        XCTAssertEqual(labels(bar).first?.textColor, .labelColor)
        XCTAssertTrue(bar.wantsLayer)
        XCTAssertEqual(bar.layer?.cornerRadius, 7)
    }

    func testPathWithSeparatorsAndClickableLevels() {
        let bar = AddressBar(frame: .zero)
        var selected: [Int] = []
        bar.onSelect = { selected.append($0) }
        bar.set(["AI UI", "Play", "Games"])
        let ls = labels(bar)
        XCTAssertEqual(ls.map(\.stringValue), ["AI UI", "›", "Play", "›", "Games"])
        XCTAssertEqual(ls[0].textColor, .secondaryLabelColor)
        XCTAssertEqual(ls[4].textColor, .labelColor, "the current place reads like a title")
        XCTAssertEqual(ls[2].toolTip, "Play")
        XCTAssertTrue(ls[2] is ClickLabel)
        click(ls[2]); click(ls[4]); click(ls[0])
        XCTAssertEqual(selected, [1, 2, 0])
        XCTAssertFalse(ls[1] is ClickLabel, "separators are not clickable")
    }

    func testOtherPathsSwitchAndClose() {
        let bar = AddressBar(frame: .zero)
        var switched: [Int] = [], closed: [Int] = []
        bar.onSwitch = { switched.append($0) }
        bar.onClose = { closed.append($0) }
        bar.set(["Home"], others: [("Mail", "AI UI › Mail"), ("Notes", "AI UI › Notes")])
        let ls = labels(bar)
        XCTAssertEqual(ls.map(\.stringValue), ["Home", "  ·  ", "Mail", "×", "  ·  ", "Notes", "×"])
        XCTAssertEqual(ls[2].toolTip, "AI UI › Mail")
        XCTAssertEqual(ls[3].accessibilityLabel(), "Close Mail")
        click(ls[5]); click(ls[2]); click(ls[6]); click(ls[3])
        XCTAssertEqual(switched, [1, 0])
        XCTAssertEqual(closed, [1, 0])
        // Setting again replaces everything.
        bar.set(["A"])
        XCTAssertEqual(labels(bar).map(\.stringValue), ["A"])
    }

    func testClicksWithoutHandlersDoNothing() {
        let bar = AddressBar(frame: .zero)
        bar.set(["A"], others: [("B", "B")])
        labels(bar).forEach { click($0) }   // no handler set: no crash
        let plain = ClickLabel(labelWithString: "x")
        click(plain)
    }

    func testLayerIsPlainAndLabelsShowAPointingHand() {
        let bar = AddressBar(frame: NSRect(x: 0, y: 0, width: 200, height: 22))
        bar.layer?.backgroundColor = NSColor.red.cgColor
        bar.updateLayer()
        XCTAssertEqual(bar.layer?.backgroundColor, NSColor.clear.cgColor)
        let label = ClickLabel(labelWithString: "x")
        label.resetCursorRects()   // no window: adds nothing, must not crash
    }

    func testNotLoadedFromNibs() {
        XCTAssertNil(AddressBar(coder: NSCoder()))
    }
}

final class AppDelegateTests: MacUITestCase {
    func testOpenWindowBuildsTheWindowAndTheBrowser() throws {
        let d = makeDelegate()
        d.openWindow()
        let w = try XCTUnwrap(d.window)
        XCTAssertEqual(presented.count, 1)
        XCTAssertTrue(presented.first === w)
        XCTAssertEqual(w.title, "AI UI")
        XCTAssertEqual(w.titleVisibility, .hidden)
        XCTAssertTrue(w.titlebarAppearsTransparent)
        XCTAssertEqual(w.minSize, NSSize(width: 520, height: 420))
        XCTAssertFalse(w.isReleasedWhenClosed)
        XCTAssertTrue(w.delegate === d)
        XCTAssertLessThanOrEqual(w.frame.width, 1180)
        XCTAssertEqual(cef.all.last, "browser aiui://app/index.html")
        // The address bar sits in the title bar, and the page can set it.
        let zoom = try XCTUnwrap(w.standardWindowButton(.zoomButton))
        let bar = try XCTUnwrap(zoom.superview?.subviews.compactMap { $0 as? AddressBar }.first)
        API.setAddress?(["AI UI", "Mail"], [("Notes", "AI UI › Notes")])
        let stack = try XCTUnwrap(bar.subviews.first as? NSStackView)
        XCTAssertEqual(stack.arrangedSubviews.compactMap { ($0 as? NSTextField)?.stringValue }, ["AI UI", "›", "Mail", "  ·  ", "Notes", "×"])
        // Its clicks become page calls.
        let labels = stack.arrangedSubviews.compactMap { $0 as? ClickLabel }
        click(labels[1]); click(labels[2]); click(labels[3])
        XCTAssertEqual(cef.js, ["window.aiui && aiui.menuUsed && aiui.menuUsed(), window.aiui && aiui.goTo(1)",
                                "window.aiui && aiui.switchPath(0)", "window.aiui && aiui.closePath(0)"])
        // The background follows the appearance.
        for (name, red) in [(NSAppearance.Name.darkAqua, 11.0), (.aqua, 245.0)] {
            NSAppearance(named: name)!.performAsCurrentDrawingAppearance {
                let rgb = w.backgroundColor.usingColorSpace(.sRGB)!
                XCTAssertEqual(rgb.redComponent * 255, red, accuracy: 0.5)
            }
        }
        // setAddress after the delegate is gone does nothing.
        w.delegate = nil
        w.close()
    }

    func testSetAddressHookIsWeak() {
        var d: AppDelegate? = makeDelegate()
        d!.openWindow()
        d!.window?.close()
        d = nil
        API.setAddress?(["x"], [])   // must not crash
    }

    func testLaunchInstallsTheMenuAndSyncs() throws {
        let d = makeDelegate()
        d.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        XCTAssertEqual(installed.count, 1)
        let m = try XCTUnwrap(installed.first)
        XCTAssertEqual(m.items.compactMap { $0.submenu?.title }, ["", "Edit", "View", "Window"])
        XCTAssertTrue(NSApp.windowsMenu === m.items[3].submenu)
        d.applicationDidBecomeActive(Notification(name: NSApplication.didBecomeActiveNotification))
    }

    func testEveryMenuCommandReachesThePage() throws {
        let d = makeDelegate()
        let menu = d.makeMenu()
        let view = try XCTUnwrap(menu.items[2].submenu)
        var fired: [String] = []
        for item in view.items + (menu.items[0].submenu?.items ?? []) where item.target === d {
            let before = cef.all.count
            _ = d.perform(item.action!, with: item)
            fired.append(item.title)
            if !["Clear Memory Cache"].contains(item.title) {
                XCTAssertGreaterThan(cef.all.count, before, "\(item.title) did nothing")
            }
        }
        XCTAssertTrue(fired.contains("Settings & System"))
        XCTAssertEqual(fired.count, 22)
        let js = cef.js
        for call in ["aiui.system()", "aiui.network()", "aiui.actions()", "aiui.activityScreen()", "aiui.jsLibraries()",
                     "aiui.nativeLibraries()", "aiui.library()", "aiui.profile()", "aiui.setup()", "aiui.home()",
                     "aiui.reloadScene()", "aiui.find()", "aiui.back()", "aiui.forward()", "aiui.zoom(1)", "aiui.zoom(-1)",
                     "aiui.zoom(0)", "aiui.print()"] {
            XCTAssertTrue(js.contains("window.aiui && aiui.menuUsed && aiui.menuUsed(), window.aiui && \(call)"), call)
        }
        XCTAssertTrue(cef.all.contains("devtools"))
        XCTAssertTrue(cef.all.contains("reload"))
        let newSession = try XCTUnwrap(view.items.first { $0.title == "New Session" })
        XCTAssertEqual(newSession.keyEquivalentModifierMask, [.command, .shift])
    }

    func testClearCacheEmptiesTheMemory() {
        let d = makeDelegate()
        let action: [String: Any] = ["event": "open", "language": "en"]
        let key = Cache.key(for: action)
        d.api.cache.store(key: key, action: action, flow: [], outcome: ["kind": "circles", "title": "x"])
        XCTAssertNotNil(d.api.cache.raw(key))
        d.clearCache(nil)
        XCTAssertNil(d.api.cache.raw(key))
    }

    func testClosingAsksCEFFirst() {
        let d = makeDelegate()
        let w = NSWindow()
        XCTAssertFalse(d.windowShouldClose(w))
        XCTAssertEqual(d.applicationShouldTerminate(NSApplication.shared), .terminateCancel)
        XCTAssertEqual(cef.all, ["close", "close"])
    }

    func testToolbarOffersTheAddress() {
        let d = makeDelegate()
        let tb = NSToolbar(identifier: "t")
        let address = NSToolbarItem.Identifier("aiui.address")
        XCTAssertEqual(d.toolbarAllowedItemIdentifiers(tb), [address, .flexibleSpace])
        XCTAssertEqual(d.toolbarDefaultItemIdentifiers(tb), [address, .flexibleSpace])
        let item = d.toolbar(tb, itemForItemIdentifier: address, willBeInsertedIntoToolbar: true)
        XCTAssertEqual(item?.label, "Address")
        XCTAssertTrue(item?.view is AddressBar)
        XCTAssertNil(d.toolbar(tb, itemForItemIdentifier: .flexibleSpace, willBeInsertedIntoToolbar: true))
    }

}

final class AppMainTests: MacUITestCase {
    func testLaunchRunAndQuit() throws {
        let support = TestEnv.tempDir("main").appendingPathComponent("aiui")
        let resources = TestEnv.tempDir("res")
        let defaults = UserDefaults(suiteName: "aiui.tests.main")!
        defaults.removePersistentDomain(forName: "aiui.tests.main")
        var stopped = false
        let code = AppMain.run(support: support, environment: [:], resources: resources, defaults: defaults, legacy: nil,
                               stop: { stopped = true })
        XCTAssertEqual(code, 0)
        XCTAssertTrue(stopped)
        XCTAssertTrue(FileManager.default.fileExists(atPath: support.path))
        XCTAssertEqual(API.webRoot?.path, resources.appendingPathComponent("web").path)
        let d = try XCTUnwrap(NSApp.delegate as? AppDelegate)
        XCTAssertEqual(d.api.libraries.dir.path, support.appendingPathComponent("vendor").path, "device data under the support folder")
        XCTAssertNotNil(d.window, "onReady opened the window")
        XCTAssertEqual(cef.all.first, "vendor " + d.api.libraries.dir.path)
        XCTAssertEqual(cef.all.filter { !$0.hasPrefix("js ") }.suffix(3), ["browser aiui://app/index.html", "loop", "shutdown"])
        XCTAssertTrue(cef.all.contains("start \(resources.appendingPathComponent("web").path) \(support.appendingPathComponent("cef").path)"))
        // The hooks it installed reach CEF and the windows.
        API.evalJS("1+1")
        XCTAssertEqual(cef.js.last, "1+1")
        API.setFullScreen?(true)   // no visible window in tests: nothing happens
        d.window?.close()
    }

    func testFailedCEFStartExitsWithOne() {
        setenv("AIUI_CEF_STUB_FAIL", "1", 1)
        var stopped = false
        let code = AppMain.run(support: TestEnv.tempDir("fail"), environment: ["AIUI_WEB": "/tmp/web"], resources: nil,
                               defaults: UserDefaults(suiteName: "aiui.tests.main2")!, legacy: nil, stop: { stopped = true })
        XCTAssertEqual(code, 1)
        XCTAssertFalse(stopped)
        XCTAssertEqual(API.webRoot?.path, "/tmp/web")
        XCTAssertFalse(cef.all.contains("loop"))
    }

    func testEngineSettingMigratesOnce() {
        let old = UserDefaults(suiteName: "aiui.tests.old")!, new = UserDefaults(suiteName: "aiui.tests.new")!
        old.set("codex", forKey: "engine")
        new.removeObject(forKey: "engine")
        AppMain.migrateEngine(from: old, to: new)
        XCTAssertEqual(new.string(forKey: "engine"), "codex")
        old.set("gemini", forKey: "engine")
        AppMain.migrateEngine(from: old, to: new)
        XCTAssertEqual(new.string(forKey: "engine"), "codex", "an existing choice wins")
        new.removeObject(forKey: "engine")
        AppMain.migrateEngine(from: nil, to: new)
        XCTAssertNil(new.string(forKey: "engine"))
        old.removePersistentDomain(forName: "aiui.tests.old"); new.removePersistentDomain(forName: "aiui.tests.new")
    }

    func testFullScreenTogglesOnlyWhenNeeded() {
        XCTAssertEqual(AppMain.support.lastPathComponent, "aiui")
        AppMain.setFullScreen(true, windows: [])   // no window: nothing
        let w = FakeVisibleWindow()
        AppMain.setFullScreen(true, windows: [w])
        XCTAssertEqual(w.toggles, 1)
        AppMain.setFullScreen(true, windows: [w])
        XCTAssertEqual(w.toggles, 1, "already full screen")
        AppMain.setFullScreen(false, windows: [w])
        XCTAssertEqual(w.toggles, 2)
    }
}
