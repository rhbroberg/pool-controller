import Foundation
import Testing
@testable import PoolStatus

@Suite("Status refresh")
struct StatusRefreshTests {
    private let readings = Fixture.switches(["filter", "pool", "heater1 mode"], off: ["aux14", "spa", "spillover"])
        + [("pool temp", "info", 81), ("spa temp", "info", 99), ("ambient", "info", 60), ("salt", "info", 3200)]

    @Test("shows the server's readings and heating, connected")
    func refreshes() async {
        let status = Fixture.status(readings)
        let server = StubServer { _, path, _ in
            switch path {
            case "status": .ok(status)
            case "heating": .ok(Fixture.heating())
            default: .status(404)
            }
        }
        let store = StatusStore()
        await store.refresh(from: server.address)

        #expect(store.connection == .connected)
        #expect(store.errorMessage == nil)
        #expect(store.lastRefresh != nil)
        #expect(store.waterMode == .pool)
        #expect(store.measurements.map(\.value) == ["81°F", "99°F", "60°F", "3200 ppm"])
        #expect(store.measurement(named: "pool temp").isDimmed == false)
        #expect(store.measurement(named: "spa temp").isDimmed, "the spa filter is off, so its reading is old")
        #expect(store.heating?.target == .pool)

        let heater = EquipmentControl.all.first { $0.name == "heater1" }!
        #expect(store.isOn(heater), "the heater's state comes from its mode")
        #expect(store.heating(for: heater)?.heating == true)
        let filter = EquipmentControl.all.first { $0.name == "filter" }!
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
        let store = StatusStore()
        await store.refresh(from: server.address)
        #expect(store.waterMode == mode)
    }

    @Test("still connects to a server without heating")
    func olderServer() async {
        let status = Fixture.status(readings)
        let server = StubServer { _, path, _ in path == "status" ? .ok(status) : .status(404) }
        let store = StatusStore()
        await store.refresh(from: server.address)
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
        let store = StatusStore()
        await store.refresh(from: server.address)
        reachable.value = false
        await store.refresh(from: server.address)

        #expect(store.connection == .disconnected)
        #expect(store.connectionFailure != nil)
        #expect(!store.readings.isEmpty)
    }

    @Test("stays connected when the server answers with an error")
    func serverError() async {
        let server = StubServer { _, _, _ in .status(500, message: "database unavailable") }
        let store = StatusStore()
        await store.refresh(from: server.address)
        #expect(store.connection == .connected)
        #expect(store.errorMessage == "Database unavailable")
    }

    @Test("calls an address it can't parse offline")
    func badAddress() async {
        let store = StatusStore()
        await store.refresh(from: "")
        #expect(store.connection == .disconnected)
    }
}

/// These sign in, which uses the keychain, so they run one at a time and clear it afterwards.
@Suite("Signed-in changes", .serialized)
struct SignedInTests {
    init() {
        TokenStore.delete()
    }

    @Test("a default admin must be renamed before its sign-in is kept")
    func commissioning() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("admin", role: "admin", mustChange: true))
            case ("PUT", "users/me/credentials"): .ok(Fixture.login("owner", role: "admin"))
            default: .status(404)
            }
        }
        let store = StatusStore()
        try await store.signIn(email: "admin", password: "admin", serverAddress: server.address)
        #expect(store.commissioning != nil)
        #expect(store.credentials == nil)
        #expect(TokenStore.load() == nil, "the default admin's token isn't saved")

        try await store.commission(name: "owner", password: "owner-password", serverAddress: server.address)
        #expect(store.commissioning == nil)
        #expect(store.credentials?.email == "owner")
        #expect(store.isAdmin)
        #expect(TokenStore.load()?.token == "token-owner")
        store.signOut()
        #expect(TokenStore.load() == nil)
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
        let store = StatusStore()
        try await store.signIn(email: "operator", password: "operator-password", serverAddress: server.address)
        #expect(store.canControl)

        let lights = try #require(EquipmentControl.all.first { $0.name == "lights" })
        await store.setControl(lights, on: true, serverAddress: server.address)
        #expect(store.isOn(lights))
        #expect(store.confirmedChanges == 1)
        #expect(store.pendingState("lights") == nil)
        #expect(server.requests.contains("PUT devices/lights/true"))
        store.signOut()
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
        let store = StatusStore()
        try await store.signIn(email: "operator", password: "operator-password", serverAddress: server.address)
        await store.refresh(from: server.address)

        try await store.setSetpoints([.pool: 90, .spa: 102], device: .heater1, serverAddress: server.address)
        let puts = server.requests.filter { $0.hasPrefix("PUT") }
        #expect(puts == ["PUT heating/setpoints/pool/heater1/90"], "the spa was already 102")
        store.signOut()
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
        let store = StatusStore()
        try await store.signIn(email: "operator", password: "old-password", serverAddress: server.address)
        try await store.changePassword(current: "old-password", new: "new-password", serverAddress: server.address)
        #expect(store.credentials?.token == "token-new", "the server signs out every other token")
        #expect(TokenStore.load()?.token == "token-new")
        store.signOut()
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
        let store = StatusStore()
        try await store.signIn(email: "operator", password: "right-password", serverAddress: server.address)
        await #expect(throws: PasswordChangeError.self) {
            try await store.changePassword(current: "wrong", new: "new-password", serverAddress: server.address)
        }
        #expect(store.credentials?.token == "token-operator", "still signed in as before")
        store.signOut()
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
        let store = StatusStore()
        try await store.signIn(email: "operator", password: "operator-password", serverAddress: server.address)
        await store.refresh(from: server.address)
        #expect(store.waterMode == .pool)

        await store.setWaterMode(.spa, serverAddress: server.address)
        #expect(store.waterMode == .spa)
        #expect(store.pendingWaterMode == nil)
        #expect(store.confirmedChanges == 1)
        store.signOut()
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
        let store = StatusStore()
        try await store.signIn(email: "owner", password: "owner-password", serverAddress: server.address)
        #expect(store.isAdmin)
        try await store.restartServer(serverAddress: server.address)
        #expect(server.requests.contains("POST system/restart"))

        await store.refresh(from: server.address)
        let message = try await store.factoryReset(serverAddress: server.address)
        #expect(message == "factory reset complete")
        #expect(store.credentials == nil)
        #expect(store.readings.isEmpty)
        #expect(TokenStore.load() == nil)
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
        let store = StatusStore()
        try await store.signIn(email: "operator", password: "operator-password", serverAddress: server.address)
        let filter = try #require(EquipmentControl.all.first { $0.name == "filter" })
        await store.setControl(filter, on: false, serverAddress: server.address)
        #expect(store.credentials == nil)
        #expect(store.errorMessage?.contains("Sign in again") == true)
        #expect(TokenStore.load() == nil)
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
        let store = StatusStore()
        try await store.signIn(email: "operator", password: "operator-password", serverAddress: server.address)
        await store.setWaterMode(.spa, serverAddress: server.address)
        #expect(store.role == .viewer)
        #expect(!store.canControl)
        #expect(store.errorMessage == "Your account can’t change the water flow.")
        store.signOut()
    }
}
