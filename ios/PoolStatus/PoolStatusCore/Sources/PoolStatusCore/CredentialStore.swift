import Foundation
import os
import Security

/// Where the signed-in account is kept between launches.
public protocol CredentialStore {
    func load() -> Credentials?
    func save(_ credentials: Credentials)
    func delete()
}

/// Keeps the signed-in account in the keychain. A keychain failure leaves the app signed in for
/// this launch only, so it's logged rather than shown.
public struct KeychainCredentialStore: CredentialStore {
    private static let logger = Logger(subsystem: "com.rhbroberg.PoolStatus", category: "keychain")

    private struct Stored: Codable {
        let token: String
        let role: AccountRole?
        /// Kept here when `account` names the item rather than the account; nil in items saved
        /// before sites.
        var name: String?
    }

    public static let defaultService = "com.rhbroberg.PoolStatus.auth"
    public static let sitesService = "com.rhbroberg.PoolStatus.sites"

    public let service: String
    /// Picks one of several items kept under `service`, one per site; nil for the single item the
    /// app kept before sites, which the account name labels.
    public let account: String?

    public init(service: String = KeychainCredentialStore.defaultService, account: String? = nil) {
        self.service = service
        self.account = account
    }

    /// The sign-in for one site.
    public static func site(_ id: UUID) -> KeychainCredentialStore {
        KeychainCredentialStore(service: sitesService, account: id.uuidString)
    }

    private var itemQuery: [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service]
        if let account {
            query[kSecAttrAccount as String] = account
        }
        return query
    }

    public func load() -> Credentials? {
        var query = itemQuery
        query[kSecReturnAttributes as String] = true
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else {
            if status != errSecItemNotFound {
                Self.logger.error("Couldn’t read the saved sign-in: \(status)")
            }
            return nil
        }
        guard let attributes = item as? [String: Any],
              let data = attributes[kSecValueData as String] as? Data else {
            return nil
        }
        let name = attributes[kSecAttrAccount as String] as? String ?? ""
        if let stored = try? JSONDecoder().decode(Stored.self, from: data) {
            return Credentials(name: stored.name ?? name, token: stored.token, role: stored.role)
        }
        // saved before roles existed: the item holds only the token
        guard let token = String(data: data, encoding: .utf8) else {
            return nil
        }
        return Credentials(name: name, token: token, role: nil)
    }

    /// Replaces the saved sign-in, adding one if there's none yet.
    public func save(_ credentials: Credentials) {
        let stored = Stored(token: credentials.token, role: credentials.role, name: account == nil ? nil : credentials.name)
        guard let data = try? JSONEncoder().encode(stored) else {
            Self.logger.error("Couldn’t encode the sign-in to save it")
            return
        }
        var attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        if account == nil {
            attributes[kSecAttrAccount as String] = credentials.name
        }
        var status = SecItemUpdate(itemQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(itemQuery.merging(attributes) { $1 } as CFDictionary, nil)
        }
        if status != errSecSuccess {
            Self.logger.error("Couldn’t save the sign-in: \(status)")
        }
    }

    public func delete() {
        let status = SecItemDelete(itemQuery as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            Self.logger.error("Couldn’t delete the saved sign-in: \(status)")
        }
    }
}
