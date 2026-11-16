import Foundation

/// Intercepts every URLSession request of the test process (registered by TestEnv). Tests add
/// routes; a request no route answers fails with "no route" (so nothing ever reaches the network).
final class MockURL: URLProtocol {
    struct Response {
        var status: Int = 200
        var body: Data = Data()
        var headers: [String: String] = [:]
        var error: Error?
        var delay: TimeInterval = 0
        static func json(_ obj: Any, status: Int = 200) -> Response {
            Response(status: status, body: (try? JSONSerialization.data(withJSONObject: obj)) ?? Data(), headers: ["Content-Type": "application/json"])
        }
        static func text(_ s: String, status: Int = 200) -> Response { Response(status: status, body: Data(s.utf8)) }
        static func fail(_ code: URLError.Code = .notConnectedToInternet) -> Response { Response(error: URLError(code)) }
    }
    /// A request as it was sent (body read from the stream when needed).
    struct Seen { var method: String; var url: URL; var headers: [String: String]; var body: Data }

    private static let lock = NSLock()
    private static var routes: [(match: (URLRequest) -> Bool, respond: (URLRequest) -> Response)] = []
    private static var _seen: [Seen] = []
    static var seen: [Seen] { lock.lock(); defer { lock.unlock() }; return _seen }

    static func reset() { lock.lock(); routes = []; _seen = []; lock.unlock() }

    /// Answers requests whose URL contains `fragment` (latest route added wins).
    static func on(_ fragment: String, method: String? = nil, _ respond: @escaping (URLRequest) -> Response) {
        lock.lock()
        routes.insert(({ r in r.url!.absoluteString.contains(fragment) && (method == nil || r.httpMethod == method) }, respond), at: 0)
        lock.unlock()
    }
    static func on(_ fragment: String, method: String? = nil, _ response: Response) { on(fragment, method: method) { _ in response } }

    static func body(of r: URLRequest) -> Data {
        if let b = r.httpBody { return b }
        guard let s = r.httpBodyStream else { return Data() }
        s.open(); defer { s.close() }
        var d = Data(); var buf = [UInt8](repeating: 0, count: 65536)
        while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
        return d
    }
    static func json(of r: URLRequest) -> [String: Any] { (try? JSONSerialization.jsonObject(with: body(of: r))) as? [String: Any] ?? [:] }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var req = request
        let body = Self.body(of: req)
        req.httpBody = body
        Self.lock.lock()
        Self._seen.append(Seen(method: req.httpMethod ?? "GET", url: req.url!, headers: req.allHTTPHeaderFields ?? [:], body: body))
        let route = Self.routes.first { $0.match(req) }
        Self.lock.unlock()
        let r = route?.respond(req) ?? Response(error: URLError(.cannotConnectToHost, userInfo: [NSLocalizedDescriptionKey: "no route for \(req.url!)"]))
        let deliver = { [self] in
            if let e = r.error { client?.urlProtocol(self, didFailWithError: e); return }
            let resp = HTTPURLResponse(url: req.url!, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers)!
            client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: r.body)
            client?.urlProtocolDidFinishLoading(self)
        }
        if r.delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + r.delay, execute: deliver) } else { deliver() }
    }
    override func stopLoading() {}
}
