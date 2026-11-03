import SwiftUI
import WebKit

/// The page: web/ served from the app bundle at aiui://app/, with `/api/*` answered by the
/// shared API through a WebKit message handler (window.webkit.messageHandlers.aiui).
struct WebView: UIViewRepresentable {
    let api: API

    func makeCoordinator() -> Coordinator { Coordinator(api: api) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator, forURLScheme: "aiui")
        config.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "aiui")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.scrollView.isScrollEnabled = false          // the page pages, it doesn't scroll
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsLinkPreview = false
        #if DEBUG
        web.isInspectable = true
        #endif
        web.navigationDelegate = context.coordinator
        context.coordinator.web = web
        API.evalJS = { [weak web] js in web?.evaluateJavaScript(js) }
        web.load(URLRequest(url: URL(string: "aiui://app/index.html")!))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKURLSchemeHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
        let api: API
        weak var web: WKWebView?
        private let root = Bundle.main.resourceURL!.appendingPathComponent("web")

        init(api: API) { self.api = api }

        // aiui://app/<file> → web/<file> in the bundle.
        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            var path = task.request.url?.path ?? "/"
            if path == "/" || path.isEmpty { path = "/index.html" }
            var file = root.appendingPathComponent(path).standardizedFileURL
            var base = root.standardizedFileURL.path
            if path.hasPrefix("/vendor/"), let v = api.libraries.filePath(String(path.dropFirst(8))) {
                file = v; base = api.libraries.dir.standardizedFileURL.path
            }
            guard file.path.hasPrefix(base + "/"), let data = try? Data(contentsOf: file) else {
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            let mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json",
                        "png": "image/png", "svg": "image/svg+xml"][file.pathExtension] ?? "application/octet-stream"
            let response = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": mime + "; charset=utf-8", "Cache-Control": "no-store"])!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        }

        func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

        // {name, body} from the page → API → {status, data} back to the page's promise.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            guard let msg = message.body as? [String: Any], let name = msg["name"] as? String else {
                return replyHandler(nil, "bad message")
            }
            let body = (try? JSONSerialization.data(withJSONObject: msg["body"] ?? [:])) ?? Data("{}".utf8)
            api.handleAPI(name, body: body) { status, _, data in
                let obj = (try? JSONSerialization.jsonObject(with: data)) ?? [:]
                DispatchQueue.main.async { replyHandler(["status": status, "data": obj], nil) }
            }
        }

        // Links leave the app (Safari / the app that owns them); the page itself stays.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = action.request.url, url.scheme != "aiui", url.scheme != "about" {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }
    }
}
