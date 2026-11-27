import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Guests and expiring accounts")
struct GuestTests {
    @Test("reads a guest's link: the server, the name and the one-time code")
    func readsLink() throws {
        let link = try #require(GuestLink("https://pool.example.com:8443/join?name=sunny-otter&code=a1-b2_c3"))
        #expect(link.serverAddress == "https://pool.example.com:8443")
        #expect(link.name == "sunny-otter")
        #expect(link.code == "a1-b2_c3")
        #expect(link.isServer("pool.example.com:8443"))
        #expect(link.isServer("https://POOL.example.com:8443/"))
        #expect(!link.isServer("pool.example.com"))

        let legacy = try #require(GuestLink("https://pool.example.com:8443/#/join?name=sunny-otter&code=a1-b2_c3"))
        #expect(legacy == link)

        let used = try #require(GuestLink("http://192.168.1.20:8080/join?name=sunny-otter"))
        #expect(used.serverAddress == "http://192.168.1.20:8080")
        #expect(used.code == nil, "once the guest has a password, the link only names it")

        let app = try #require(GuestLink("poolstatus://join?server=https://pool.example.com:8443&name=sunny-otter&code=a1-b2_c3"))
        #expect(app == link)
        #expect(link.appURL?.absoluteString
                == "poolstatus://join?server=https://pool.example.com:8443&name=sunny-otter&code=a1-b2_c3")

        // URLSearchParams on the join page percent-encodes the server
        let encoded = try #require(GuestLink(
            "poolstatus://join?server=https%3A%2F%2Fpool.example.com%3A8443&name=sunny-otter&code=a1-b2_c3"))
        #expect(encoded == link)
    }

    @Test("turns away anything that isn't a guest's link")
    func rejects() {
        #expect(GuestLink("https://pool.example.com/#/settings") == nil)
        #expect(GuestLink("https://pool.example.com/join?code=abc") == nil, "no name")
        #expect(GuestLink("poolstatus://join?name=a") == nil, "app URL needs the server")
        #expect(GuestLink("not a link") == nil)
    }

    @Test("makes the same link the web page does, from a site's address")
    func makesLink() throws {
        let guest = AccountInfo(name: "sunny-otter", role: .user, guest: true, setupCode: "a1-b2_c3")
        let url = try #require(GuestLink.url(serverAddress: "pool.example.com:8443", account: guest))
        #expect(url.absoluteString == "https://pool.example.com:8443/join?name=sunny-otter&code=a1-b2_c3")
        let local = try #require(GuestLink.url(serverAddress: "192.168.1.20:3000", account: guest))
        #expect(local.absoluteString == "http://192.168.1.20:3000/join?name=sunny-otter&code=a1-b2_c3")
        #expect(GuestLink(url.absoluteString) == GuestLink(serverAddress: "https://pool.example.com:8443", name: "sunny-otter", code: "a1-b2_c3"))

        let claimed = AccountInfo(name: "sunny-otter", role: .user, guest: true, setupCode: nil)
        #expect(GuestLink.url(serverAddress: "https://pool.example.com", account: claimed)?.absoluteString
                == "https://pool.example.com/join?name=sunny-otter")
    }

    @Test("reads an account's dates, and that it's a guest or archived")
    func decodesAccount() throws {
        let json = #"{"email":"brave-heron","role":"user","methods":[],"guest":true,"setupCode":null,"createdAt":"2026-11-01T12:00:00.000Z","firstSignInAt":"2026-11-01T12:05:00.000Z","lastSignInAt":null,"expiresAt":"2026-11-08T12:00:00.000Z","archivedAt":"2026-11-08T12:00:00.000Z"}"#
        let account = try StatusClient.decoder.decode(AccountInfo.self, from: Data(json.utf8))
        #expect(account.isGuest)
        #expect(account.isArchived)
        #expect(account.createdAt == (try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse("2026-11-01T12:00:00.000Z")))
        #expect(account.lastSignInAt == nil)

        let older = try StatusClient.decoder.decode(AccountInfo.self, from: Data(#"{"email":"rick","role":"admin"}"#.utf8))
        #expect(!older.isGuest && !older.isArchived && older.expiresAt == nil, "an older server says none of it")
    }

    @Test("sends an expiry as a time, or null for none")
    func expiry() throws {
        #expect(AccountExpiry.never.serverValue == nil)
        let date = try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse("2026-11-19T03:00:00.000Z")
        #expect(AccountExpiry.at(date).serverValue == "2026-11-19T03:00:00.000Z")
    }

    @Test("a guest signed in with its code chooses a password before anything is saved")
    func signsInWithCode() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login/guest"): .ok(Fixture.login("sunny-otter", mustChange: true))
            case ("PUT", "users/me/credentials"): .ok(Fixture.login("sunny-otter"))
            default: .status(404)
            }
        }
        let saved = InMemoryCredentialStore()
        let auth = AuthSession(client: server.client, store: saved)

        try await auth.signInAsGuest(name: "sunny-otter", code: "a1-b2_c3")
        #expect(auth.commissioning?.name == "sunny-otter")
        #expect(auth.commissioningGuest)
        #expect(auth.credentials == nil, "the code's token only sets a password, so it isn't kept")

        try await auth.commission(name: "sunny-otter", password: "surf-password")
        #expect(auth.credentials?.name == "sunny-otter")
        #expect(auth.commissioning == nil && !auth.commissioningGuest)
        #expect(saved.load()?.token == "token-sunny-otter")
        #expect(server.requests == ["POST users/login/guest", "PUT users/me/credentials"])
    }

    @Test("an admin creates a guest with an expiry for its QR code")
    func createsGuest() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/guests"): .ok(Fixture.guest("sunny-otter", setupCode: "a1-b2_c3"))
            default: .status(404)
            }
        }
        let auth = AuthSession(client: server.client, store: InMemoryCredentialStore(Credentials(name: "rick", token: "t", role: .admin)))
        let guest = try await auth.createGuest(expiry: .at(Date(timeIntervalSince1970: 1_795_046_400)))
        #expect(guest.name == "sunny-otter")
        #expect(guest.setupCode == "a1-b2_c3")
        #expect(guest.isGuest)
        #expect(server.requests == ["POST users/guests"])
    }

    @Test("lists archived accounts too, and removes them all at once")
    func archived() async throws {
        let server = StubServer { method, path, query in
            switch (method, path) {
            case ("GET", "users") where query["archived"] == "include": .ok(#"[{"email":"rick","role":"admin"}]"#)
            case ("DELETE", "users/archived"): .ok(#"{"message":"removed 1 archived account"}"#)
            default: .status(404)
            }
        }
        let auth = AuthSession(client: server.client, store: InMemoryCredentialStore(Credentials(name: "rick", token: "t", role: .admin)))
        #expect(try await auth.listAccounts().map(\.name) == ["rick"])
        try await auth.deleteArchivedAccounts()
        #expect(server.requests.last == "DELETE users/archived")
    }
}
