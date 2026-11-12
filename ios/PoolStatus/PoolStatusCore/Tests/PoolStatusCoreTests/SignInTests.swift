import Foundation
import Testing
@testable import PoolStatusCore

@Suite("The sign-in page")
struct SignInTests {
    private let owner = Credentials(name: "owner", token: "token-owner", role: .admin)

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

    @Test("offers the last account again after signing out, and at the next launch")
    func remembersAccount() async throws {
        let server = StubServer { method, path, _ in
            method == "POST" && path == "users/login" ? .ok(Fixture.login("owner", role: "admin")) : .status(404)
        }
        let defaults = try #require(UserDefaults(suiteName: "SignInTests-\(UUID().uuidString)"))
        let auth = AuthSession(client: server.client, store: InMemoryCredentialStore(), defaults: defaults)
        #expect(auth.lastAccountName == nil)

        try await auth.signIn(name: "owner", password: "secret")
        auth.signOut()
        #expect(auth.credentials == nil)
        #expect(auth.lastAccountName == "owner")

        let relaunched = AuthSession(client: server.client, store: InMemoryCredentialStore(), defaults: defaults)
        #expect(relaunched.lastAccountName == "owner")
    }
}
