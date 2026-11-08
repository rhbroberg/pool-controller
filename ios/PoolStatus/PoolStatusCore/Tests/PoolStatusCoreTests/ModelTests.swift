import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Event log")
struct EventLogTests {
    nonisolated private static func event(_ id: String, minute: Int, type: String = "action") -> String {
        #"{"id":"\#(id)","timestamp":"2026-11-07T22:\#(String(format: "%02d", minute)):00.000Z","type":"\#(type)","user":"owner","summary":"event \#(id)"}"#
    }

    @Test("pages with the server's cursor, dropping repeats, until the end")
    func pages() async {
        let server = StubServer { _, path, query in
            guard path == "events" else {
                return .status(404)
            }
            if query["cursor"] == "page-2" {
                return .ok(#"{"events":[\#(Self.event("b", minute: 2)),\#(Self.event("c", minute: 1))],"next":null}"#)
            }
            return .ok(#"{"events":[\#(Self.event("a", minute: 3)),\#(Self.event("b", minute: 2))],"next":"page-2"}"#)
        }
        let model = EventLogModel()
        await model.reload(client: server.client)
        #expect(model.events.map(\.id) == ["a", "b"])
        #expect(!model.reachedEnd)

        await model.loadMore(client: server.client)
        #expect(model.events.map(\.id) == ["a", "b", "c"])
        #expect(model.reachedEnd)
        #expect(model.oldest == model.events.last?.timestamp)

        await model.loadMore(client: server.client)
        #expect(server.requests.count == 2, "nothing more is asked for after the last page")
    }

    @Test("asks for the chosen kinds, account and order")
    func filters() async {
        let query = Shared([String: String]())
        let server = StubServer { _, _, received in
            query.value = received
            return .ok(#"{"events":[],"next":null}"#)
        }
        let model = EventLogModel()
        model.kinds = [.keypad]
        model.user = .account("owner")
        model.ascending = true
        await model.reload(client: server.client)
        #expect(query.value["types"] == "control")
        #expect(query.value["user"] == "owner")
        #expect(query.value["order"] == "asc")
    }

    @Test("asks for nothing with every kind turned off")
    func noKinds() async {
        let server = StubServer { _, _, _ in .ok(#"{"events":[],"next":null}"#) }
        let model = EventLogModel()
        model.kinds = []
        await model.reload(client: server.client)
        #expect(model.reachedEnd)
        #expect(server.requests.isEmpty)
    }

    @Test("shows the server's error and the accounts that did things")
    func errorsAndUsers() async {
        let server = StubServer { _, path, _ in
            path == "events/users" ? .ok(#"["owner","operator"]"#) : .status(500, message: "no database")
        }
        let model = EventLogModel()
        await model.reload(client: server.client)
        #expect(model.errorMessage == "No database")
        await model.loadUsers(client: server.client)
        #expect(model.users == ["owner", "operator"])
    }
}

@Suite("Panel")
struct PanelTests {
    private let display = #"{"lines":["  Pool Temp 81_F   ",""],"blinking":[[],[]],"timestamp":"2026-11-07T22:00:00.000Z"}"#

    @Test("shows the display, or says the panel hasn't sent one")
    func display() async {
        let sent = Shared(false)
        let text = display
        let server = StubServer { _, _, _ in sent.value ? .ok(text) : .status(404) }
        let model = PanelModel()
        await model.refresh(client: server.client)
        #expect(model.display == nil)
        #expect(model.errorMessage == "The panel hasn’t sent any display text yet.")
        #expect(model.isReachable)

        sent.value = true
        await model.refresh(client: server.client)
        #expect(model.display?.lines.first?.contains("Pool Temp") == true)
        #expect(model.errorMessage == nil)
    }

    @Test("marks a key queued once the server takes it")
    func pressQueued() async {
        let text = display
        let server = StubServer { method, _, _ in method == "PUT" ? .ok(#"{"key":"menu"}"#) : .ok(text) }
        let model = PanelModel()
        let auth = server.makeStore(credentials: InMemoryCredentialStore(Credentials(name: "operator", token: "token", role: .user))).auth
        await model.press(.menu, auth: auth)
        #expect(model.recentPresses.map(\.delivery) == [.queued])
        #expect(model.pressCount == 1)
        #expect(server.requests.contains("PUT panel/keys/menu"))
    }

    @Test("marks a key failed when the sign-in has expired, signing out, and keeps only the last few")
    func pressFailed() async {
        let server = StubServer { _, _, _ in .status(401) }
        let model = PanelModel()
        let auth = server.makeStore(credentials: InMemoryCredentialStore(Credentials(name: "operator", token: "expired", role: .user))).auth
        await model.press(.plus, auth: auth)
        #expect(model.errorMessage == "Your sign-in is no longer valid. Sign in again to use the panel keys.")
        #expect(auth.credentials == nil)

        for _ in 0..<(PanelModel.recentPressLimit + 1) {
            await model.press(.plus, auth: auth)
        }
        #expect(model.recentPresses.count == PanelModel.recentPressLimit)
        #expect(model.recentPresses.allSatisfy { $0.delivery == .failed })
        #expect(server.requests.count == 1, "nothing more is sent once signed out")
    }

    @Test("notices the server going away")
    func unreachable() async {
        let server = StubServer { _, _, _ in .fail(.timedOut) }
        let model = PanelModel()
        await model.refresh(client: server.client)
        #expect(!model.isReachable)
    }

    @Test("labels keys the way the panel prints them")
    func labels() {
        #expect(PanelKey.allCases.map(\.label) == ["Menu", "<", ">", "−", "+"])
        #expect(PanelKey.minus.title == "Minus")
    }
}

@Suite("Temperature history")
struct HistoryTests {
    private let start = try! Date.ISO8601FormatStyle().parse("2026-11-07T00:00:00Z")
    private func at(_ hour: Int) -> Date { start.addingTimeInterval(Double(hour) * 3600) }
    private func iso(_ hour: Int) -> String { at(hour).formatted(.iso8601) }

    /// The filter runs 1:00-5:00 and the heater fires 2:00-4:00; the pool warms meanwhile.
    private func history() -> String {
        func series(_ name: String, _ points: [(Int, Double)]) -> String {
            let list = points.map { #"{"t":"\#(iso($0.0))","v":\#($0.1)}"# }.joined(separator: ",")
            return #"{"name":"\#(name)","before":null,"points":[\#(list)]}"#
        }
        let all = [
            series("pool temp", [(1, 78), (3, 80), (5, 82)]),
            series("filter", [(1, 1), (5, 0)]),
            series("heater1", [(2, 1), (4, 0)]),
            series("ambient", [(0, 60)])
        ]
        return #"{"from":"\#(iso(0))","to":"\#(iso(6))","earliest":"\#(iso(0))","series":[\#(all.joined(separator: ","))]}"#
    }

    @Test("shades heating and draws the water only while its pump runs")
    func intervals() async {
        let body = history()
        let server = StubServer { _, path, _ in path == "history" ? .ok(body) : .status(404) }
        let model = TemperatureHistoryModel(water: .pool)
        await model.ensureLoaded(at(0)...at(6), client: server.client)

        #expect(model.errorMessage == nil)
        #expect(model.earliest == at(0))
        let heating = model.heatingIntervals(from: .heater, through: at(6))
        #expect(heating.map(\.start) == [at(2)])
        #expect(heating.map(\.end) == [at(4)])

        let segments = model.waterSegments(through: at(6))
        #expect(segments.count == 1)
        #expect(segments.first?.samples.first?.date == at(1))
        #expect(segments.first?.samples.last?.date == at(5))
        #expect(model.airSegment(through: at(6)).last?.date == at(6), "air is carried to the end")
    }

    @Test("waits for a fetch under way instead of fetching the same window again")
    func overlapping() async {
        let body = history()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        async let first: Void = model.ensureLoaded(at(0)...at(6), client: server.client)
        async let second: Void = model.ensureLoaded(at(0)...at(6), client: server.client)
        _ = await (first, second)
        #expect(server.requests.count == 1)
        #expect(!model.isLoading)
    }

    @Test("keeps the graph's lines until the data changes")
    func chartCache() async {
        let body = history()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        let empty = model.chartData(through: at(6))
        #expect(empty.water.isEmpty)
        await model.ensureLoaded(at(0)...at(6), client: server.client)
        let data = model.chartData(through: at(6))
        #expect(data.water.count == 1, "new data replaces what was kept")
        #expect(data.heater.map(\.start) == [at(2)])
    }

    @Test("doesn't ask again for a window it already has")
    func caches() async {
        let body = history()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        await model.ensureLoaded(at(0)...at(6), client: server.client)
        await model.ensureLoaded(at(1)...at(5), client: server.client)
        #expect(server.requests.count == 1)
        await model.ensureLoaded(at(0)...at(8), client: server.client)
        #expect(server.requests.count == 2, "only the part after 6:00 is fetched")
    }

    @Test("reports a failed fetch")
    func failure() async {
        let server = StubServer { _, _, _ in .status(400, message: "from must be earlier than to") }
        let model = TemperatureHistoryModel(water: .spa)
        await model.ensureLoaded(at(0)...at(1), client: server.client)
        #expect(model.errorMessage == "From must be earlier than to")
    }
}

@Suite("Network scan")
struct ScanTests {
    @Test("finds only the addresses that identify as a pool server")
    func scans() async throws {
        let info = #"{"service":"pool-controller","version":"1.2.3","startedAt":"2026-11-07T22:00:00.000Z"}"#
        StubURLProtocol.register(host: "192.0.2.1") { _, path, _ in path == "system/info" ? .ok(info) : .status(404) }
        StubURLProtocol.register(host: "192.0.2.2") { _, _, _ in .ok(#"{"service":"something-else","version":"1","startedAt":"2026-11-07T22:00:00.000Z"}"#) }
        StubURLProtocol.register(host: "localhost") { _, _, _ in .fail(.cannotConnectToHost) }

        let scanner = NetworkScanner(session: StubURLProtocol.session)
        scanner.scan(try #require(IPv4Network("192.0.2.0/30")), port: 3000, timeout: 1)
        #expect(scanner.isScanning)
        await scanner.waitUntilFinished()
        #expect(!scanner.isScanning)

        #expect(scanner.found.map(\.address) == ["192.0.2.1:3000"])
        #expect(scanner.found.first?.version == "1.2.3")
        #expect(scanner.checked == scanner.total)
        #expect(!scanner.wasStopped)
    }

    @Test("stops when asked, keeping the count where it was")
    func stops() async throws {
        let scanner = NetworkScanner(session: StubURLProtocol.session)
        StubURLProtocol.register(host: "localhost") { _, _, _ in .fail(.cannotConnectToHost) }
        scanner.scan(try #require(IPv4Network("198.51.100.0/24")), port: 3000, timeout: 5)
        scanner.stop()
        let checked = scanner.checked
        await scanner.waitUntilFinished()
        #expect(scanner.wasStopped)
        #expect(!scanner.isScanning)
        #expect(scanner.checked == checked)
    }
}
