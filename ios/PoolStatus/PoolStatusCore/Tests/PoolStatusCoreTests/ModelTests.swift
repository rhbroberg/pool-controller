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
    private func at(_ hour: Double) -> Date { start.addingTimeInterval(hour * 3600) }
    private func iso(_ hour: Double) -> String { at(hour).formatted(.iso8601) }
    private let level = 300

    private func point(_ hour: Double, _ value: Double, low: Double? = nil, high: Double? = nil) -> String {
        let range = low.map { #","min":\#($0),"max":\#(high ?? $0)"# } ?? ""
        return #"{"t":"\#(iso(hour))","v":\#(value)\#(range)}"#
    }

    private func series(_ name: String, resolution: Int = 0, _ points: [String]) -> String {
        #"{"name":"\#(name)","resolution":\#(resolution),"before":null,"points":[\#(points.joined(separator: ","))]}"#
    }

    private func response(_ series: [String]) -> String {
        #"{"from":"\#(iso(0))","to":"\#(iso(6))","timeZone":"UTC","earliest":"\#(iso(0))","series":[\#(series.joined(separator: ","))]}"#
    }

    /// Every reading as recorded: the filter runs 1:00-5:00 and the heater warms the pool 2:00-4:00.
    private func readings() -> String {
        response([
            series("pool temp", [point(1, 78), point(3, 80), point(5, 82)]),
            series("filter", [point(1, 1), point(5, 0)]),
            series("heating:pool:heater1", [point(2, 1), point(4, 0)]),
            series("ambient", [point(0, 60)])
        ])
    }

    /// Hourly buckets: the filter ran all of 1:00 and half of 2:00, the heater a quarter of 1:00.
    private func buckets() -> String {
        response([
            series("pool temp", resolution: 3600, [point(1, 79, low: 78, high: 80), point(2, 81, low: 80, high: 83)]),
            series("filter", resolution: 3600, [point(1, 1), point(2, 0.5), point(3, 0)]),
            series("heating:pool:heater1", resolution: 3600, [point(1, 0.25), point(2, 0)])
        ])
    }

    @Test("shades heating and draws the water only while its pump runs")
    func intervals() async {
        let body = readings()
        let server = StubServer { _, path, _ in path == "history" ? .ok(body) : .status(404) }
        let model = TemperatureHistoryModel(water: .pool)
        await model.ensureLoaded(at(0)...at(6), level: level, client: server.client)

        #expect(model.errorMessage == nil)
        #expect(model.earliest == at(0))
        let heating = model.heatingSpans(from: .heater, through: at(6), level: level)
        #expect(heating.map(\.start) == [at(2)])
        #expect(heating.map(\.end) == [at(4)])
        #expect(heating.map(\.intensity) == [1])

        let segments = model.waterSegments(through: at(6), level: level)
        #expect(segments.count == 1)
        #expect(segments.first?.samples.first?.date == at(1))
        #expect(segments.first?.samples.last?.date == at(5))
        #expect(model.airSegment(through: at(6), level: level).last?.date == at(6), "air is carried to the end")
    }

    @Test("asks for the graph's resolution, the points it needs and the heating series")
    func request() async {
        let query = Shared([String: String]())
        let body = readings()
        let server = StubServer { _, _, received in
            query.value = received
            return .ok(body)
        }
        let model = TemperatureHistoryModel(water: .spa)
        await model.ensureLoaded(at(0)...at(6), level: level, client: server.client)
        #expect(query.value["resolution"] == "300")
        #expect(query.value["maxPoints"] == String(HistoryResolution.points(for: 6 * 3600, level: level)))
        let names = Set((query.value["names"] ?? "").split(separator: ",").map(String.init))
        #expect(names == ["spa temp", "ambient", "aux14", "heating:spa:heater1", "heating:spa:valve4"])
    }

    @Test("draws buckets with their range, and heating by how much of each bucket it ran")
    func bucketed() async {
        let body = buckets()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        await model.ensureLoaded(at(0)...at(6), level: 3600, client: server.client)

        let data = model.chartData(through: at(6), level: 3600)
        #expect(data.resolution == 3600)
        #expect(data.water.count == 1, "the pump ran through both buckets")
        let first = data.water.first?.samples.first
        #expect(first?.low == 78)
        #expect(first?.high == 80)
        #expect(first?.isBucket == true)
        #expect(data.heater.map(\.intensity) == [0.25])
        #expect(data.heater.first?.end == at(2), "a bucket's share holds for the bucket")
    }

    @Test("keeps each resolution's readings apart and shows the coarser ones while finer ones load")
    func levels() async {
        let coarse = buckets()
        let fine = readings()
        let server = StubServer { _, _, query in .ok(query["resolution"] == "3600" ? coarse : fine) }
        let model = TemperatureHistoryModel(water: .pool)
        let visible = at(1)...at(5)
        await model.ensureLoaded(at(0)...at(6), level: 3600, client: server.client)
        #expect(model.displayLevel(for: level, visible: visible) == 3600, "nothing finer yet")

        await model.ensureLoaded(at(0)...at(6), level: level, client: server.client)
        #expect(model.displayLevel(for: level, visible: visible) == level)
        #expect(server.requests.count == 2)
        #expect(model.chartData(through: at(6), level: level).resolution == 0)
        #expect(model.chartData(through: at(6), level: 3600).resolution == 3600)
    }

    @Test("forgets the least recently used resolutions")
    func eviction() async {
        let body = readings()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        for level in [60, 300, 900, 3600, 86400] {
            await model.ensureLoaded(at(0)...at(6), level: level, client: server.client)
        }
        await model.ensureLoaded(at(0)...at(6), level: 86400, client: server.client)
        #expect(server.requests.count == 5)
        await model.ensureLoaded(at(0)...at(6), level: 60, client: server.client)
        #expect(server.requests.count == 6, "the oldest resolution was let go")
    }

    @Test("waits for a fetch under way instead of fetching the same window again")
    func overlapping() async {
        let body = readings()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        async let first: Void = model.ensureLoaded(at(0)...at(6), level: level, client: server.client)
        async let second: Void = model.ensureLoaded(at(0)...at(6), level: level, client: server.client)
        _ = await (first, second)
        #expect(server.requests.count == 1)
        #expect(!model.isLoading)
    }

    @Test("keeps the graph's lines until the data changes")
    func chartCache() async {
        let body = readings()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        let empty = model.chartData(through: at(6), level: level)
        #expect(empty.water.isEmpty)
        await model.ensureLoaded(at(0)...at(6), level: level, client: server.client)
        let data = model.chartData(through: at(6), level: level)
        #expect(data.water.count == 1, "new data replaces what was kept")
        #expect(data.heater.map(\.start) == [at(2)])
    }

    @Test("draws only what crosses the window, with the reading that holds into it")
    func clipped() async {
        let body = readings()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        await model.ensureLoaded(at(0)...at(6), level: level, client: server.client)

        let middle = model.chartData(through: at(6), level: level, within: at(3.5)...at(4.5))
        #expect(middle.water.first?.samples.map(\.date) == [at(3), at(5)])
        #expect(middle.air.map(\.date) == [at(0), at(6)], "the air reading at 0:00 holds into the window")
        #expect(middle.heater.map(\.start) == [at(2)])

        let late = model.chartData(through: at(6), level: level, within: at(5.5)...at(6))
        #expect(late.water.isEmpty, "the pump stopped at 5:00")
        #expect(late.heater.isEmpty)
        #expect(model.chartData(through: at(6), level: level).water.first?.samples.count == 3, "no window, every reading")
    }

    @Test("keeps the window still while scrolling within it, with a view's length to either side")
    func window() {
        let day: TimeInterval = 24 * 3600
        let window = HistoryWindow.around(at(30), visibleLength: day)
        #expect(window.lowerBound <= at(30 - 24))
        #expect(window.upperBound >= at(30 + 48))
        #expect(HistoryWindow.around(at(31), visibleLength: day) == window)
    }

    @Test("ticks the axis on calendar boundaries, about five to a view, whatever the history's length")
    func ticks() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let day: TimeInterval = 24 * 3600
        #expect(HistoryWindow.ticks(in: at(0)...at(24), visibleLength: day, calendar: calendar)
                == [at(0), at(6), at(12), at(18), at(24)])

        let date = { (text: String) in try! Date.ISO8601FormatStyle().parse(text) }
        #expect(HistoryWindow.ticks(in: date("2026-01-15T00:00:00Z")...date("2027-02-01T00:00:00Z"),
                                    visibleLength: 365 * day, calendar: calendar)
                == ["2026-04-01", "2026-07-01", "2026-10-01", "2027-01-01"].map { date("\($0)T00:00:00Z") })

        let window = HistoryWindow.around(at(0), visibleLength: day)
        #expect(HistoryWindow.ticks(in: window, visibleLength: day, calendar: calendar).count <= 25)
    }

    @Test("doesn't ask again for a window it already has at that resolution")
    func caches() async {
        let body = readings()
        let server = StubServer { _, _, _ in .ok(body) }
        let model = TemperatureHistoryModel(water: .pool)
        await model.ensureLoaded(at(0)...at(6), level: level, client: server.client)
        await model.ensureLoaded(at(1)...at(5), level: level, client: server.client)
        #expect(server.requests.count == 1)
        await model.ensureLoaded(at(0)...at(8), level: level, client: server.client)
        #expect(server.requests.count == 2, "only the part after 6:00 is fetched")
        #expect(model.loadedThrough(level: level) == at(8))
    }

    @Test("reports a failed fetch")
    func failure() async {
        let server = StubServer { _, _, _ in .status(400, message: "from must be earlier than to") }
        let model = TemperatureHistoryModel(water: .spa)
        await model.ensureLoaded(at(0)...at(1), level: level, client: server.client)
        #expect(model.errorMessage == "From must be earlier than to")
    }

    @Test("picks about one point per pixel")
    func resolution() {
        #expect(HistoryResolution.level(visibleLength: 24 * 3600, pixels: 1179) == 120)
        #expect(HistoryResolution.level(visibleLength: 365 * 24 * 3600, pixels: 1179) == 43200)
        #expect(HistoryResolution.level(visibleLength: 3600, pixels: 1179) == 60)
        #expect(HistoryResolution.points(for: 24 * 3600, level: 120) == 722)
        #expect(HistoryResolution.points(for: 10 * 365 * 24 * 3600, level: 60) == HistoryResolution.maxPoints)
    }
}

@Suite("Salt history")
struct SaltHistoryTests {
    @Test("asks for the graph's width in points and keeps each bucket's range")
    func buckets() async {
        let query = Shared([String: String]())
        let body = #"{"from":"2026-01-01T00:00:00Z","to":"2026-12-31T00:00:00Z","earliest":null,"series":[{"name":"salt","resolution":86400,"before":null,"points":[{"t":"2026-06-01T04:00:00Z","v":3150,"min":3100,"max":3200}]}]}"#
        let server = StubServer { _, _, received in
            query.value = received
            return .ok(body)
        }
        let model = SaltHistoryModel()
        let start = try! Date.ISO8601FormatStyle().parse("2026-01-01T00:00:00Z")
        let end = try! Date.ISO8601FormatStyle().parse("2026-12-31T00:00:00Z")
        await model.load(from: start, to: end, maxPoints: 390, client: server.client)
        #expect(query.value["maxPoints"] == "390")
        #expect(model.samples.first?.low == 3100)
        #expect(model.samples.first?.high == 3200)
        #expect(model.samples.last?.date == end, "the last level holds until the end")
    }
}

@Suite("History calendar")
struct CalendarTests {
    private let availability = #"{"timeZone":"America/New_York","earliest":"2026-10-02","days":[{"date":"2026-11-07","readings":42},{"date":"2026-10-15","readings":3}]}"#

    @Test("marks the days with water readings, in the server's time zone")
    func marks() async {
        let body = availability
        let server = StubServer { _, path, _ in path == "history/availability" ? .ok(body) : .status(404) }
        let model = HistoryCalendarModel(timeZone: TimeZone(identifier: "UTC")!)
        await model.load(around: DateComponents(year: 2026, month: 11), client: server.client)
        #expect(model.timeZone.identifier == "America/New_York")
        #expect(model.hasReadings(on: DateComponents(year: 2026, month: 11, day: 7)))
        #expect(model.readings(on: DateComponents(year: 2026, month: 10, day: 15)) == 3)
        #expect(!model.hasReadings(on: DateComponents(year: 2026, month: 11, day: 8)))
        #expect(model.earliest.map { model.calendar.dateComponents([.month, .day], from: $0) } == DateComponents(month: 10, day: 2))
    }

    @Test("asks for the spa temperature when the calendar is the spa's")
    func asksForOneTemperature() async {
        let query = Shared([String: String]())
        let body = availability
        let server = StubServer { _, path, received in
            if path == "history/availability" {
                query.value = received
            }
            return path == "history/availability" ? .ok(body) : .status(404)
        }
        let model = HistoryCalendarModel(names: [.spaTemperature], timeZone: TimeZone(identifier: "UTC")!)
        await model.load(around: DateComponents(year: 2026, month: 11), client: server.client)
        #expect(query.value["names"] == "spa temp")
    }

    @Test("asks for a month and its neighbors only once")
    func fetchesOnce() async {
        let body = availability
        let server = StubServer { _, _, _ in .ok(body) }
        let model = HistoryCalendarModel(timeZone: TimeZone(identifier: "America/New_York")!)
        await model.load(around: DateComponents(year: 2026, month: 10), client: server.client)
        await model.load(around: DateComponents(year: 2026, month: 10), client: server.client)
        #expect(server.requests.count == 1)
        await model.load(around: DateComponents(year: 2026, month: 6), client: server.client)
        #expect(server.requests.count == 2)
    }

    @Test("turns two picked days into the window from the first's midnight to the end of the last")
    func range() throws {
        let model = HistoryCalendarModel(timeZone: TimeZone(identifier: "America/New_York")!)
        let range = try #require(model.range(from: DateComponents(year: 2026, month: 11, day: 9),
                                             through: DateComponents(year: 2026, month: 11, day: 7)))
        #expect(range.lowerBound.formatted(.iso8601) == "2026-11-07T05:00:00Z")
        #expect(range.upperBound.formatted(.iso8601) == "2026-11-10T05:00:00Z")
        let days = model.days(in: range)
        #expect(days.map { $0.day } == [7, 8, 9])
        // a calendar view only matches selected days that carry their calendar and era
        #expect(days.allSatisfy { $0.calendar?.timeZone.identifier == "America/New_York" && $0.era != nil })
    }
}

@Suite("Server settings")
struct ServerSettingsTests {
    private func encoded(_ changes: ServerSettings.Changes) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return String(decoding: try encoder.encode(changes), as: UTF8.self)
    }

    @Test("sends only what changes, and null to follow the host's time zone")
    func encoding() throws {
        #expect(try encoded(.init(timeZone: .host)) == #"{"timeZone":null}"#)
        #expect(try encoded(.init(timeZone: .named("Europe/London"))) == #"{"timeZone":"Europe\/London"}"#)
        #expect(try encoded(.init(rawRetentionDays: 200)) == #"{"rawRetentionDays":200}"#)
    }

    @Test("sends a zip code, or null to stop fetching weather")
    func zipCode() throws {
        #expect(try encoded(.init(zipCode: .code("32801"))) == #"{"zipCode":"32801"}"#)
        #expect(try encoded(.init(zipCode: .clear)) == #"{"zipCode":null}"#)
    }

    @Test("knows a zip code when it sees one")
    func zipCodes() {
        #expect(ServerSettings.isZipCode("32801"))
        #expect(ServerSettings.isZipCode("32801-1234"))
        #expect(!ServerSettings.isZipCode("3280"))
        #expect(!ServerSettings.isZipCode("abcde"))
        #expect(!ServerSettings.isZipCode(""))
    }
}

@Suite("Weather")
struct WeatherTests {
    private func report(_ json: String) throws -> WeatherReport {
        try StatusClient.decoder.decode(WeatherReport.self, from: Data(json.utf8))
    }

    @Test("shows today's condition, high and low, and a real chance of rain")
    func summary() throws {
        let rainy = try #require(try report(Fixture.weather(high: 75, low: 60, condition: "rain", rain: 80, stale: true)).summary)
        #expect(rainy.title == "Rain")
        #expect(rainy.symbolName == "cloud.rain.fill")
        #expect(rainy.highLow == "75° / 60°")
        #expect(rainy.rainChance == 80)
        #expect(rainy.isStale)

        let sunny = try #require(try report(Fixture.weather()).summary)
        #expect(sunny.condition == .sunny)
        #expect(sunny.rainChance == nil, "a 10% chance isn't worth mentioning")
    }

    @Test("shows nothing without a zip code or before the first forecast")
    func nothing() throws {
        #expect(try report(#"{"configured":false,"location":null,"today":null,"fetchedAt":null,"stale":false}"#).summary == nil)
        #expect(try report(#"{"configured":true,"location":{"zipCode":"32801","placeName":"Orlando, FL"},"today":null,"fetchedAt":null,"stale":true}"#).summary == nil)
    }

    @Test("copes with a condition it doesn't know and a missing temperature")
    func unknown() throws {
        let json = #"{"configured":true,"location":null,"today":{"date":"2026-11-07","high":null,"low":60,"condition":"volcanic-ash"},"fetchedAt":null,"stale":false}"#
        let summary = try #require(try report(json).summary)
        #expect(summary.condition == nil)
        #expect(summary.highLow == "--° / 60°")
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

@Suite("About line")
struct AboutLineTests {
    private func info(_ json: String) throws -> SystemInfo {
        try StatusClient.decoder.decode(SystemInfo.self, from: Data(json.utf8))
    }

    @Test("names the app, server and API builds")
    func names() throws {
        let server = try info(#"{"service":"pool-controller","version":"1.0.0","apiVersion":"1.0.0","commit":"e4f5a6b-dirty","startedAt":"2026-11-07T22:00:00.000Z"}"#)
        #expect(SystemInfo.aboutLine(appCommit: "a1b2c3d", server: server) == "App a1b2c3d · Server e4f5a6b-dirty · API 1.0.0")
    }

    @Test("shows a dash for a build it doesn't know, as from an older server")
    func unknown() throws {
        let older = try info(#"{"service":"pool-controller","version":"1.0.0","startedAt":"2026-11-07T22:00:00.000Z"}"#)
        #expect(older.commit == nil && older.apiVersion == nil)
        #expect(SystemInfo.aboutLine(appCommit: "a1b2c3d", server: older) == "App a1b2c3d · Server — · API —")
        #expect(SystemInfo.aboutLine(appCommit: nil, server: nil) == "App — · Server — · API —")
    }
}
