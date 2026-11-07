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
}

struct StatusClient {
    /// The server mounts every route under the Swagger `basePath`.
    static let apiPath = "rhbroberg/pool-api/1.0.0"

    let serverAddress: String

    func fetchStatus() async throws -> [StatusReading] {
        let data = try await send(URLRequest(url: try url(for: "status")))
        return try Self.decoder.decode([StatusReading].self, from: data)
    }

    func signIn(email: String, password: String) async throws -> SignInResult {
        var request = URLRequest(url: try url(for: "users/login"))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        let data = try await send(request)
        return try JSONDecoder().decode(SignInResult.self, from: data)
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

    private func send(_ request: URLRequest) async throws -> Data {
        var request = request
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // the server's validator rejects any request without a JSON content type, body or not
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
