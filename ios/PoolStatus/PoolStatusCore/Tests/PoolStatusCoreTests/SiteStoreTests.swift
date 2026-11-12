import Foundation
import Testing
@testable import PoolStatusCore

/// What a phone keeps between launches: its settings and its keychain.
private final class Phone {
    let defaults: UserDefaults
    private var keychain: [Site.ID: InMemoryCredentialStore] = [:]

    init() {
        let suite = "SiteStoreTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
    }

    func saved(_ id: Site.ID) -> InMemoryCredentialStore {
        if let store = keychain[id] {
            return store
        }
        let store = InMemoryCredentialStore()
        keychain[id] = store
        return store
    }

    /// The app starting up, as it does at each launch.
    func launch(session: URLSession = .shared) -> SiteStore {
        SiteStore(defaults: defaults, session: session) { self.saved($0) }
    }
}

@Suite("Sites")
struct SiteStoreTests {
    private let owner = Credentials(name: "owner", token: "token-owner", role: .admin)
    private let guest = Credentials(name: "guest", token: "token-guest", role: .viewer)

    @Test("adds sites, naming one Pool when it isn't given a name, and refuses an address twice")
    func adds() throws {
        let sites = Phone().launch()
        let home = try sites.add(name: "  Home ", address: " 192.168.1.20:3000 ")
        let lake = try sites.add(name: "", address: "https://lake.example.com/")

        #expect(sites.sites.map(\.name) == ["Home", "Pool"])
        #expect(home.address == "192.168.1.20:3000")
        #expect(lake.address == "https://lake.example.com/")
        #expect(throws: SiteError.duplicate(name: "Home")) { try sites.add(name: "Again", address: "http://192.168.1.20:3000/") }
        #expect(throws: SiteError.duplicate(name: "Pool")) { try sites.add(name: "Again", address: "LAKE.example.com") }
        #expect(throws: SiteError.noAddress) { try sites.add(name: "Nowhere", address: "  ") }
        #expect(sites.sites.count == 2)
    }

    @Test("renames and moves a site, but not onto another site's address")
    func updates() throws {
        let sites = Phone().launch()
        var home = try sites.add(name: "Home", address: "home.local:3000")
        _ = try sites.add(name: "Lake", address: "lake.local:3000")

        home.name = "Backyard"
        home.address = "backyard.local:3000"
        try sites.update(home)
        #expect(sites.site(id: home.id)?.name == "Backyard")
        #expect(sites.site(id: home.id)?.address == "backyard.local:3000")

        home.address = "lake.local:3000"
        #expect(throws: SiteError.duplicate(name: "Lake")) { try sites.update(home) }
        #expect(sites.site(id: home.id)?.address == "backyard.local:3000")
        home.address = "Backyard.local:3000"
        try sites.update(home)
    }

    @Test("remembers the sites, the one open last, and each one's sign-in across launches")
    func remembers() throws {
        let phone = Phone()
        let first = phone.launch()
        let home = try first.add(name: "Home", address: "home.local:3000")
        let lake = try first.add(name: "Lake", address: "lake.local:3000")
        first.credentialStore(for: lake).save(guest)
        first.activate(lake)
        #expect(first.signIns[lake.id] == guest)
        #expect(first.site(id: lake.id)?.accountName == "guest")

        let relaunched = phone.launch()
        #expect(relaunched.sites.map(\.name) == ["Home", "Lake"])
        #expect(relaunched.activeSite?.id == lake.id)
        #expect(relaunched.signIns[lake.id] == guest)
        #expect(relaunched.signIns[home.id] == nil)
    }

    @Test("keeps each site's sign-in apart, and remembers the account after signing out")
    func separateSignIns() throws {
        let sites = Phone().launch()
        let home = try sites.add(name: "Home", address: "home.local:3000")
        let lake = try sites.add(name: "Lake", address: "lake.local:3000")
        let homeAuth = AuthSession(client: StatusClient(serverAddress: home.address), store: sites.credentialStore(for: home))
        let lakeAuth = AuthSession(client: StatusClient(serverAddress: lake.address), store: sites.credentialStore(for: lake))

        homeAuth.adopt(owner)
        lakeAuth.adopt(guest)
        #expect(sites.signIns == [home.id: owner, lake.id: guest])

        homeAuth.forget()
        #expect(sites.signIns[home.id] == nil)
        #expect(sites.signIns[lake.id] == guest, "signing out of one site leaves the others signed in")
        #expect(lakeAuth.credentials == guest)
        #expect(sites.site(id: home.id)?.accountName == "owner", "the sign-in page offers the account again")
    }

    @Test("removing a site ends its session on the server and deletes only its sign-in")
    func removes() async throws {
        let server = StubServer { method, path, _ in
            method == "DELETE" && path == "users/me/token" ? .ok(#"{"message":"signed out"}"#) : .status(404)
        }
        let phone = Phone()
        let sites = phone.launch(session: server.session)
        let home = try sites.add(name: "Home", address: server.address)
        let lake = try sites.add(name: "Lake", address: "lake.local:3000")
        sites.credentialStore(for: home).save(owner)
        sites.credentialStore(for: lake).save(guest)
        sites.activate(home)

        sites.remove(home)
        #expect(sites.sites.map(\.id) == [lake.id])
        #expect(sites.activeSite == nil, "the removed site isn't opened at the next launch")
        #expect(phone.saved(home.id).saved == nil)
        #expect(phone.saved(lake.id).saved == guest)
        #expect(sites.signIns[home.id] == nil)

        let deadline = Date.now.addingTimeInterval(5)
        while !server.requests.contains("DELETE users/me/token") && Date.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(server.requests == ["DELETE users/me/token"])
    }

    @Test("turns the server and sign-in from before sites into the first site, once")
    func migrates() throws {
        let phone = Phone()
        phone.defaults.set("192.168.1.20:3000", forKey: SettingsKey.serverAddress)
        phone.defaults.set("Backyard", forKey: SettingsKey.poolName)
        let legacy = InMemoryCredentialStore(owner)

        let sites = phone.launch()
        sites.migrate(legacyCredentials: legacy)
        let site = try #require(sites.sites.first)
        #expect(sites.sites.count == 1)
        #expect(site.name == "Backyard")
        #expect(site.address == "192.168.1.20:3000")
        #expect(site.accountName == "owner")
        #expect(sites.activeSite == site, "the app opens straight onto it, signed in")
        #expect(sites.signIns[site.id] == owner)
        #expect(phone.saved(site.id).saved == owner)
        #expect(legacy.saved == nil)
        #expect(phone.defaults.string(forKey: SettingsKey.serverAddress) == nil)
        #expect(phone.defaults.string(forKey: SettingsKey.poolName) == nil)

        phone.defaults.set("other.local:3000", forKey: SettingsKey.serverAddress)
        let relaunched = phone.launch()
        relaunched.migrate(legacyCredentials: InMemoryCredentialStore(guest))
        #expect(relaunched.sites == [site], "it runs only once")
    }

    @Test("migrates a server without a sign-in, and a phone that never had a server")
    func migratesPartly() throws {
        let signedOut = Phone()
        signedOut.defaults.set("pool.local:3000", forKey: SettingsKey.serverAddress)
        let sites = signedOut.launch()
        sites.migrate(legacyCredentials: InMemoryCredentialStore())
        let site = try #require(sites.sites.first)
        #expect(site.name == "Pool")
        #expect(site.accountName == nil)
        #expect(sites.signIns[site.id] == nil)

        let fresh = Phone().launch()
        fresh.migrate(legacyCredentials: InMemoryCredentialStore())
        #expect(fresh.sites.isEmpty)
        #expect(fresh.activeSite == nil)
    }

    @Test("says when the server stopped accepting the sign-in, until the next one")
    func expired() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("GET", "users/me"): .status(401)
            case ("POST", "users/login"): .ok(Fixture.login("owner", role: "admin"))
            default: .status(404)
            }
        }
        let auth = AuthSession(client: server.client, store: InMemoryCredentialStore(owner))
        #expect(!auth.signInExpired)

        await auth.refreshAccount()
        #expect(auth.credentials == nil)
        #expect(auth.signInExpired)

        try await auth.signIn(name: "owner", password: "secret")
        #expect(auth.credentials?.name == "owner")
        #expect(!auth.signInExpired)

        auth.signOut()
        #expect(!auth.signInExpired, "signing out isn't the server refusing the sign-in")
    }
}
