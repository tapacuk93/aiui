import SwiftUI

/// AI UI for iPhone and iPad: the same circles UI (web/) in a WebKit view, driven by the same
/// Swift core as the Mac app — memory, flows, utilities and profile in the shared iCloud
/// container, AI through AICoin or the user's own key.
@main
struct AIUIApp: App {
    @Environment(\.scenePhase) private var phase
    private let api: API

    init() {
        let local = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("aiui", isDirectory: true)
        api = API(support: Storage.root(local: local))
        let api = self.api
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in api.syncNow() }
    }

    var body: some Scene {
        WindowGroup {
            WebView(api: api)
                .ignoresSafeArea()
                .background(Color(uiColor: .systemBackground))
        }
        .onChange(of: phase) { _, now in
            if now == .active { api.syncNow() }
        }
    }
}
