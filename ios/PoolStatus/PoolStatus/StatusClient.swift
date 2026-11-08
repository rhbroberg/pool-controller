import Foundation

enum StatusClientError: LocalizedError {
    case invalidAddress(String)
    case badResponse
    case unauthorized(message: String?)
    case server(code: Int, message: String?)

    var errorDescription: String? {
        switch self {
        case .invalidAddress(let address): "“\(address)” is not a valid server address."
        case .badResponse: "The server sent a response that isn’t HTTP."
        case .unauthorized(let message): message?.capitalizingFirstLetter ?? "Sign in to control equipment."
        case .server(let code, let message): message?.capitalizingFirstLetter ?? "The server returned HTTP \(code)."
        }
    }
}

extension Error {
    /// The request was cancelled, as when the view that asked went away; not worth reporting.
    var isCancellation: Bool {
        self is CancellationError || (self as? URLError)?.code == .cancelled
    }
}

/// How a server identifies itself; only a pool controller server says `poolService`.
struct SystemInfo: Decodable {
    static let poolService = "pool-controller"

    let service: String
    let version: String
    let startedAt: Date
}

/// The pool server's REST API.
struct StatusClient {
    /// The server mounts every route under the Swagger `basePath`.
    static let apiPath = "rhbroberg/pool-api/1.0.0"
    nonisolated static let defaultTimeout: TimeInterval = 10

    /// Reads the server's ISO 8601 dates, with or without fractional seconds.
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) {
                return date
            }
            return try Date.ISO8601FormatStyle().parse(text)
        }
        return decoder
    }()

    let serverAddress: String
    let session: URLSession

    init(serverAddress: String, session: URLSession = .shared) {
        self.serverAddress = serverAddress
        self.session = session
    }

    // MARK: Status

    func fetchStatus() async throws -> [StatusReading] {
        try await send(.get, "status")
    }

    /// Answers without the database or the pool controller, so it works whenever the server is up.
    func fetchSystemInfo(timeout: TimeInterval) async throws -> SystemInfo {
        try await send(.get, "system/info", timeout: timeout)
    }

    func fetchHeating() async throws -> HeatingStatus {
        try await send(.get, "heating")
    }

    func fetchPanelDisplay() async throws -> PanelDisplay {
        try await send(.get, "panel/display")
    }

    /// Readings for each name from `from` up to `to`, plus each one's value as the window opens.
    func fetchHistory(names: [ReadingName], from: Date, to: Date) async throws -> HistoryResponse {
        let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return try await send(.get, "history", query: [
            URLQueryItem(name: "names", value: names.map(\.rawValue).joined(separator: ",")),
            URLQueryItem(name: "from", value: iso.format(from)),
            URLQueryItem(name: "to", value: iso.format(to))
        ])
    }

    /// One page of the event log; pass the previous page's `next` as `cursor` for the following one.
    func fetchEvents(types: [String], user: String?, cursor: String?, ascending: Bool, limit: Int) async throws -> EventPage {
        var query = [
            URLQueryItem(name: "types", value: types.joined(separator: ",")),
            URLQueryItem(name: "order", value: ascending ? "asc" : "desc"),
            URLQueryItem(name: "limit", value: String(limit))
        ]
        if let user {
            query.append(URLQueryItem(name: "user", value: user))
        }
        if let cursor {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        return try await send(.get, "events", query: query)
    }

    /// Every account with a recorded action.
    func fetchEventUsers() async throws -> [String] {
        try await send(.get, "events/users")
    }

    // MARK: Control

    /// Asks the server to press the device's button if it isn't already in `on` state.
    /// The controller confirms the change on a later status frame.
    func setDevice(_ name: ReadingName, on: Bool, token: String) async throws {
        try await perform(.put, "devices/\(Self.pathComponent(name.rawValue))/\(on)", token: token)
    }

    /// Asks the server to step the water flow to `mode`; it presses the spillover key until the
    /// controller reports that mode.
    func setWaterMode(_ mode: WaterMode, token: String) async throws {
        try await perform(.put, "water/mode/\(mode.rawValue)", token: token)
    }

    /// Sets the temperature `device` drives `body` toward.
    func setSetpoint(_ degrees: Int, device: HeatingDevice, body: WaterBody, token: String) async throws {
        try await perform(.put, "heating/setpoints/\(body.rawValue)/\(device.rawValue)/\(degrees)", token: token)
    }

    /// Queues one press of a panel key; the server sends it on the next controller ping.
    func pressPanelKey(_ key: PanelKey, token: String) async throws {
        try await perform(.put, "panel/keys/\(key.rawValue)", token: token)
    }

    // MARK: Signing in

    func signIn(name: String, password: String) async throws -> SignInResult {
        try await send(.post, "users/login", body: CredentialsBody(email: name, password: password))
    }

    /// Renames the signed-in account and sets its password; returns a new token, since the
    /// old one stops working.
    func changeCredentials(name: String, password: String, token: String) async throws -> SignInResult {
        try await send(.put, "users/me/credentials", token: token, body: CredentialsBody(email: name, password: password))
    }

    /// The signed-in account and its current role.
    func fetchAccount(token: String) async throws -> AccountInfo {
        try await send(.get, "users/me", token: token)
    }

    /// Ends this token's session on the server.
    func signOut(token: String) async throws {
        try await perform(.delete, "users/me/token", token: token)
    }

    // MARK: Administration

    func listAccounts(token: String) async throws -> [AccountInfo] {
        try await send(.get, "users", token: token)
    }

    func createAccount(name: String, password: String, role: AccountRole, token: String) async throws -> AccountInfo {
        try await send(.post, "users", token: token, body: NewAccountBody(email: name, password: password, role: role))
    }

    /// Changes another account's role, resets its password, or both.
    func updateAccount(_ name: String, role: AccountRole? = nil, password: String? = nil, token: String) async throws -> AccountInfo {
        try await send(.put, "users/\(Self.pathComponent(name))", token: token,
                       body: AccountChanges(role: role, password: password))
    }

    func deleteAccount(_ name: String, token: String) async throws {
        try await perform(.delete, "users/\(Self.pathComponent(name))", token: token)
    }

    /// Erases the server's history and accounts; returns the server's description of the result.
    func factoryReset(token: String) async throws -> String {
        let data = try await fetchData(.post, "system/factory-reset", token: token)
        return (try? JSONDecoder().decode(ServerMessage.self, from: data))?.message ?? "Factory reset complete."
    }

    /// Asks the server to exit; its container restart policy starts it again.
    func restartServer(token: String) async throws {
        try await perform(.post, "system/restart", token: token)
    }

    // MARK: Requests

    func url(for path: String, query: [URLQueryItem]? = nil) throws -> URL {
        var base = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        if !base.contains("://") {
            base = "\(Self.defaultScheme(for: base))://\(base)"
        }
        while base.hasSuffix("/") {
            base.removeLast()
        }
        guard var components = URLComponents(string: "\(base)/\(Self.apiPath)/\(path)"),
              components.host?.isEmpty == false else {
            throw StatusClientError.invalidAddress(serverAddress)
        }
        components.queryItems = query
        guard let url = components.url else {
            throw StatusClientError.invalidAddress(serverAddress)
        }
        return url
    }

    /// App Transport Security allows plain http only on the local network, so an address typed
    /// without a scheme gets https unless it's an IP address, a `.local` name or unqualified.
    static func defaultScheme(for address: String) -> String {
        let host = address.prefix { $0 != "/" && $0 != ":" }.lowercased()
        let isLocal = IPv4Network.parse(host) != nil || host.hasSuffix(".local") || !host.contains(".")
        return isLocal ? "http" : "https"
    }

    private enum Method: String {
        case get = "GET", post = "POST", put = "PUT", delete = "DELETE"
    }

    private func send<Response: Decodable>(_ method: Method, _ path: String, query: [URLQueryItem]? = nil,
                                           token: String? = nil, body: (any Encodable)? = nil,
                                           timeout: TimeInterval = defaultTimeout) async throws -> Response {
        let data = try await fetchData(method, path, query: query, token: token, body: body, timeout: timeout)
        return try Self.decoder.decode(Response.self, from: data)
    }

    /// For requests whose answer only matters for its status.
    private func perform(_ method: Method, _ path: String, token: String? = nil) async throws {
        _ = try await fetchData(method, path, token: token)
    }

    private func fetchData(_ method: Method, _ path: String, query: [URLQueryItem]? = nil, token: String? = nil,
                      body: (any Encodable)? = nil, timeout: TimeInterval = defaultTimeout) async throws -> Data {
        var request = URLRequest(url: try url(for: path, query: query))
        request.httpMethod = method.rawValue
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // the server's validator rejects any request without a JSON content type, body or not
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue(token, forHTTPHeaderField: "x-auth")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw StatusClientError.badResponse
        }
        let message = (try? JSONDecoder().decode(ServerMessage.self, from: data))?.message
        switch http.statusCode {
        case 200..<300:
            return data
        case 401:
            throw StatusClientError.unauthorized(message: message)
        default:
            throw StatusClientError.server(code: http.statusCode, message: message)
        }
    }

    /// One path segment, with any `/` in it escaped.
    private static func pathComponent(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private struct ServerMessage: Decodable {
        let message: String
    }

    /// The server calls an account's name its email.
    private struct CredentialsBody: Encodable {
        let email: String
        let password: String
    }

    private struct NewAccountBody: Encodable {
        let email: String
        let password: String
        let role: AccountRole
    }

    /// Only the fields being changed are sent.
    private struct AccountChanges: Encodable {
        let role: AccountRole?
        let password: String?
    }
}

private extension String {
    var capitalizingFirstLetter: String {
        prefix(1).uppercased() + dropFirst()
    }
}
