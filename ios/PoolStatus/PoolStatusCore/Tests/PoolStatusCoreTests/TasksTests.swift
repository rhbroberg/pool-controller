import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Tasks")
struct TasksTests {
    nonisolated private static func tasks(pool: Bool = false, preheat: Bool = false, party: Bool = false,
                                          readyAt: String? = nil, dark: Bool = true) -> String {
        let scheduled = readyAt.map {
            #"{"readyAt":"\#($0)","startAt":"2026-11-12T22:30:00.000Z","leadMinutes":90,"leadFrom":"rule","fromTemperature":81,"setpoint":102,"requestedBy":"owner"}"#
        } ?? "null"
        return #"{"pool":{"on":\#(pool)},"spaPreheat":{"on":\#(preheat),"scheduled":\#(scheduled)},"spaParty":{"on":\#(party)},"dark":\#(dark)}"#
    }

    @Test("reads each task, and a preheat waiting for its time")
    func decodes() throws {
        let waiting = try StatusClient.decoder.decode(TaskStatus.self, from: Data(Self.tasks(pool: true, readyAt: "2026-11-13T00:00:00.000Z").utf8))
        #expect(waiting.isOn(.pool))
        #expect(!waiting.isOn(.spaPreheat))
        #expect(!waiting.isOn(.spaParty))
        #expect(waiting.dark)
        let scheduled = try #require(waiting.scheduledPreheat)
        #expect(scheduled.leadMinutes == 90)
        #expect(scheduled.leadFrom == "rule")
        #expect(scheduled.readyAt.timeIntervalSince(scheduled.startAt) == 90 * 60)
        #expect(scheduled.requestedBy == "owner")

        guard case .tasks(let pushed) = LiveUpdate(name: "tasks", payload: Data(Self.tasks(party: true).utf8)) else {
            Issue.record("tasks push")
            return
        }
        #expect(pushed.spaParty)
    }

    @Test("turns a task on and waits for the controller to report its switches")
    func turnsOn() async throws {
        let poolOn = Shared(false)
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): return .ok(Fixture.login("operator"))
            case ("PUT", "tasks/pool"):
                // the switches come on a moment later, as the controller reports them
                return .ok(Self.tasks())
            case ("GET", "tasks"):
                defer { poolOn.value = true }
                return .ok(Self.tasks(pool: poolOn.value))
            case ("GET", "status"): return .ok(Fixture.status(Fixture.switches(["filter"])))
            default: return .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "operator", password: "operator-password")

        await store.setTask(.pool, on: true)
        #expect(store.tasks?.pool == true)
        #expect(store.confirmedChanges == 1)
        #expect(store.errorMessage == nil)
        #expect(store.pendingTasks.isEmpty)
        #expect(server.requests.contains("PUT tasks/pool"))
    }

    @Test("a preheat for later is confirmed by its schedule, without waiting for the switches")
    func schedules() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("operator"))
            case ("PUT", "tasks/spaPreheat"), ("GET", "tasks"): .ok(Self.tasks(readyAt: "2026-11-13T00:00:00.000Z"))
            case ("GET", "status"): .ok(Fixture.status(Fixture.switches([])))
            default: .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "operator", password: "operator-password")

        await store.setTask(.spaPreheat, on: true, readyAt: try Date.ISO8601FormatStyle().parse("2026-11-13T00:00:00Z"))
        #expect(store.tasks?.scheduledPreheat != nil)
        #expect(store.tasks?.spaPreheat == false)
        #expect(store.errorMessage == nil)
    }

    @Test("says what the server couldn't do, and that signing in comes first")
    func refused() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("operator"))
            case ("PUT", "tasks/spaParty"): .status(409, message: "the panel has not shown the heater mode yet; try again shortly")
            case ("GET", "tasks"): .ok(Self.tasks())
            case ("GET", "status"): .ok(Fixture.status(Fixture.switches([])))
            default: .status(404)
            }
        }
        let store = server.makeStore()
        await store.setTask(.spaParty, on: true)
        #expect(store.errorMessage == "Sign in to change equipment.")

        try await store.auth.signIn(name: "operator", password: "operator-password")
        await store.setTask(.spaParty, on: true)
        #expect(store.errorMessage == "The panel has not shown the heater mode yet; try again shortly")
    }

    @Test("a server without tasks leaves them out")
    func olderServer() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("GET", "status"): .ok(Fixture.status(Fixture.switches(["filter"])))
            default: .status(404)
            }
        }
        let store = server.makeStore()
        await store.refresh()
        #expect(store.isConnected)
        #expect(store.tasks == nil)
    }
}
