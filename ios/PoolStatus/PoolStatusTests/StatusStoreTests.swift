import Foundation
import Testing
@testable import PoolStatus

@Suite("Status refresh")
struct StatusRefreshTests {
    private let readings = Fixture.switches(["filter", "pool", "heater1 mode"], off: ["aux14", "spa", "spillover"])
        + [("pool temp", "info", 81), ("spa temp", "info", 99), ("ambient", "info", 60), ("salt", "info", 3200)]

    @Test("shows the server's readings and heating, connected")
    func refreshes() async throws {
        let status = Fixture.status(readings)
        let server = StubServer { _, path, _ in
            switch path {
            case "status": .ok(status)
            case "heating": .ok(Fixture.heating())
            default: .status(404)
            }
        }
        let store = server.makeStore()
        await store.refresh()

        #expect(store.connection == .connected)
        #expect(store.errorMessage == nil)
        #expect(store.lastRefresh != nil)
        #expect(!store.isLoading)
        #expect(store.waterMode == .pool)
        #expect(store.measurements.map(\.value) == ["81°F", "99°F", "60°F", "3200 ppm"])
        #expect(store.measurement(named: .poolTemperature).isDimmed == false)
        #expect(store.measurement(named: .spaTemperature).isDimmed, "the spa filter is off, so its reading is old")
        #expect(store.heating?.target == .pool)

        let heater = try #require(EquipmentControl.control(named: .heater))
        #expect(store.isOn(heater), "the heater's state comes from its mode")
        #expect(store.heating(for: heater)?.heating == true)
        let filter = try #require(EquipmentControl.control(named: .filter))
        #expect(store.heating(for: filter) == nil)
    }

    @Test("reads the water flow from the spa and spillover switches", arguments: [
        (["spillover", "spa", "pool"], WaterMode.spillover),
        (["spa", "pool"], WaterMode.spa),
        (["pool"], WaterMode.pool)
    ])
    func waterMode(_ on: [String], _ mode: WaterMode) async {
        let status = Fixture.status(Fixture.switches(on))
        let server = StubServer { _, path, _ in path == "status" ? .ok(status) : .status(404) }
        let store = server.makeStore()
        await store.refresh()
        #expect(store.waterMode == mode)
    }

    @Test("still connects to a server without heating")
    func olderServer() async {
        let status = Fixture.status(readings)
        let server = StubServer { _, path, _ in path == "status" ? .ok(status) : .status(404) }
        let store = server.makeStore()
        await store.refresh()
        #expect(store.connection == .connected)
        #expect(store.heating == nil)
    }

    @Test("goes offline when the server can't be reached, keeping the last readings")
    func offline() async {
        let reachable = Shared(true)
        let status = Fixture.status(readings)
        let server = StubServer { _, path, _ in
            guard reachable.value else {
                return .fail(.cannotConnectToHost)
            }
            return path == "status" ? .ok(status) : .status(404)
        }
        let store = server.makeStore()
        await store.refresh()
        reachable.value = false
        await store.refresh()

        #expect(store.connection == .disconnected)
        #expect(store.connectionFailure != nil)
        #expect(!store.readings.isEmpty)
    }

    @Test("stays connected when the server answers with an error")
    func serverError() async {
        let server = StubServer { _, _, _ in .status(500, message: "database unavailable") }
        let store = server.makeStore()
        await store.refresh()
        #expect(store.connection == .connected)
        #expect(store.errorMessage == "Database unavailable")
    }

    @Test("calls an address it can't parse offline")
    func badAddress() async {
        let store = StatusStore(serverAddress: "", session: StubURLProtocol.session,
                                credentials: InMemoryCredentialStore())
        await store.refresh()
        #expect(store.connection == .disconnected)
    }

    @Test("keeps an address only once a server there answers")
    func connects() async throws {
        let status = Fixture.status(readings)
        let server = StubServer { _, path, _ in path == "status" ? .ok(status) : .status(404) }
        let store = StatusStore(serverAddress: "", defaults: UserDefaults(suiteName: "PoolStatusTests")!,
                                session: server.session, credentials: InMemoryCredentialStore())
        await #expect(throws: (any Error).self) {
            try await store.connect(to: "nowhere-\(UUID().uuidString.prefix(8)).local:3000")
        }
        #expect(store.serverAddress.isEmpty)

        try await store.connect(to: server.address)
        #expect(store.serverAddress == server.address)
        #expect(store.client.serverAddress == server.address)
    }
}

@Suite("Signed-in changes")
struct SignedInTests {
    @Test("a default admin must be renamed before its sign-in is kept")
    func commissioning() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("admin", role: "admin", mustChange: true))
            case ("PUT", "users/me/credentials"): .ok(Fixture.login("owner", role: "admin"))
            default: .status(404)
            }
        }
        let saved = InMemoryCredentialStore()
        let auth = server.makeStore(credentials: saved).auth
        try await auth.signIn(name: "admin", password: "admin")
        #expect(auth.commissioning != nil)
        #expect(auth.credentials == nil)
        #expect(saved.saved == nil, "the default admin's token isn't saved")

        try await auth.commission(name: "owner", password: "owner-password")
        #expect(auth.commissioning == nil)
        #expect(auth.credentials?.name == "owner")
        #expect(auth.isAdmin)
        #expect(saved.saved?.token == "token-owner")
        auth.signOut()
        #expect(saved.saved == nil)
    }

    @Test("turns equipment on and waits for the controller to confirm it")
    func setControl() async throws {
        let lightsOn = Shared(false)
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): return .ok(Fixture.login("operator"))
            case ("PUT", "devices/lights/true"):
                lightsOn.value = true
                return .ok(#"{"id":"lights","value":"true","previousValue":"false"}"#)
            case ("GET", "status"):
                return .ok(Fixture.status(Fixture.switches(lightsOn.value ? ["lights"] : [], off: lightsOn.value ? [] : ["lights"])))
            default: return .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "operator", password: "operator-password")
        #expect(store.auth.canControl)

        let lights = try #require(EquipmentControl.control(named: .lights))
        await store.setControl(lights, on: true)
        #expect(store.isOn(lights))
        #expect(store.confirmedChanges == 1)
        #expect(store.pendingState(.lights) == nil)
        #expect(server.requests.contains("PUT devices/lights/true"))
    }

    @Test("says so when the controller doesn't confirm a change in time")
    func unconfirmed() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("operator"))
            case ("PUT", _): .ok("{}")
            case ("GET", "status"): .ok(Fixture.status(Fixture.switches([], off: ["lights"])))
            default: .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "operator", password: "operator-password")
        let lights = try #require(EquipmentControl.control(named: .lights))
        await store.setControl(lights, on: true)
        #expect(store.errorMessage == "The controller hasn’t switched Lights to On yet.")
        #expect(store.confirmedChanges == 0)
    }

    @Test("asks the signed-out user to sign in before changing anything")
    func signedOut() async throws {
        let server = StubServer { _, _, _ in .status(404) }
        let store = server.makeStore()
        let lights = try #require(EquipmentControl.control(named: .lights))
        await store.setControl(lights, on: true)
        #expect(store.errorMessage == "Sign in to change equipment.")
        #expect(server.requests.isEmpty)
    }

    @Test("sends only the setpoints that changed")
    func setpoints() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("operator"))
            case ("GET", "status"): .ok(Fixture.status(Fixture.switches(["filter"])))
            case ("GET", "heating"): .ok(Fixture.heating())
            case ("PUT", _): .ok(#"{"setpoint":90}"#)
            default: .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "operator", password: "operator-password")
        await store.refresh()

        try await store.setSetpoints([.pool: 90, .spa: 102], device: .heater1)
        let puts = server.requests.filter { $0.hasPrefix("PUT") }
        #expect(puts == ["PUT heating/setpoints/pool/heater1/90"], "the spa was already 102")
    }

    @Test("changes the password once the current one checks out")
    func changePassword() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("operator"))
            case ("PUT", "users/me/credentials"): .ok(#"{"email":"operator","token":"token-new","role":"user"}"#)
            default: .status(404)
            }
        }
        let saved = InMemoryCredentialStore()
        let auth = server.makeStore(credentials: saved).auth
        try await auth.signIn(name: "operator", password: "old-password")
        try await auth.changePassword(current: "old-password", new: "new-password")
        #expect(auth.credentials?.token == "token-new", "the server signs out every other token")
        #expect(saved.saved?.token == "token-new")
    }

    @Test("refuses a password change when the current password is wrong")
    func wrongCurrentPassword() async throws {
        let attempts = Shared(0)
        let server = StubServer { method, path, _ in
            guard method == "POST", path == "users/login" else {
                return .status(404)
            }
            attempts.value += 1
            return attempts.value == 1 ? .ok(Fixture.login("operator")) : .status(401)
        }
        let auth = server.makeStore().auth
        try await auth.signIn(name: "operator", password: "right-password")
        await #expect(throws: PasswordChangeError.self) {
            try await auth.changePassword(current: "wrong", new: "new-password")
        }
        #expect(auth.credentials?.token == "token-operator", "still signed in as before")
    }

    @Test("switches the water flow and waits for the controller to reach it")
    func waterFlow() async throws {
        let mode = Shared("pool")
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): return .ok(Fixture.login("operator"))
            case ("PUT", "water/mode/spa"):
                mode.value = "spa"
                return .ok(#"{"mode":"spa","previousMode":"pool"}"#)
            case ("GET", "status"):
                return .ok(Fixture.status(Fixture.switches(mode.value == "spa" ? ["pool", "spa"] : ["pool"],
                                                           off: mode.value == "spa" ? [] : ["spa"])))
            default: return .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "operator", password: "operator-password")
        await store.refresh()
        #expect(store.waterMode == .pool)

        await store.setWaterMode(.spa)
        #expect(store.waterMode == .spa)
        #expect(store.pendingWaterMode == nil)
        #expect(store.confirmedChanges == 1)
    }

    @Test("an admin restarts the server, and a factory reset signs everyone out")
    func administration() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("owner", role: "admin"))
            case ("POST", "system/restart"): .ok(#"{"code":200,"message":"the server is restarting"}"#)
            case ("POST", "system/factory-reset"): .ok(#"{"code":200,"message":"factory reset complete"}"#)
            case ("GET", "status"): .ok(Fixture.status(Fixture.switches(["filter"])))
            default: .status(404)
            }
        }
        let saved = InMemoryCredentialStore()
        let store = server.makeStore(credentials: saved)
        try await store.auth.signIn(name: "owner", password: "owner-password")
        #expect(store.auth.isAdmin)
        try await store.restartServer()
        #expect(server.requests.contains("POST system/restart"))

        await store.refresh()
        let message = try await store.factoryReset()
        #expect(message == "factory reset complete")
        #expect(store.auth.credentials == nil)
        #expect(store.readings.isEmpty)
        #expect(saved.saved == nil)
    }

    @Test("signs out when the server no longer accepts the token")
    func expiredToken() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("operator"))
            case ("PUT", _): .status(401)
            default: .status(404)
            }
        }
        let saved = InMemoryCredentialStore()
        let store = server.makeStore(credentials: saved)
        try await store.auth.signIn(name: "operator", password: "operator-password")
        let filter = try #require(EquipmentControl.control(named: .filter))
        await store.setControl(filter, on: false)
        #expect(store.auth.credentials == nil)
        #expect(store.errorMessage == "Your sign-in is no longer valid. Sign in again to change equipment.")
        #expect(saved.saved == nil)
    }

    @Test("asks the server again when an admin has changed the account's role")
    func forbidden() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("operator"))
            case ("GET", "users/me"): .ok(#"{"email":"operator","role":"viewer"}"#)
            case ("PUT", _): .status(403)
            default: .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "operator", password: "operator-password")
        await store.setWaterMode(.spa)
        #expect(store.auth.role == .viewer)
        #expect(!store.auth.canControl)
        #expect(store.errorMessage == "Your account can’t change the water flow.")
    }

    @Test("an expired token on the accounts page signs out like anywhere else")
    func accountsExpired() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("owner", role: "admin"))
            case ("GET", "users"): .status(401)
            default: .status(404)
            }
        }
        let auth = server.makeStore().auth
        try await auth.signIn(name: "owner", password: "owner-password")
        await #expect(throws: AuthError.expired(.manageAccounts)) {
            try await auth.listAccounts()
        }
        #expect(auth.credentials == nil)
    }

    @Test("a saved sign-in is used at launch")
    func restoresSignIn() {
        let server = StubServer { _, _, _ in .status(404) }
        let store = server.makeStore(credentials: InMemoryCredentialStore(Credentials(name: "owner", token: "t", role: .admin)))
        #expect(store.auth.isAdmin)
        #expect(store.auth.needsAccountCheck, "an admin may have changed the role since it was saved")
    }
}
