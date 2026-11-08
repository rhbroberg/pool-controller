import Foundation
@testable import PoolStatus

/// Answers requests for registered hosts from inside the process, so tests exercise the real
/// client code without a server. It only sees requests made through `session`, and each test
/// uses its own host, so tests can run side by side.
nonisolated final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    enum Reply: Sendable {
        case json(Int, String)
        case fail(URLError.Code)

        static func ok(_ body: String) -> Reply { .json(200, body) }
        static func status(_ code: Int, message: String = "stubbed") -> Reply {
            .json(code, #"{"code":\#(code),"message":"\#(message)"}"#)
        }
    }

    typealias Handler = @Sendable (_ method: String, _ path: String, _ query: [String: String]) -> Reply

    /// A session whose requests this protocol answers.
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }()

    private static let handlers = Shared([String: Handler]())
    private static let received = Shared([String: [String]]())

    static func register(host: String, handler: @escaping Handler) {
        handlers.value[host] = handler
        received.value[host] = []
    }

    /// "METHOD path" for each request the host received, oldest first.
    static func requests(to host: String) -> [String] {
        received.value[host] ?? []
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url, let host = url.host(), let handler = Self.handlers.value[host] else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let method = request.httpMethod ?? "GET"
        let path = url.path().replacingOccurrences(of: "/\(StatusClient.apiPath)/", with: "")
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .reduce(into: [String: String]()) { $0[$1.name] = $1.value ?? "" } ?? [:]
        Self.received.modify { $0[host, default: []].append("\(method) \(path)") }

        switch handler(method, path, query) {
        case .fail(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .json(let status, let body):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

/// A pretend pool server at a host of its own.
struct StubServer {
    let host: String
    let port = 3000

    var address: String { "\(host):\(port)" }
    var session: URLSession { StubURLProtocol.session }
    var client: StatusClient { StatusClient(serverAddress: address, session: session) }

    init(_ handler: @escaping StubURLProtocol.Handler) {
        host = "pool-\(UUID().uuidString.prefix(8).lowercased()).local"
        StubURLProtocol.register(host: host, handler: handler)
    }

    var requests: [String] { StubURLProtocol.requests(to: host) }

    /// A store for this server that keeps its sign-in in memory and never waits between polls.
    func makeStore(credentials: InMemoryCredentialStore = InMemoryCredentialStore()) -> StatusStore {
        StatusStore(serverAddress: address, defaults: Self.defaults, session: session,
                    credentials: credentials, sleep: { _ in try Task.checkCancellation() })
    }

    private static let defaults = UserDefaults(suiteName: "PoolStatusTests")!
}

/// State a stub's handler can change between requests.
nonisolated final class Shared<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) {
        stored = value
    }

    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }

    func modify(_ change: (inout Value) -> Void) {
        lock.withLock { change(&stored) }
    }
}

/// JSON the server would send.
nonisolated enum Fixture {
    static let time = "2026-11-07T22:00:00.000Z"

    static func status(_ readings: [(name: String, category: String, value: Double)]) -> String {
        let entries = readings.map {
            #"{"name":"\#($0.name)","category":"\#($0.category)","value":\#($0.value),"timestamp":"\#(time)"}"#
        }
        return "[\(entries.joined(separator: ","))]"
    }

    static func switches(_ on: [String], off: [String] = []) -> [(name: String, category: String, value: Double)] {
        on.map { ($0, "status", 1) } + off.map { ($0, "status", 0) }
    }

    static func heating(target: String? = "pool", heaterHeating: Bool = true, heatPumpEnabled: Bool = false,
                        reachesController: Bool = true) -> String {
        let body = target.map { "\"\($0)\"" } ?? "null"
        let setpoint = target == "spa" ? 102 : 84
        return """
        {"units":"fahrenheit","target":\(body),"minimum":65,"maximum":104,
         "setpointsReachController":\(reachesController),
         "setpoints":{"pool":{"heater1":84,"heatpump":82},"spa":{"heater1":102,"heatpump":100}},
         "devices":{
           "heater1":{"enabled":true,"heating":\(heaterHeating),"callingForHeat":\(heaterHeating),
                      "body":\(body),"setpoint":\(target == nil ? "null" : String(setpoint)),"temperature":70},
           "heatpump":{"enabled":\(heatPumpEnabled),"heating":false,"callingForHeat":false,
                       "body":\(body),"setpoint":\(target == nil ? "null" : "82"),"temperature":70}}}
        """
    }

    static func login(_ name: String, role: String = "user", mustChange: Bool = false) -> String {
        #"{"email":"\#(name)","token":"token-\#(name)","role":"\#(role)","mustChangeCredentials":\#(mustChange)}"#
    }
}
