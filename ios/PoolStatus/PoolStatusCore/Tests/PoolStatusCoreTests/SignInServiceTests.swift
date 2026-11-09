import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Signing in through a service")
struct SignInServiceTests {
    private func callback(_ query: String) -> URL {
        URL(string: "poolstatus://signin?\(query)")!
    }

    @Test("reads what the server sent back to poolstatus://signin")
    func outcomes() {
        #expect(SignInOutcome(callback: callback("ticket=abc")) == .ticket("abc"))
        #expect(SignInOutcome(callback: callback("status=pending&provider=Google")) == .pending(provider: "Google"))
        #expect(SignInOutcome(callback: callback("status=denied&provider=Google")) == .denied(provider: "Google"))
        #expect(SignInOutcome(callback: callback("status=refused")) == .refused)
        #expect(SignInOutcome(callback: callback("status=cancelled")) == .cancelled)
        #expect(SignInOutcome(callback: callback("status=linked&provider=Google")) == .linked(provider: "Google"))
        #expect(SignInOutcome(callback: callback("error=The%20service%20said%20no")) == .failed("The service said no"))

        #expect(SignInOutcome.pending(provider: "Google").message?.contains("sign in with Google") == true)
        #expect(SignInOutcome.refused.isFailure)
        #expect(!SignInOutcome.cancelled.isFailure)
        #expect(SignInOutcome.ticket("x").message == nil)
    }

    @Test("a ticket signs in, as an account without a password")
    func ticket() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login/external"):
                .ok(#"{"email":"alice@example.com","token":"from-google","role":"viewer","methods":["google"]}"#)
            default: .status(404)
            }
        }
        let saved = InMemoryCredentialStore()
        let auth = server.makeStore(credentials: saved).auth
        let outcome = try await auth.completeSignIn(callback: callback("ticket=t1"))
        #expect(outcome == .ticket("t1"))
        #expect(auth.credentials?.name == "alice@example.com")
        #expect(auth.role == .viewer)
        #expect(!auth.hasPassword)
        #expect(saved.saved?.token == "from-google")
    }

    @Test("waiting for approval leaves the app signed out")
    func pending() async throws {
        let server = StubServer { _, _, _ in .status(404) }
        let auth = server.makeStore().auth
        let outcome = try await auth.completeSignIn(callback: callback("status=pending&provider=Google"))
        #expect(outcome == .pending(provider: "Google"))
        #expect(auth.credentials == nil)
        #expect(server.requests.isEmpty)
    }

    @Test("tells a server without sign-in services from one offering them")
    func choices() async throws {
        let older = StubServer { method, path, _ in
            method == "POST" && path == "users/login" ? .ok(Fixture.login("owner", role: "admin")) : .status(404, message: "not found")
        }
        let olderAuth = older.makeStore().auth
        #expect(await olderAuth.signInChoices() == nil)
        try await olderAuth.signIn(name: "owner", password: "owner-password")
        await #expect(throws: SignInServicesError.unsupported) { try await olderAuth.signInSettings() }
        #expect(olderAuth.credentials != nil, "an older server isn't a reason to sign out")

        let newer = StubServer { method, path, _ in
            method == "GET" && path == "auth/providers"
                ? .ok(#"{"passwordSignIn":false,"providers":[{"id":"google","displayName":"Google"}]}"#)
                : .status(404)
        }
        let choices = try #require(await newer.makeStore().auth.signInChoices())
        #expect(!choices.passwordSignIn)
        #expect(choices.providers.map(\.displayName) == ["Google"])
        #expect(try newer.client.signInURL(provider: "google").absoluteString.hasSuffix("/auth/google/start?client=ios"))
    }

    @Test("an admin approves a request with a role, and invites an address")
    func approve() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("owner", role: "admin"))
            case ("GET", "users/requests"):
                .ok(#"[{"id":"r1","provider":"google","providerName":"Google","email":"bob@example.com","name":null,"status":"pending","firstSeen":"\#(Fixture.time)","lastSeen":"\#(Fixture.time)","attempts":2}]"#)
            case ("POST", "users/requests/r1/approve"):
                .ok(#"{"email":"bob@example.com","role":"user","mustChangeCredentials":false,"methods":["google"]}"#)
            case ("POST", "users/invitations"):
                .ok(#"{"id":"i1","email":"carol@example.com","provider":null,"providerName":null,"role":"viewer","createdBy":"owner","createdAt":"\#(Fixture.time)"}"#)
            default: .status(404)
            }
        }
        let auth = server.makeStore().auth
        try await auth.signIn(name: "owner", password: "owner-password")

        let requests = try await auth.listRequests()
        #expect(requests.count == 1)
        #expect(requests[0].title == "bob@example.com")
        #expect(requests[0].attempts == 2)

        let account = try await auth.approveRequest(requests[0], role: .user)
        #expect(account.role == .user)
        #expect(!account.hasPassword)
        #expect(signInMethodNames(account.methods, services: [SignInProvider(id: "google", displayName: "Google")]) == ["Google"])

        let invitation = try await auth.invite(email: "carol@example.com", role: .viewer, provider: nil)
        #expect(invitation.role == .viewer)
        #expect(server.requests.contains("POST users/requests/r1/approve"))
    }
}
