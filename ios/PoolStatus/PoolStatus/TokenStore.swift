import Foundation
import Security

/// Keeps the signed-in account in the keychain.
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
        let name = attributes[kSecAttrAccount as String] as? String ?? ""
        if let stored = try? JSONDecoder().decode(Stored.self, from: data) {
            return Credentials(name: name, token: stored.token, role: stored.role)
        }
        // saved before roles existed: the item holds only the token
        guard let token = String(data: data, encoding: .utf8) else {
            return nil
        }
        return Credentials(name: name, token: token, role: nil)
    }

    static func save(_ credentials: Credentials) {
        delete()
        guard let data = try? JSONEncoder().encode(Stored(token: credentials.token, role: credentials.role)) else {
            return
        }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: credentials.name,
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
