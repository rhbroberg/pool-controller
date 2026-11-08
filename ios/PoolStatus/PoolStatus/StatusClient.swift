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

struct SignInResult: Decodable {
    let email: String
    let token: String
    let role: AccountRole?
    /// The default admin account, whose token only works for renaming it.
    let mustChangeCredentials: Bool?
}

/// How a server identifies itself; only a pool controller server says `poolService`.
struct SystemInfo: Decodable {
    static let poolService = "pool-controller"

    let service: String
    let version: String
    let startedAt: Date
}

/// An account as the server describes it, without a token.
struct AccountInfo: Decodable, Identifiable, Hashable {
    let email: String
    let role: AccountRole
    let mustChangeCredentials: Bool?

    var id: String { email }
}

struct StatusClient {
    /// The server mounts every route under the Swagger `basePath`.
    static let apiPath = "rhbroberg/pool-api/1.0.0"

    let serverAddress: String

    func fetchStatus() async throws -> [StatusReading] {
        let data = try await send(URLRequest(url: try url(for: "status")))
        return try Self.decoder.decode([StatusReading].self, from: data)
    }

    /// Answers without the database or the pool controller, so it works whenever the server is up.
    func fetchSystemInfo(timeout: TimeInterval) async throws -> SystemInfo {
        let data = try await send(URLRequest(url: try url(for: "system/info")), timeout: timeout)
        return try Self.decoder.decode(SystemInfo.self, from: data)
    }

    func signIn(email: String, password: String) async throws -> SignInResult {
        var request = URLRequest(url: try url(for: "users/login"))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        let data = try await send(request)
        return try JSONDecoder().decode(SignInResult.self, from: data)
    }

    /// Renames the signed-in account and sets its password; returns a new token, since the
    /// old one stops working.
    func changeCredentials(name: String, password: String, token: String) async throws -> SignInResult {
        var request = URLRequest(url: try url(for: "users/me/credentials"))
        request.httpMethod = "PUT"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        request.httpBody = try JSONEncoder().encode(["email": name, "password": password])
        let data = try await send(request)
        return try JSONDecoder().decode(SignInResult.self, from: data)
    }

    /// The signed-in account and its current role.
    func fetchAccount(token: String) async throws -> AccountInfo {
        var request = URLRequest(url: try url(for: "users/me"))
        request.setValue(token, forHTTPHeaderField: "x-auth")
        return try JSONDecoder().decode(AccountInfo.self, from: try await send(request))
    }

    /// Ends this token's session on the server.
    func signOut(token: String) async throws {
        var request = URLRequest(url: try url(for: "users/me/token"))
        request.httpMethod = "DELETE"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        _ = try await send(request)
    }

    // MARK: Account management (admin)

    func listAccounts(token: String) async throws -> [AccountInfo] {
        var request = URLRequest(url: try url(for: "users"))
        request.setValue(token, forHTTPHeaderField: "x-auth")
        return try JSONDecoder().decode([AccountInfo].self, from: try await send(request))
    }

    func createAccount(name: String, password: String, role: AccountRole, token: String) async throws -> AccountInfo {
        var request = URLRequest(url: try url(for: "users"))
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        request.httpBody = try JSONEncoder().encode(["email": name, "password": password, "role": role.rawValue])
        return try JSONDecoder().decode(AccountInfo.self, from: try await send(request))
    }

    /// Changes another account's role, resets its password, or both.
    func updateAccount(_ name: String, role: AccountRole? = nil, password: String? = nil, token: String) async throws -> AccountInfo {
        var request = URLRequest(url: try url(for: "users/\(Self.pathComponent(name))"))
        request.httpMethod = "PUT"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        var changes: [String: String] = [:]
        changes["role"] = role?.rawValue
        changes["password"] = password
        request.httpBody = try JSONEncoder().encode(changes)
        return try JSONDecoder().decode(AccountInfo.self, from: try await send(request))
    }

    func deleteAccount(_ name: String, token: String) async throws {
        var request = URLRequest(url: try url(for: "users/\(Self.pathComponent(name))"))
        request.httpMethod = "DELETE"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        _ = try await send(request)
    }

    private static func pathComponent(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    /// Erases the server's history and accounts; returns the server's description of the result.
    func factoryReset(token: String) async throws -> String {
        var request = URLRequest(url: try url(for: "system/factory-reset"))
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        let data = try await send(request)
        return (try? JSONDecoder().decode(ServerMessage.self, from: data))?.message ?? "Factory reset complete."
    }

    /// Asks the server to exit; its container restart policy starts it again.
    func restartServer(token: String) async throws {
        var request = URLRequest(url: try url(for: "system/restart"))
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        _ = try await send(request)
    }

    /// Asks the server to step the water flow to `mode`; it presses the spillover key until the
    /// controller reports that mode.
    func setWaterMode(_ mode: WaterMode, token: String) async throws {
        var request = URLRequest(url: try url(for: "water/mode/\(mode.rawValue)"))
        request.httpMethod = "PUT"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        _ = try await send(request)
    }

    func fetchHeating() async throws -> HeatingStatus {
        try JSONDecoder().decode(HeatingStatus.self, from: try await send(URLRequest(url: try url(for: "heating"))))
    }

    /// Sets the temperature `device` drives `body` toward.
    func setSetpoint(_ degrees: Int, device: HeatingDevice, body: WaterBody, token: String) async throws {
        var request = URLRequest(url: try url(for: "heating/setpoints/\(body.rawValue)/\(device.rawValue)/\(degrees)"))
        request.httpMethod = "PUT"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        _ = try await send(request)
    }

    /// Asks the server to press the device's button if it isn't already in `on` state.
    /// The controller confirms the change on a later status frame.
    func setDevice(_ name: String, on: Bool, token: String) async throws {
        let device = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        var request = URLRequest(url: try url(for: "devices/\(device)/\(on)"))
        request.httpMethod = "PUT"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        _ = try await send(request)
    }

    /// Readings for each name from `from` up to `to`, plus each one's value as the window opens.
    func fetchHistory(names: [String], from: Date, to: Date) async throws -> HistoryResponse {
        let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        guard var components = URLComponents(url: try url(for: "history"), resolvingAgainstBaseURL: false) else {
            throw StatusClientError.invalidAddress(serverAddress)
        }
        components.queryItems = [
            URLQueryItem(name: "names", value: names.joined(separator: ",")),
            URLQueryItem(name: "from", value: iso.format(from)),
            URLQueryItem(name: "to", value: iso.format(to))
        ]
        guard let url = components.url else {
            throw StatusClientError.invalidAddress(serverAddress)
        }
        let data = try await send(URLRequest(url: url))
        return try Self.decoder.decode(HistoryResponse.self, from: data)
    }

    /// One page of the event log; pass the previous page's `next` as `cursor` for the following one.
    func fetchEvents(types: [String], user: String?, cursor: String?, ascending: Bool, limit: Int) async throws -> EventPage {
        guard var components = URLComponents(url: try url(for: "events"), resolvingAgainstBaseURL: false) else {
            throw StatusClientError.invalidAddress(serverAddress)
        }
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
        components.queryItems = query
        guard let url = components.url else {
            throw StatusClientError.invalidAddress(serverAddress)
        }
        return try Self.decoder.decode(EventPage.self, from: try await send(URLRequest(url: url)))
    }

    /// Every account with a recorded action.
    func fetchEventUsers() async throws -> [String] {
        try JSONDecoder().decode([String].self, from: try await send(URLRequest(url: try url(for: "events/users"))))
    }

    func fetchPanelDisplay() async throws -> PanelDisplay {
        let data = try await send(URLRequest(url: try url(for: "panel/display")))
        return try Self.decoder.decode(PanelDisplay.self, from: data)
    }

    /// Queues one press of a panel key; the server sends it on the next controller ping.
    func pressPanelKey(_ key: PanelKey, token: String) async throws {
        var request = URLRequest(url: try url(for: "panel/keys/\(key.rawValue)"))
        request.httpMethod = "PUT"
        request.setValue(token, forHTTPHeaderField: "x-auth")
        _ = try await send(request)
    }

    func url(for path: String) throws -> URL {
        var base = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        if !base.contains("://") {
            base = "http://" + base
        }
        while base.hasSuffix("/") {
            base.removeLast()
        }
        guard let url = URL(string: "\(base)/\(Self.apiPath)/\(path)"), url.host() != nil else {
            throw StatusClientError.invalidAddress(serverAddress)
        }
        return url
    }

    private func send(_ request: URLRequest, timeout: TimeInterval = 10) async throws -> Data {
        var request = request
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // the server's validator rejects a request body sent without a JSON content type
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)
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

    private struct ServerMessage: Decodable {
        let message: String
    }

    private static let decoder: JSONDecoder = {
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
}

private extension String {
    var capitalizingFirstLetter: String {
        prefix(1).uppercased() + dropFirst()
    }
}
