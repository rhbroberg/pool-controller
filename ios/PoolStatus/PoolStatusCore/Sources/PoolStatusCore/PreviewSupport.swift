#if DEBUG
import Foundation

/// Keeps a sign-in in memory instead of in the keychain, for previews and tests.
public final class InMemoryCredentialStore: CredentialStore {
    public private(set) var saved: Credentials?

    public init(_ saved: Credentials? = nil) {
        self.saved = saved
    }

    public func load() -> Credentials? { saved }
    public func save(_ credentials: Credentials) { saved = credentials }
    public func delete() { saved = nil }
}

extension StatusStore {
    /// A store whose server answers from canned data, so previews show a working dashboard.
    public static func preview(role: AccountRole? = .user) -> StatusStore {
        StatusStore(serverAddress: "preview.local:3000",
                    defaults: UserDefaults(suiteName: "PoolStatusPreviews") ?? .standard,
                    session: PreviewURLProtocol.session,
                    credentials: InMemoryCredentialStore(role.map { Credentials(name: "preview", token: "preview", role: $0) }))
    }
}

/// Answers the API's GET routes with plausible readings for an evening with the filter running
/// and the heater warming the pool.
private nonisolated final class PreviewURLProtocol: URLProtocol, @unchecked Sendable {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewURLProtocol.self]
        return URLSession(configuration: configuration)
    }()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else {
            return
        }
        let path = url.path().replacingOccurrences(of: "/\(StatusClient.apiPath)/", with: "")
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let body = request.httpMethod == "GET" ? Self.body(for: path, query: query) : #"{"message":"ok"}"#
        let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? #"{"message":"not in the preview"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private static func body(for path: String, query: [URLQueryItem]) -> String? {
        let now = iso.format(.now)
        switch path {
        case "status":
            let readings: [(String, String, Double)] = [
                ("filter", "status", 1), ("pool", "status", 1), ("spa", "status", 0), ("spillover", "status", 0),
                ("aux14", "status", 0), ("heater1", "status", 1), ("heater1 mode", "status", 1),
                ("valve4", "status", 0), ("lights", "status", 1), ("aux3", "status", 0), ("aux5", "status", 0),
                ("superchlorinate", "status", 0), ("check system", "status", 0),
                ("pool temp", "info", 81), ("spa temp", "info", 97), ("ambient", "info", 64), ("salt", "info", 3200)
            ]
            let entries = readings.map { #"{"name":"\#($0.0)","category":"\#($0.1)","value":\#($0.2),"timestamp":"\#(now)"}"# }
            return "[\(entries.joined(separator: ","))]"
        case "heating":
            return """
            {"target":"pool","minimum":65,"maximum":104,"setpointsReachController":true,
             "setpoints":{"pool":{"heater1":84,"heatpump":82},"spa":{"heater1":102,"heatpump":100}},
             "devices":{"heater1":{"enabled":true,"heating":true,"callingForHeat":true,"body":"pool","setpoint":84,"temperature":81},
                        "heatpump":{"enabled":false,"heating":false,"callingForHeat":false,"body":"pool","setpoint":82,"temperature":81}}}
            """
        case "panel/display":
            return #"{"lines":["  Pool Temp  81°F   ","  Heater1 Auto Ctrl "],"blinking":[[],[]],"timestamp":"\#(now)"}"#
        case "events/users":
            return #"["preview"]"#
        case "events":
            let events = [("1", "action", "preview", "Turned the lights on"),
                          ("2", "status", nil, "Heater1 on"),
                          ("3", "status", nil, "Filter on")]
            let entries = events.enumerated().map { index, event in
                let time = iso.format(.now.addingTimeInterval(Double(-index) * 600))
                let user = event.2.map { "\"\($0)\"" } ?? "null"
                return #"{"id":"\#(event.0)","timestamp":"\#(time)","type":"\#(event.1)","user":\#(user),"summary":"\#(event.3)"}"#
            }
            return #"{"events":[\#(entries.joined(separator: ","))],"next":null}"#
        case "history":
            return history(query)
        case "history/availability":
            // every day of the last two months but a few
            let calendar = Calendar.current
            let days = (0..<60).filter { $0 % 9 != 4 }.compactMap { offset -> String? in
                guard let day = calendar.date(byAdding: .day, value: -offset, to: .now) else {
                    return nil
                }
                let parts = calendar.dateComponents([.year, .month, .day], from: day)
                return String(format: #"{"date":"%04d-%02d-%02d","readings":40}"#, parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
            }
            return #"{"timeZone":"\#(TimeZone.current.identifier)","earliest":null,"days":[\#(days.joined(separator: ","))]}"#
        case "system/settings":
            return #"{"timeZone":"\#(TimeZone.current.identifier)","timeZoneSource":"system","detectedTimeZone":"\#(TimeZone.current.identifier)","rawRetentionDays":365,"minimumRetentionDays":7,"maximumRetentionDays":3650}"#
        case "system/jobs":
            let finished = iso.format(.now.addingTimeInterval(-240))
            return """
            [{"name":"rollups","description":"summarizes history","intervalSeconds":300,"scheduled":true,"running":false,"nextRunAt":null,
              "lastStartedAt":"\(finished)","lastFinishedAt":"\(finished)","lastDurationMs":412,"lastResult":"ok","lastError":null,
              "lastSummary":"rolled up 1 hours and 0 days","runs":12},
             {"name":"retention","description":"removes old raw history","intervalSeconds":21600,"scheduled":true,"running":false,"nextRunAt":null,
              "lastStartedAt":"\(finished)","lastFinishedAt":"\(finished)","lastDurationMs":38,"lastResult":"ok","lastError":null,
              "lastSummary":"removed 0 events","runs":2}]
            """
        default:
            return nil
        }
    }

    /// Smooth made-up series across the window asked for.
    private static func history(_ query: [URLQueryItem]) -> String? {
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        guard let names = value("names")?.split(separator: ","), let fromText = value("from"), let toText = value("to"),
              let from = try? iso.parse(fromText), let to = try? iso.parse(toText) else {
            return nil
        }
        let step = max(3600, to.timeIntervalSince(from) / 200)
        let times = stride(from: from.timeIntervalSinceReferenceDate, through: to.timeIntervalSinceReferenceDate, by: step)
            .map { Date(timeIntervalSinceReferenceDate: $0) }
        let series = names.map { name -> String in
            let points = times.compactMap { time -> String? in
                let hour = Calendar.current.component(.hour, from: time)
                let wave = sin(Double(hour) / 24 * 2 * .pi)
                let v: Double? = switch name {
                case "pool temp": 80 + 2 * wave
                case "spa temp": 98 + wave
                case "ambient": 62 + 8 * wave
                case "salt": 3200 + 50 * wave
                case "filter": (8..<20).contains(hour) ? 1 : 0
                case "heater1", "heating:pool:heater1": (17..<20).contains(hour) ? 1 : 0
                case "heating:pool:valve4": (12..<15).contains(hour) ? 1 : 0
                case "aux14": (19..<21).contains(hour) ? 1 : 0
                default: nil
                }
                return v.map { #"{"t":"\#(iso.format(time))","v":\#($0)}"# }
            }
            return #"{"name":"\#(name)","before":null,"points":[\#(points.joined(separator: ","))]}"#
        }
        return #"{"from":"\#(fromText)","to":"\#(toText)","earliest":"\#(fromText)","series":[\#(series.joined(separator: ","))]}"#
    }
}
#endif
