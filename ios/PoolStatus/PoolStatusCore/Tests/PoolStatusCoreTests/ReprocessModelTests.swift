import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Reprocess history")
struct ReprocessModelTests {
    private static func run(_ state: String = "finished", dryRun: Bool = true, through: String? = nil,
                            updated: Int = 7, removed: Int = 1451, error: String? = nil) -> String {
        let throughJSON = through.map { "\"\($0)\"" } ?? "null"
        let errorJSON = error.map { "\"\($0)\"" } ?? "null"
        return #"{"state":"\#(state)","from":"2020-07-19T04:00:00.000Z","to":"2020-07-21T04:00:00.000Z","eventTypes":["failed","unrecognized"],"dryRun":\#(dryRun),"requestedBy":"owner","requestedAt":"2026-11-09T22:00:00.000Z","startedAt":null,"finishedAt":null,"through":\#(throughJSON),"scanned":1458,"examined":1458,"unchanged":0,"updated":\#(updated),"removed":\#(removed),"unreadable":0,"transitions":[{"from":"failed","to":"removed","count":1451},{"from":"failed","to":"info","count":7}],"error":\#(errorJSON)}"#
    }

    private static func decoded(_ json: String) throws -> ReprocessRun {
        try StatusClient.decoder.decode(ReprocessRun.self, from: Data(json.utf8))
    }

    /// A signed-in admin's store; `runs` are handed out in turn for each look at the run.
    private func adminStore(started: String, runs: [String]) async throws -> (StubServer, StatusStore) {
        let looks = Shared(runs)
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"):
                return .ok(Fixture.login("owner", role: "admin"))
            case ("POST", "system/reprocess"):
                return .ok(started)
            case ("GET", "system/reprocess"):
                var next = ""
                looks.modify { remaining in
                    next = remaining.count > 1 ? remaining.removeFirst() : remaining.first ?? ""
                }
                return next.isEmpty ? .status(404) : .ok(next)
            default:
                return .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "owner", password: "owner-password")
        return (server, store)
    }

    @Test("starts on the last 30 days and the frames the server couldn't read")
    func defaults() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/New_York"))
        let now = try Date.ISO8601FormatStyle().parse("2026-11-10T00:30:00Z")
        let model = ReprocessModel(now: now, calendar: calendar)
        #expect(model.to == now)
        #expect(model.from == (try Date.ISO8601FormatStyle().parse("2026-10-10T23:30:00Z")), "30 calendar days, across the clock change")
        #expect(model.eventTypes == ["failed", "unrecognized"])
        #expect(model.canStart(isAdmin: true))
        #expect(!model.canStart(isAdmin: false))
    }

    @Test("sends the kinds chosen as the server's event types, and says why it can't start")
    func choices() {
        let model = ReprocessModel()
        model.kinds = [.readings, .equipment]
        #expect(model.eventTypes == ["status", "info"])
        model.kinds = []
        #expect(model.problem == "Choose at least one kind of event.")
        model.kinds = [.keypad]
        model.to = model.from
        #expect(model.rangeProblem == "The start has to be before the end.")
        #expect(!model.canStart(isAdmin: true))
    }

    @Test("follows a run until it's done, a second apart")
    func follows() async throws {
        let (server, store) = try await adminStore(started: Self.run("waiting"),
                                                   runs: [Self.run("running", through: "2020-07-20T04:00:00.000Z"), Self.run()])
        let waits = Shared([Duration]())
        let following = ReprocessModel(sleep: { duration in waits.modify { $0.append(duration) } })
        await following.start(dryRun: true, store: store)
        #expect(following.run?.state == .waiting)
        #expect(!following.canStart(isAdmin: true), "not while a run goes on")
        await following.follow(store: store)
        #expect(following.run?.state == .finished)
        #expect(waits.value == [ReprocessModel.pollInterval, ReprocessModel.pollInterval])
        #expect(server.requests.filter { $0 == "GET system/reprocess" }.count == 2)
        #expect(following.canStart(isAdmin: true))
    }

    @Test("stops following when the screen goes away")
    func stopsFollowing() async throws {
        let (server, store) = try await adminStore(started: Self.run("running"), runs: [Self.run("running")])
        let model = ReprocessModel(sleep: { _ in throw CancellationError() })
        await model.start(dryRun: false, store: store)
        await model.follow(store: store)
        #expect(model.run?.state == .running)
        #expect(!server.requests.contains("GET system/reprocess"))
    }

    @Test("shows what went wrong, and that nothing has run yet")
    func failures() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("owner", role: "admin"))
            case ("POST", "system/reprocess"): .status(409, message: "history is already being reprocessed; wait for it to finish")
            default: .status(404, message: "history hasn’t been reprocessed since the server started")
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "owner", password: "owner-password")
        let model = ReprocessModel()
        await model.load(store: store)
        #expect(model.run == nil)
        #expect(model.errorMessage == nil)
        await model.start(dryRun: true, store: store)
        #expect(model.errorMessage == "History is already being reprocessed; wait for it to finish")
        #expect(!model.starting)
    }

    @Test("describes a run: where it is, its counts and what comes next")
    func describes() throws {
        #expect(ReprocessModel.stateText(try Self.decoded(Self.run("waiting"))) == "Preview waits for a maintenance job to finish")
        #expect(ReprocessModel.stateText(try Self.decoded(Self.run("running", dryRun: false))) == "Reprocessing has started")
        #expect(ReprocessModel.stateText(try Self.decoded(Self.run("running", through: "2020-07-20T04:00:00.000Z"))).hasPrefix("Preview is through "))
        #expect(ReprocessModel.stateText(try Self.decoded(Self.run("failed", error: "no database"))) == "Preview stopped: no database")
        #expect(ReprocessModel.stateText(try Self.decoded(Self.run(dryRun: false))) == "Reprocessed")

        let preview = try Self.decoded(Self.run())
        #expect(ReprocessModel.rows(preview).map(\.title) == ["Events read again", "Would be rewritten", "Would be removed", "Unchanged",
                                                              "Failed frames → Removed", "Failed frames → Readings"])
        #expect(ReprocessModel.rows(preview).map(\.count) == [1458, 7, 1451, 0, 1451, 7])
        #expect(ReprocessModel.rows(try Self.decoded(Self.run(dryRun: false)))[1].title == "Rewritten")

        #expect(ReprocessModel.footer(preview) == "Nothing has changed yet. Reprocess makes these changes.")
        #expect(ReprocessModel.footer(try Self.decoded(Self.run(dryRun: false)))?.contains("summaries are being redone") == true)
        #expect(ReprocessModel.footer(try Self.decoded(Self.run(dryRun: false, updated: 0, removed: 0))) == nil)
        #expect(ReprocessModel.footer(try Self.decoded(Self.run("running"))) == nil)
    }
}
