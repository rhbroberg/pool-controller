import Foundation

public nonisolated enum StatusClientError: LocalizedError {
    case invalidAddress(String)
    case badResponse
    case unauthorized(message: String?)
    case server(code: Int, message: String?)

    public var errorDescription: String? {
        switch self {
        case .invalidAddress(let address): String(localized: "“\(address)” is not a valid server address.", bundle: .module)
        case .badResponse: String(localized: "The server sent a response that isn’t HTTP.", bundle: .module)
        case .unauthorized(let message): message?.capitalizingFirstLetter ?? String(localized: "The server wants you to sign in.", bundle: .module)
        case .server(let code, let message): message?.capitalizingFirstLetter ?? String(localized: "The server returned HTTP \(code).", bundle: .module)
        }
    }
}

nonisolated extension Error {
    /// The request was cancelled, as when the view that asked went away; not worth reporting.
    public var isCancellation: Bool {
        self is CancellationError || (self as? URLError)?.code == .cancelled
    }
}

/// How a server identifies itself; only a pool controller server says `poolService`.
public nonisolated struct SystemInfo: Decodable, Sendable {
    public static let poolService = "pool-controller"

    public let service: String
    public let version: String
    public let startedAt: Date
}

/// The pool server's REST API. Requests, and decoding their answers, run off the main actor.
public nonisolated struct StatusClient: Sendable {
    /// The server mounts every route under the Swagger `basePath`.
    public static let apiPath = "rhbroberg/pool-api/1.0.0"
    public static let defaultTimeout: TimeInterval = 10

    /// Reads the server's ISO 8601 dates, with or without fractional seconds.
    public static let decoder: JSONDecoder = {
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

    public let serverAddress: String
    public let session: URLSession

    public init(serverAddress: String, session: URLSession = .shared) {
        self.serverAddress = serverAddress
        self.session = session
    }

    // MARK: Status

    public func fetchStatus() async throws -> [StatusReading] {
        try await send(.get, "status")
    }

    /// Answers without the database or the pool controller, so it works whenever the server is up.
    public func fetchSystemInfo(timeout: TimeInterval) async throws -> SystemInfo {
        try await send(.get, "system/info", timeout: timeout)
    }

    public func fetchHeating() async throws -> HeatingStatus {
        try await send(.get, "heating")
    }

    public func fetchPanelDisplay() async throws -> PanelDisplay {
        try await send(.get, "panel/display")
    }

    /// Readings for each name from `from` up to `to`, plus each one's value as the window opens.
    /// A series with more than `maxPoints` readings comes back as buckets at least `resolution`
    /// seconds long.
    public func fetchHistory(names: [ReadingName], from: Date, to: Date, maxPoints: Int? = nil,
                             resolution: Int? = nil) async throws -> HistoryResponse {
        var query = [
            URLQueryItem(name: "names", value: names.map(\.rawValue).joined(separator: ",")),
            URLQueryItem(name: "from", value: Self.iso.format(from)),
            URLQueryItem(name: "to", value: Self.iso.format(to))
        ]
        if let maxPoints {
            query.append(URLQueryItem(name: "maxPoints", value: String(maxPoints)))
        }
        if let resolution {
            query.append(URLQueryItem(name: "resolution", value: String(resolution)))
        }
        return try await send(.get, "history", query: query)
    }

    /// Which days between `from` and `to` have water temperature or salt readings.
    public func fetchAvailability(from: Date, to: Date) async throws -> HistoryAvailability {
        try await send(.get, "history/availability", query: [
            URLQueryItem(name: "from", value: Self.iso.format(from)),
            URLQueryItem(name: "to", value: Self.iso.format(to))
        ])
    }

    private static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    /// One page of the event log; pass the previous page's `next` as `cursor` for the following one.
    public func fetchEvents(types: [String], user: String?, cursor: String?, ascending: Bool, limit: Int) async throws -> EventPage {
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
    public func fetchEventUsers() async throws -> [String] {
        try await send(.get, "events/users")
    }

    // MARK: Control

    /// Asks the server to press the device's button if it isn't already in `on` state.
    /// The controller confirms the change on a later status frame.
    public func setDevice(_ name: ReadingName, on: Bool, token: String) async throws {
        try await perform(.put, "devices/\(Self.pathComponent(name.rawValue))/\(on)", token: token)
    }

    /// Asks the server to step the water flow to `mode`; it presses the spillover key until the
    /// controller reports that mode.
    public func setWaterMode(_ mode: WaterMode, token: String) async throws {
        try await perform(.put, "water/mode/\(mode.rawValue)", token: token)
    }

    /// Sets the temperature `device` drives `body` toward.
    public func setSetpoint(_ degrees: Int, device: HeatingDevice, body: WaterBody, token: String) async throws {
        try await perform(.put, "heating/setpoints/\(body.rawValue)/\(device.rawValue)/\(degrees)", token: token)
    }

    /// Queues one press of a panel key; the server sends it on the next controller ping.
    public func pressPanelKey(_ key: PanelKey, token: String) async throws {
        try await perform(.put, "panel/keys/\(key.rawValue)", token: token)
    }

    // MARK: Signing in

    public func signIn(name: String, password: String) async throws -> SignInResult {
        try await send(.post, "users/login", body: CredentialsBody(email: name, password: password))
    }

    /// Renames the signed-in account and sets its password; returns a new token, since the
    /// old one stops working.
    public func changeCredentials(name: String, password: String, token: String) async throws -> SignInResult {
        try await send(.put, "users/me/credentials", token: token, body: CredentialsBody(email: name, password: password))
    }

    /// The signed-in account and its current role.
    public func fetchAccount(token: String) async throws -> AccountInfo {
        try await send(.get, "users/me", token: token)
    }

    /// Ends this token's session on the server.
    public func signOut(token: String) async throws {
        try await perform(.delete, "users/me/token", token: token)
    }

    // MARK: Administration

    public func listAccounts(token: String) async throws -> [AccountInfo] {
        try await send(.get, "users", token: token)
    }

    public func createAccount(name: String, password: String, role: AccountRole, token: String) async throws -> AccountInfo {
        try await send(.post, "users", token: token, body: NewAccountBody(email: name, password: password, role: role))
    }

    /// Changes another account's role, resets its password, or both.
    public func updateAccount(_ name: String, role: AccountRole? = nil, password: String? = nil, token: String) async throws -> AccountInfo {
        try await send(.put, "users/\(Self.pathComponent(name))", token: token,
                       body: AccountChanges(role: role, password: password))
    }

    public func deleteAccount(_ name: String, token: String) async throws {
        try await perform(.delete, "users/\(Self.pathComponent(name))", token: token)
    }

    // MARK: Sign-in services

    /// What the sign-in form offers; needs no account.
    public func fetchSignInChoices() async throws -> SignInChoices {
        try await send(.get, "auth/providers")
    }

    /// Where a web authentication session starts signing in with a service; it ends at
    /// `poolstatus://signin`.
    public func signInURL(provider: String) throws -> URL {
        try url(for: "auth/\(Self.pathComponent(provider))/start", query: [URLQueryItem(name: "client", value: "ios")])
    }

    /// Trades the ticket a sign-in through a service came back with for a token.
    public func signIn(ticket: String) async throws -> SignInResult {
        try await send(.post, "users/login/external", body: TicketBody(ticket: ticket))
    }

    /// Where a web authentication session goes to add the service to the signed-in account.
    public func linkIdentityURL(provider: String, token: String) async throws -> URL {
        let link: LinkResponse = try await send(.post, "users/me/identities/\(Self.pathComponent(provider))", token: token,
                                                body: LinkBody(client: "ios"))
        guard let url = URL(string: link.url) else {
            throw StatusClientError.badResponse
        }
        return url
    }

    public func unlinkIdentity(provider: String, token: String) async throws -> AccountInfo {
        try await send(.delete, "users/me/identities/\(Self.pathComponent(provider))", token: token)
    }

    public func listRequests(token: String) async throws -> [AccessRequest] {
        try await send(.get, "users/requests", token: token)
    }

    /// Creates the person's account with `role`.
    public func approveRequest(_ id: String, role: AccountRole, token: String) async throws -> AccountInfo {
        try await send(.post, "users/requests/\(Self.pathComponent(id))/approve", token: token, body: ApprovalBody(role: role))
    }

    public func denyRequest(_ id: String, token: String) async throws -> AccessRequest {
        try await send(.post, "users/requests/\(Self.pathComponent(id))/deny", token: token)
    }

    /// Forgets a request, so a denied person may ask again.
    public func forgetRequest(_ id: String, token: String) async throws {
        try await perform(.delete, "users/requests/\(Self.pathComponent(id))", token: token)
    }

    public func listInvitations(token: String) async throws -> [Invitation] {
        try await send(.get, "users/invitations", token: token)
    }

    /// `provider` nil works with any service trusted for email addresses.
    public func createInvitation(email: String, role: AccountRole, provider: String?, token: String) async throws -> Invitation {
        try await send(.post, "users/invitations", token: token, body: InvitationBody(email: email, role: role, provider: provider))
    }

    public func deleteInvitation(_ id: String, token: String) async throws {
        try await perform(.delete, "users/invitations/\(Self.pathComponent(id))", token: token)
    }

    public func fetchSignInSettings(token: String) async throws -> SignInSettings {
        try await send(.get, "system/sign-in", token: token)
    }

    public func updateSignInSettings(_ changes: SignInSettings.Changes, token: String) async throws -> SignInSettings {
        try await send(.put, "system/sign-in", token: token, body: changes)
    }

    /// The server reads the issuer's discovery document before saving, so this can take a moment.
    public func createSignInService(_ service: SignInServiceChange, token: String) async throws -> SignInService {
        try await send(.post, "system/sign-in/providers", token: token, body: service, timeout: 20)
    }

    public func updateSignInService(_ id: String, _ changes: SignInServiceChange, token: String) async throws -> SignInService {
        try await send(.put, "system/sign-in/providers/\(Self.pathComponent(id))", token: token, body: changes, timeout: 20)
    }

    public func deleteSignInService(_ id: String, token: String) async throws {
        try await perform(.delete, "system/sign-in/providers/\(Self.pathComponent(id))", token: token)
    }

    /// Erases the server's history and accounts; returns the server's description of the result.
    public func factoryReset(token: String) async throws -> String {
        let data = try await fetchData(.post, "system/factory-reset", token: token)
        return (try? JSONDecoder().decode(ServerMessage.self, from: data))?.message ?? String(localized: "Factory reset complete.", bundle: .module)
    }

    /// Asks the server to exit; its container restart policy starts it again.
    public func restartServer(token: String) async throws {
        try await perform(.post, "system/restart", token: token)
    }

    public func fetchSettings(token: String) async throws -> ServerSettings {
        try await send(.get, "system/settings", token: token)
    }

    public func updateSettings(_ changes: ServerSettings.Changes, token: String) async throws -> ServerSettings {
        try await send(.put, "system/settings", token: token, body: changes)
    }

    public func fetchJobs(token: String) async throws -> [MaintenanceJob] {
        try await send(.get, "system/jobs", token: token)
    }

    /// Runs a maintenance job now; answers once it has finished.
    public func runJob(_ name: String, token: String) async throws -> MaintenanceJob {
        try await send(.post, "system/jobs/\(Self.pathComponent(name))/run", token: token, timeout: 120)
    }

    // MARK: Requests

    public func url(for path: String, query: [URLQueryItem]? = nil) throws -> URL {
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
    public static func defaultScheme(for address: String) -> String {
        let host = address.prefix { $0 != "/" && $0 != ":" }.lowercased()
        let isLocal = IPv4Network.parse(host) != nil || host.hasSuffix(".local") || !host.contains(".")
        return isLocal ? "http" : "https"
    }

    private enum Method: String {
        case get = "GET", post = "POST", put = "PUT", delete = "DELETE"
    }

    @concurrent
    private func send<Response: Decodable & Sendable>(_ method: Method, _ path: String, query: [URLQueryItem]? = nil,
                                                      token: String? = nil, body: (any Encodable & Sendable)? = nil,
                                                      timeout: TimeInterval = defaultTimeout) async throws -> Response {
        let data = try await fetchData(method, path, query: query, token: token, body: body, timeout: timeout)
        return try Self.decoder.decode(Response.self, from: data)
    }

    /// For requests whose answer only matters for its status.
    @concurrent
    private func perform(_ method: Method, _ path: String, token: String? = nil,
                         body: (any Encodable & Sendable)? = nil) async throws {
        _ = try await fetchData(method, path, token: token, body: body)
    }

    private func fetchData(_ method: Method, _ path: String, query: [URLQueryItem]? = nil, token: String? = nil,
                           body: (any Encodable & Sendable)? = nil, timeout: TimeInterval = defaultTimeout) async throws -> Data {
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

    private struct TicketBody: Encodable {
        let ticket: String
    }

    private struct LinkBody: Encodable {
        let client: String
    }

    private struct LinkResponse: Decodable {
        let url: String
    }

    private struct ApprovalBody: Encodable {
        let role: AccountRole
    }

    /// The server takes a null provider as any service trusted for email addresses.
    private struct InvitationBody: Encodable {
        let email: String
        let role: AccountRole
        let provider: String?

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(email, forKey: .email)
            try container.encode(role, forKey: .role)
            try container.encode(provider, forKey: .provider)
        }

        private enum CodingKeys: String, CodingKey {
            case email, role, provider
        }
    }
}

nonisolated private extension String {
    var capitalizingFirstLetter: String {
        prefix(1).uppercased() + dropFirst()
    }
}
