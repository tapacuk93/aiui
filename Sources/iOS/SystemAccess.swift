import UIKit

extension API {
    /// System access on iPhone/iPad: what iOS lets an app do for the page — open links and apps
    /// (by URL), the clipboard, a haptic nudge. No shell, files or other apps' data.
    static func sys(_ input: [String: Any], send: @escaping ([String: Any]) -> Void, fail: @escaping (String) -> Void) {
        let op = input["op"] as? String ?? ""
        DispatchQueue.main.async {
            switch op {
            case "open":
                guard let target = input["target"] as? String, let url = URL(string: target), url.scheme != nil else {
                    return fail("Only links can be opened on iPhone.")
                }
                UIApplication.shared.open(url) { ok in ok ? send(["ok": true]) : fail("Could not open \(target)") }
            case "clipboard":
                if let text = input["text"] as? String { UIPasteboard.general.string = text; send(["ok": true]) }
                else { send(["text": UIPasteboard.general.string ?? ""]) }
            case "notify":
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                send(["ok": true])
            default:
                fail("Not available on iPhone: \(op) needs the AI UI Mac app.")
            }
        }
    }
}
