import Foundation

/// What an account may do, from the server. Each role can do everything the one before it can.
public nonisolated enum AccountRole: String, Codable, CaseIterable, Identifiable, Sendable {
    case viewer, user, admin

    /// A role this app doesn't know yet gets the least access rather than failing the sign-in.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AccountRole(rawValue: raw) ?? .viewer
    }

    public var id: String { rawValue }

    /// The server's `user` role is shown as Operator, so the word doesn't also mean "an account".
    public var title: String {
        switch self {
        case .viewer: String(localized: "Viewer", bundle: .module)
        case .user: String(localized: "Operator", bundle: .module)
        case .admin: String(localized: "Admin", bundle: .module)
        }
    }

    /// After a change of role, as in "owner is now an operator."
    public func nowDescription(for name: String) -> String {
        switch self {
        case .viewer: String(localized: "\(name) is now a viewer.", bundle: .module)
        case .user: String(localized: "\(name) is now an operator.", bundle: .module)
        case .admin: String(localized: "\(name) is now an admin.", bundle: .module)
        }
    }

    /// Turn equipment on and off and press panel keys.
    public var canControl: Bool { self != .viewer }
    /// Manage accounts, restart the server, factory reset.
    public var isAdmin: Bool { self == .admin }

    public var summary: String {
        switch self {
        case .viewer: String(localized: "Viewers can see everything and change their own password.", bundle: .module)
        case .user: String(localized: "Operators can also change equipment, water flow and panel settings.", bundle: .module)
        case .admin: String(localized: "Admins can also manage accounts, restart the server and factory reset.", bundle: .module)
        }
    }
}

/// The signed-in account, its `x-auth` token and role.
public nonisolated struct Credentials: Equatable, Sendable, Identifiable {
    public let name: String
    public let token: String
    /// Missing for sign-ins saved before roles existed, until the server is asked.
    public let role: AccountRole?

    public var id: String { token }

    public init(name: String, token: String, role: AccountRole?) {
        self.name = name
        self.token = token
        self.role = role
    }
}

/// The server calls an account's name its `email`, though any name will do.
public nonisolated struct SignInResult: Decodable, Sendable {
    public let name: String
    public let token: String
    public let role: AccountRole?
    /// The default admin account, whose token only works for renaming it.
    public let mustChangeCredentials: Bool?
    /// password and/or the ids of the services the account signs in with; nil from older servers.
    public let methods: [String]?

    private enum CodingKeys: String, CodingKey {
        case name = "email", token, role, mustChangeCredentials, methods
    }
}

/// An account as the server describes it, without a token.
public nonisolated struct AccountInfo: Decodable, Identifiable, Hashable, Sendable {
    public let name: String
    public let role: AccountRole
    public let mustChangeCredentials: Bool?
    /// password and/or the ids of the services the account signs in with; nil from older servers.
    public let methods: [String]?
    /// The name a sign-in service gave.
    public let displayName: String?
    /// Made with the guest shortcut; nil from older servers.
    public let guest: Bool?
    /// A guest's one-time code, for its link and QR code, until it has chosen a password; only
    /// admins see it.
    public let setupCode: String?
    /// Nil from older servers, which don't keep these.
    public let createdAt: Date?
    public let firstSignInAt: Date?
    public let lastSignInAt: Date?
    /// When it's archived and stops signing in; nil for an account that doesn't expire.
    public let expiresAt: Date?
    public let archivedAt: Date?

    public var id: String { name }
    /// True until the server says otherwise.
    public var hasPassword: Bool { methods?.contains(SignInMethodID.password) ?? true }
    public var isGuest: Bool { guest == true }
    public var isArchived: Bool { archivedAt != nil }

    public init(name: String, role: AccountRole, mustChangeCredentials: Bool? = nil, methods: [String]? = nil, displayName: String? = nil,
                guest: Bool? = nil, setupCode: String? = nil, createdAt: Date? = nil, firstSignInAt: Date? = nil,
                lastSignInAt: Date? = nil, expiresAt: Date? = nil, archivedAt: Date? = nil) {
        self.name = name
        self.role = role
        self.mustChangeCredentials = mustChangeCredentials
        self.methods = methods
        self.displayName = displayName
        self.guest = guest
        self.setupCode = setupCode
        self.createdAt = createdAt
        self.firstSignInAt = firstSignInAt
        self.lastSignInAt = lastSignInAt
        self.expiresAt = expiresAt
        self.archivedAt = archivedAt
    }

    private enum CodingKeys: String, CodingKey {
        case name = "email", role, mustChangeCredentials, methods, displayName, guest, setupCode
        case createdAt, firstSignInAt, lastSignInAt, expiresAt, archivedAt
    }
}

/// A new expiry for an account.
public nonisolated enum AccountExpiry: Sendable, Equatable {
    case never
    case at(Date)

    /// What the server takes: an ISO 8601 time, or null.
    var serverValue: String? {
        switch self {
        case .never: nil
        case .at(let date): date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        }
    }
}

/// A guest's link, as its QR code holds it: the web page at the pool's server, which lets the
/// guest in once with its code to choose a password, or once it has one, asks for it. The app
/// reads the server, name and code from it to do the same.
public nonisolated struct GuestLink: Equatable, Sendable {
    /// With its scheme, as in `https://pool.example.com:8443`.
    public let serverAddress: String
    public let name: String
    /// Nil once the guest has chosen a password.
    public let code: String?

    public init(serverAddress: String, name: String, code: String?) {
        self.serverAddress = serverAddress
        self.name = name
        self.code = code
    }

    /// Reads a guest QR / join link:
    /// - `https://host[:port]/join?name=…&code=…` (and the older `/#/join?…` form)
    /// - `poolstatus://join?server=https://host&name=…&code=…` (the app’s own URL)
    public init?(_ text: String) {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased() else {
            return nil
        }
        if scheme == "poolstatus" {
            guard components.host == "join" || components.path == "join" || components.path == "/join",
                  let items = components.queryItems,
                  let name = items.first(where: { $0.name == "name" })?.value?.trimmingCharacters(in: .whitespaces), !name.isEmpty,
                  let server = items.first(where: { $0.name == "server" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !server.isEmpty else {
                return nil
            }
            serverAddress = server
            self.name = name
            code = items.first { $0.name == "code" }?.value.flatMap { $0.isEmpty ? nil : $0 }
            return
        }
        guard ["http", "https"].contains(scheme), let host = components.host, !host.isEmpty else {
            return nil
        }
        let items: [URLQueryItem]
        if let fragment = components.fragment {
            let parts = fragment.split(separator: "?", maxSplits: 1).map(String.init)
            guard parts.first == "/join", parts.count == 2,
                  let queryItems = URLComponents(string: "?\(parts[1])")?.queryItems else {
                return nil
            }
            items = queryItems
        } else if components.path == "/join" || components.path.hasSuffix("/join"),
                  let queryItems = components.queryItems {
            items = queryItems
        } else {
            return nil
        }
        guard let name = items.first(where: { $0.name == "name" })?.value?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
            return nil
        }
        let port = components.port.map { ":\($0)" } ?? ""
        serverAddress = "\(scheme)://\(host)\(port)"
        self.name = name
        code = items.first { $0.name == "code" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The https link for `account` on the server at `serverAddress`, as the web page puts in the QR code.
    public static func url(serverAddress: String, account: AccountInfo) -> URL? {
        var base = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        if !base.contains("://") {
            base = "\(StatusClient.defaultScheme(for: base))://\(base)"
        }
        while base.hasSuffix("/") {
            base.removeLast()
        }
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "name", value: account.name)]
            + (account.setupCode.map { [URLQueryItem(name: "code", value: $0)] } ?? [])
        guard let encoded = query.percentEncodedQuery else {
            return nil
        }
        return URL(string: "\(base)/join?\(encoded)")
    }

    /// The app URL the join page opens on an iPhone so Pool Status can take over from Safari.
    public var appURL: URL? {
        var query = URLComponents()
        query.scheme = "poolstatus"
        query.host = "join"
        query.queryItems = [
            URLQueryItem(name: "server", value: serverAddress),
            URLQueryItem(name: "name", value: name)
        ] + (code.map { [URLQueryItem(name: "code", value: $0)] } ?? [])
        return query.url
    }

    /// Whether `address`, as a site keeps it, is this link's server.
    public func isServer(_ address: String) -> Bool {
        ServerAddress.display(address).lowercased() == ServerAddress.display(serverAddress).lowercased()
    }
}

/// Shared rules for new passwords, matching the server's.
public enum PasswordRules {
    public static let minimumLength = 6

    /// Why `password` and `confirmation` can't be used yet, once something has been typed.
    public static func problem(_ password: String, confirmation: String) -> String? {
        if !password.isEmpty && password.count < minimumLength {
            return String(localized: "Use at least \(minimumLength) characters.", bundle: .module)
        }
        if !confirmation.isEmpty && confirmation != password {
            return String(localized: "The passwords don’t match.", bundle: .module)
        }
        return nil
    }

    public static func acceptable(_ password: String, confirmation: String) -> Bool {
        password.count >= minimumLength && password == confirmation
    }
}

public enum PasswordChangeError: LocalizedError {
    case wrongCurrentPassword

    public var errorDescription: String? {
        String(localized: "Your current password isn’t correct.", bundle: .module)
    }
}
