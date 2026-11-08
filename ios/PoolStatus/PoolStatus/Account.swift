import Foundation

/// What an account may do, from the server. Each role can do everything the one before it can.
nonisolated enum AccountRole: String, Codable, CaseIterable, Identifiable, Sendable {
    case viewer, user, admin

    /// A role this app doesn't know yet gets the least access rather than failing the sign-in.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AccountRole(rawValue: raw) ?? .viewer
    }

    var id: String { rawValue }

    /// The server's `user` role is shown as Operator, so the word doesn't also mean "an account".
    var title: String {
        switch self {
        case .viewer: String(localized: "Viewer")
        case .user: String(localized: "Operator")
        case .admin: String(localized: "Admin")
        }
    }

    /// After a change of role, as in "owner is now an operator."
    func nowDescription(for name: String) -> String {
        switch self {
        case .viewer: String(localized: "\(name) is now a viewer.")
        case .user: String(localized: "\(name) is now an operator.")
        case .admin: String(localized: "\(name) is now an admin.")
        }
    }

    /// Turn equipment on and off and press panel keys.
    var canControl: Bool { self != .viewer }
    /// Manage accounts, restart the server, factory reset.
    var isAdmin: Bool { self == .admin }

    var summary: String {
        switch self {
        case .viewer: String(localized: "Viewers can see everything and change their own password.")
        case .user: String(localized: "Operators can also change equipment, water flow and panel settings.")
        case .admin: String(localized: "Admins can also manage accounts, restart the server and factory reset.")
        }
    }
}

/// The signed-in account, its `x-auth` token and role.
struct Credentials: Equatable {
    let name: String
    let token: String
    /// Missing for sign-ins saved before roles existed, until the server is asked.
    let role: AccountRole?
}

/// The server calls an account's name its `email`, though any name will do.
nonisolated struct SignInResult: Decodable, Sendable {
    let name: String
    let token: String
    let role: AccountRole?
    /// The default admin account, whose token only works for renaming it.
    let mustChangeCredentials: Bool?

    private enum CodingKeys: String, CodingKey {
        case name = "email", token, role, mustChangeCredentials
    }
}

/// An account as the server describes it, without a token.
nonisolated struct AccountInfo: Decodable, Identifiable, Hashable, Sendable {
    let name: String
    let role: AccountRole
    let mustChangeCredentials: Bool?

    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name = "email", role, mustChangeCredentials
    }
}

/// Shared rules for new passwords, matching the server's.
enum PasswordRules {
    static let minimumLength = 6

    /// Why `password` and `confirmation` can't be used yet, once something has been typed.
    static func problem(_ password: String, confirmation: String) -> String? {
        if !password.isEmpty && password.count < minimumLength {
            return String(localized: "Use at least \(minimumLength) characters.")
        }
        if !confirmation.isEmpty && confirmation != password {
            return String(localized: "The passwords don’t match.")
        }
        return nil
    }

    static func acceptable(_ password: String, confirmation: String) -> Bool {
        password.count >= minimumLength && password == confirmation
    }
}

enum PasswordChangeError: LocalizedError {
    case wrongCurrentPassword

    var errorDescription: String? {
        String(localized: "Your current password isn’t correct.")
    }
}
