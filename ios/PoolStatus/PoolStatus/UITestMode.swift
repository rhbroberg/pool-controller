#if DEBUG
import Foundation
import PoolStatusCore

/// How the UI tests start the app: against the pretend server, with settings and sign-ins of
/// their own that each test starts fresh, so the tests need no real server and never touch the
/// keychain or the sites of an everyday install.
enum UITestMode {
    static let argument = "-uiTesting"
    /// Forgets every site and sign-in from earlier launches.
    static let reset = "-uiTestReset"
    /// Home and Lake, each signed in, and Cabin, signed out; Home open last.
    static let seedSites = "-uiTestSites"
    /// Old House, open last, with a sign-in its server no longer accepts.
    static let seedExpired = "-uiTestExpired"
    /// The pretend server's pool task on, and a spa preheat scheduled for three hours from now.
    static let seedTasks = "-uiTestTasks"

    private static let suite = "PoolStatusUITests"
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }

    static var isActive: Bool { arguments.contains(argument) }

    static func makeSession() -> SiteSession {
        guard let defaults = UserDefaults(suiteName: suite) else {
            return SiteSession()
        }
        if arguments.contains(reset) {
            defaults.removePersistentDomain(forName: suite)
        }
        let network = StatusStore.previewSession
        let sites = SiteStore(defaults: defaults, session: network) { id in
            DefaultsCredentialStore(defaults: defaults, key: "signIn.\(id.uuidString)")
        }
        if arguments.contains(seedSites) {
            seed(sites, name: "Home", host: "home.test", account: "tester")
            seed(sites, name: "Lake", host: "lake.test", account: "guest")
            seed(sites, name: "Cabin", host: "cabin.test", account: nil)
            if let home = sites.sites.first {
                sites.activate(home)
            }
        }
        if arguments.contains(seedExpired) {
            seed(sites, name: "Old House", host: "old.test", account: "tester", token: PreviewServer.expiredToken, activate: true)
        }
        if arguments.contains(seedTasks) {
            PreviewServer.setTask("pool", on: true)
            PreviewServer.setTask("spaPreheat", on: true, readyAt: .now.addingTimeInterval(3 * 3600))
        }
        return SiteSession(sites: sites, network: network) { site, credentials in
            StatusStore(serverAddress: site.address, defaults: defaults, remembersAddress: false,
                        session: network, credentials: credentials)
        }
    }

    private static func seed(_ sites: SiteStore, name: String, host: String, account: String?,
                             token: String? = nil, activate: Bool = false) {
        guard let site = try? sites.add(name: name, address: "\(host):3000") else {
            return
        }
        if let account {
            // no role, so the app checks the account with the server as it would after an update
            sites.credentialStore(for: site).save(Credentials(name: account, token: token ?? PreviewServer.token(for: account),
                                                              role: nil))
        }
        if activate {
            sites.activate(site)
        }
    }
}

/// Keeps a sign-in in the UI tests' own settings, which a reset wipes along with the sites.
private final class DefaultsCredentialStore: CredentialStore {
    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults, key: String) {
        self.defaults = defaults
        self.key = key
    }

    func load() -> Credentials? {
        guard let saved = defaults.dictionary(forKey: key) as? [String: String],
              let name = saved["name"], let token = saved["token"] else {
            return nil
        }
        return Credentials(name: name, token: token, role: saved["role"].flatMap(AccountRole.init(rawValue:)))
    }

    func save(_ credentials: Credentials) {
        var saved = ["name": credentials.name, "token": credentials.token]
        saved["role"] = credentials.role?.rawValue
        defaults.set(saved, forKey: key)
    }

    func delete() {
        defaults.removeObject(forKey: key)
    }
}
#endif
