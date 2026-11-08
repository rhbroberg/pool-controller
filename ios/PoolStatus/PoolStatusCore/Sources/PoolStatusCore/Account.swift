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
public struct Credentials: Equatable {
    public let name: String
    public let token: String
    /// Missing for sign-ins saved before roles existed, until the server is asked.
    public let role: AccountRole?
}

/// The server calls an account's name its `email`, though any name will do.
public nonisolated struct SignInResult: Decodable, Sendable {
    public let name: String
    public let token: String
    public let role: AccountRole?
    /// The default admin account, whose token only works for renaming it.
    public let mustChangeCredentials: Bool?

    private enum CodingKeys: String, CodingKey {
        case name = "email", token, role, mustChangeCredentials
    }
}

/// An account as the server describes it, without a token.
public nonisolated struct AccountInfo: Decodable, Identifiable, Hashable, Sendable {
    public let name: String
    public let role: AccountRole
    public let mustChangeCredentials: Bool?

    public var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name = "email", role, mustChangeCredentials
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
