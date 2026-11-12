import Foundation
import Observation

/// A pool server this app knows: what to call it and where it is. Each has its own sign-in.
public nonisolated struct Site: Codable, Identifiable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var address: String
    /// The account last signed in here, kept after signing out or an expired sign-in so the
    /// sign-in page can offer it again.
    public var accountName: String?

    public init(id: UUID = UUID(), name: String, address: String, accountName: String? = nil) {
        self.id = id
        self.name = name
        self.address = address
        self.accountName = accountName
    }
}

public nonisolated enum SiteError: LocalizedError, Equatable {
    case noAddress
    /// Another site already uses the address.
    case duplicate(name: String)

    public var errorDescription: String? {
        switch self {
        case .noAddress: String(localized: "Enter the server’s address.", bundle: .module)
        case .duplicate(let name): String(localized: "\(name) already uses that address.", bundle: .module)
        }
    }
}

/// The pool servers this app knows, which one was open last, and each one's sign-in, which is
/// kept until that site signs out or is removed.
@Observable
public final class SiteStore {
    public private(set) var sites: [Site]
    /// The site open last, which the app opens again at launch.
    public private(set) var activeID: Site.ID?
    /// Each site's saved sign-in, kept current as the site's status store signs in and out.
    public private(set) var signIns: [Site.ID: Credentials] = [:]

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let credentials: (Site.ID) -> CredentialStore

    public init(defaults: UserDefaults = .standard,
                session: URLSession = .shared,
                credentials: @escaping (Site.ID) -> CredentialStore = { KeychainCredentialStore.site($0) }) {
        self.defaults = defaults
        self.session = session
        self.credentials = credentials
        let saved = defaults.data(forKey: SettingsKey.sites).flatMap { try? JSONDecoder().decode([Site].self, from: $0) } ?? []
        sites = saved
        activeID = defaults.string(forKey: SettingsKey.activeSite)
            .flatMap(UUID.init(uuidString:))
            .flatMap { id in saved.contains { $0.id == id } ? id : nil }
        for site in saved {
            signIns[site.id] = credentials(site.id).load()
        }
    }

    public static var defaultName: String { String(localized: "Pool", bundle: .module) }

    public var activeSite: Site? { activeID.flatMap(site(id:)) }

    public func site(id: Site.ID) -> Site? {
        sites.first { $0.id == id }
    }

    /// Where `site`'s status store keeps its sign-in; signing in and out there updates `signIns`.
    public func credentialStore(for site: Site) -> CredentialStore {
        let id = site.id
        return ObservedCredentialStore(base: credentials(id)) { [weak self] signedIn in
            self?.note(signedIn, for: id)
        }
    }

    // MARK: Changing the list

    /// Adds a site for `address`, named `name` or, without one, the default.
    @discardableResult
    public func add(name: String, address: String) throws -> Site {
        let site = Site(name: Self.cleanName(name), address: try checked(address, excluding: nil))
        sites.append(site)
        save()
        return site
    }

    /// Renames a site or moves it to another address.
    public func update(_ site: Site) throws {
        guard let index = sites.firstIndex(where: { $0.id == site.id }) else {
            return
        }
        var updated = site
        updated.name = Self.cleanName(site.name)
        updated.address = try checked(site.address, excluding: site.id)
        sites[index] = updated
        save()
    }

    /// Forgets a site: ends its session on the server if it can be reached, and deletes its sign-in.
    public func remove(_ site: Site) {
        let saved = credentials(site.id)
        if let token = saved.load()?.token {
            let client = StatusClient(serverAddress: site.address, session: session)
            Task { try? await client.signOut(token: token) }
        }
        saved.delete()
        signIns[site.id] = nil
        sites.removeAll { $0.id == site.id }
        if activeID == site.id {
            activeID = nil
        }
        save()
    }

    /// Remembers `site` as the one to open at launch.
    public func activate(_ site: Site) {
        activeID = site.id
        save()
    }

    /// Turns the one server and sign-in kept before sites into the first site. Runs once.
    public func migrate(legacyCredentials: CredentialStore = KeychainCredentialStore()) {
        guard !defaults.bool(forKey: SettingsKey.sitesMigrated) else {
            return
        }
        defer { defaults.set(true, forKey: SettingsKey.sitesMigrated) }
        let address = defaults.string(forKey: SettingsKey.serverAddress)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !address.isEmpty, !sites.contains(where: { Self.sameAddress($0.address, address) }) else {
            return
        }
        let signedIn = legacyCredentials.load()
        let site = Site(name: Self.cleanName(defaults.string(forKey: SettingsKey.poolName) ?? ""),
                        address: address, accountName: signedIn?.name)
        sites.append(site)
        activeID = site.id
        if let signedIn {
            let moved = credentials(site.id)
            moved.save(signedIn)
            // keep the old item if the new one couldn't be written, rather than lose the sign-in
            if moved.load() == signedIn {
                legacyCredentials.delete()
            }
            signIns[site.id] = moved.load()
        }
        save()
        defaults.removeObject(forKey: SettingsKey.serverAddress)
        defaults.removeObject(forKey: SettingsKey.poolName)
    }

    // MARK: Helpers

    private func note(_ signedIn: Credentials?, for id: Site.ID) {
        signIns[id] = signedIn
        if let name = signedIn?.name, let index = sites.firstIndex(where: { $0.id == id }), sites[index].accountName != name {
            sites[index].accountName = name
            save()
        }
    }

    private func checked(_ address: String, excluding id: Site.ID?) throws -> String {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw SiteError.noAddress
        }
        if let other = sites.first(where: { $0.id != id && Self.sameAddress($0.address, trimmed) }) {
            throw SiteError.duplicate(name: other.name)
        }
        return trimmed
    }

    private func save() {
        if let data = try? JSONEncoder().encode(sites) {
            defaults.set(data, forKey: SettingsKey.sites)
        }
        defaults.set(activeID?.uuidString, forKey: SettingsKey.activeSite)
    }

    private static func cleanName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? defaultName : trimmed
    }

    /// The same server, however the address was typed.
    static func sameAddress(_ first: String, _ second: String) -> Bool {
        ServerAddress.display(first).lowercased() == ServerAddress.display(second).lowercased()
    }
}

/// Passes sign-ins through to `base` and reports each change.
private final class ObservedCredentialStore: CredentialStore {
    private let base: CredentialStore
    private let changed: (Credentials?) -> Void

    init(base: CredentialStore, changed: @escaping (Credentials?) -> Void) {
        self.base = base
        self.changed = changed
    }

    func load() -> Credentials? { base.load() }

    func save(_ credentials: Credentials) {
        base.save(credentials)
        changed(credentials)
    }

    func delete() {
        base.delete()
        changed(nil)
    }
}
