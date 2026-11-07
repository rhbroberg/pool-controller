import Foundation
import Security

/// What an account may do, from the server. Each role can do everything the one before it can.
enum AccountRole: String, Codable, CaseIterable, Identifiable {
    case viewer, user, admin

    var id: String { rawValue }

    /// The server's `user` role is shown as Operator, so the word doesn't also mean "an account".
    var title: String {
        switch self {
        case .viewer: "Viewer"
        case .user: "Operator"
        case .admin: "Admin"
        }
    }

    /// The title after "a" or "an", as in "is now an operator".
    var titleWithArticle: String {
        switch self {
        case .viewer: "a viewer"
        case .user: "an operator"
        case .admin: "an admin"
        }
    }

    /// Turn equipment on and off and press panel keys.
    var canControl: Bool { self != .viewer }
    /// Manage accounts, restart the server, factory reset.
    var isAdmin: Bool { self == .admin }

    var summary: String {
        switch self {
        case .viewer: "Viewers can see everything and change their own password."
        case .user: "Operators can also change equipment, water flow and panel settings."
        case .admin: "Admins can also manage accounts, restart the server and factory reset."
        }
    }
}

/// The signed-in account, its `x-auth` token and role, kept in the keychain.
struct Credentials {
    let email: String
    let token: String
    /// Missing for sign-ins saved before roles existed, until the server is asked.
    let role: AccountRole?
}

enum TokenStore {
    private static let service = "com.rhbroberg.PoolStatus.auth"

    private struct Stored: Codable {
        let token: String
        let role: AccountRole?
    }

    static func load() -> Credentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let attributes = item as? [String: Any],
              let data = attributes[kSecValueData as String] as? Data else {
            return nil
        }
        let email = attributes[kSecAttrAccount as String] as? String ?? ""
        if let stored = try? JSONDecoder().decode(Stored.self, from: data) {
            return Credentials(email: email, token: stored.token, role: stored.role)
        }
        // saved before roles existed: the item holds only the token
        guard let token = String(data: data, encoding: .utf8) else {
            return nil
        }
        return Credentials(email: email, token: token, role: nil)
    }

    static func save(_ credentials: Credentials) {
        delete()
        guard let data = try? JSONEncoder().encode(Stored(token: credentials.token, role: credentials.role)) else {
            return
        }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: credentials.email,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        SecItemDelete(query as CFDictionary)
    }
}
