import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Heating estimates")
struct HeatingEstimateTests {
    nonisolated private static func estimate(status: String = "ready", display: String = "remaining", minutes: Int? = 80,
                                 readyAt: String? = "2026-11-10T20:45:00.000Z", reachesAtMost: Double? = nil,
                                 settling: Bool? = nil, basis: String? = nil, ruleSources: [String] = []) -> String {
        let minutesJSON = minutes.map(String.init) ?? "null"
        let readyJSON = readyAt.map { "\"\($0)\"" } ?? "null"
        let mostJSON = reachesAtMost.map { String($0) } ?? "null"
        let settlingJSON = settling.map { #""settling":\#($0),"# } ?? ""
        let sourcesJSON = ruleSources.map { "\"\($0)\"" }.joined(separator: ",")
        let basisJSON = basis.map { #""basis":"\#($0)","ruleSources":[\#(sourcesJSON)],"# } ?? ""
        return #"{"status":"\#(status)",\#(settlingJSON)\#(basisJSON)"body":"pool","temperature":78,"setpoint":84,"airTemperature":70,"minutes":\#(minutesJSON),"readyAt":\#(readyJSON),"reachesAtMost":\#(mostJSON),"sources":["heater1"],"rate":{"net":1.1,"heater":1.2,"heatPump":null,"solar":0.2,"loss":-0.3},"model":{"calculatedAt":"2026-11-01T12:00:00.000Z","windows":412,"rSquared":0.62,"rmse":0.33,"airRange":[38,99],"notes":["a note"]},"display":"\#(display)","timeZone":"America/New_York"}"#
    }

    nonisolated private static func heating(estimate: String?) -> String {
        let base = Fixture.heating()
        guard let estimate else {
            return base
        }
        let closing = base.lastIndex(of: "}")!
        return base[..<closing] + #","estimate":\#(estimate)}"#
    }

    nonisolated private static func decoded(_ json: String) throws -> HeatingEstimate {
        try StatusClient.decoder.decode(HeatingEstimate.self, from: Data(json.utf8))
    }

    nonisolated private static let now = try! Date.ISO8601FormatStyle().parse("2026-11-10T17:00:00Z")

    @Test("is part of the heating status, and absent from a server that doesn't estimate")
    func decodes() throws {
        let with = try StatusClient.decoder.decode(HeatingStatus.self, from: Data(Self.heating(estimate: Self.estimate()).utf8))
        let estimate = try #require(with.estimate)
        #expect(estimate.status == .ready)
        #expect(estimate.body == .pool)
        #expect(estimate.minutes == 80)
        #expect(estimate.setpoint == 84)
        #expect(estimate.sources == ["heater1"])
        #expect(estimate.rate?.heater == 1.2)
        #expect(estimate.rate?.heatPump == nil)
        #expect(estimate.model?.windows == 412)
        #expect(estimate.display == .remaining)
        #expect(with.setpoint(.heater1, for: .pool) == 84, "the setpoints are still read")

        #expect(try StatusClient.decoder.decode(HeatingStatus.self, from: Data(Fixture.heating().utf8)).estimate == nil)
        #expect(try StatusClient.decoder.decode(HeatingStatus.self, from: Data(Self.heating(estimate: "null").utf8)).estimate == nil)
    }

    @Test("an estimate this app can't read doesn't hide the setpoints")
    func unreadable() throws {
        let heating = try StatusClient.decoder.decode(HeatingStatus.self, from: Data(Self.heating(estimate: Self.estimate(status: "someNewStatus")).utf8))
        #expect(heating.estimate == nil)
        #expect(heating.target == .pool)
        #expect(heating.setpoint(.heatpump, for: .spa) == 100)
    }

    @Test("says the time left in hours and minutes")
    func durations() {
        #expect(HeatingEstimate.duration(minutes: 0) == "under a minute")
        #expect(HeatingEstimate.duration(minutes: 5) == "5 min")
        #expect(HeatingEstimate.duration(minutes: 60) == "1 h")
        #expect(HeatingEstimate.duration(minutes: 80) == "1 h 20 min")
        #expect(HeatingEstimate.duration(minutes: 26 * 60 + 10) == "1 d 2 h")
    }

    @Test("shows the time left, or the time it will be ready, as the server is set to")
    func summaries() throws {
        #expect(try Self.decoded(Self.estimate()).summary(now: Self.now) == "Pool ready in 1 h 20 min")
        let readyAt = try #require(try Self.decoded(Self.estimate(display: "readyAt")).summary(now: Self.now))
        #expect(readyAt.hasPrefix("Pool ready about "))
        #expect(readyAt.contains("3:45"), "20:45 UTC is 3:45 PM in New York: \(readyAt)")
    }

    @Test("shows the time straight away while the water settles, marked as settling")
    func settling() throws {
        let remaining = try Self.decoded(Self.estimate(settling: true))
        #expect(remaining.isSettling)
        #expect(remaining.isShown)
        #expect(remaining.summary(now: Self.now) == "Pool ready in about 1 h 20 min, settling…")
        #expect(remaining.explanation.contains("may change once it settles"))

        let readyAt = try #require(try Self.decoded(Self.estimate(display: "readyAt", settling: true)).summary(now: Self.now))
        #expect(readyAt.hasPrefix("Pool ready about "))
        #expect(readyAt.hasSuffix(", settling…"))

        let cold = try Self.decoded(Self.estimate(status: "unreachable", minutes: nil, readyAt: nil, reachesAtMost: 81.4, settling: true))
        #expect(cold.summary(now: Self.now) == "Pool may not reach 84°, settling…")

        let settled = try Self.decoded(Self.estimate(settling: false))
        #expect(!settled.isSettling)
        #expect(settled.summary(now: Self.now) == "Pool ready in 1 h 20 min")
        #expect(!settled.explanation.contains("settles"))
    }

    @Test("puts the day with a ready time that isn't today, in the server's time zone")
    func readyTime() throws {
        let sameDay = try Self.decoded(Self.estimate(display: "readyAt"))
        // 17:00 UTC on the 10th is noon in New York, the same day as 3:45 PM
        #expect(try #require(sameDay.readyText(now: Self.now)).contains("3:45"))
        #expect(!(try #require(sameDay.readyText(now: Self.now))).contains("Tue"))
        let later = try Self.decoded(Self.estimate(display: "readyAt", readyAt: "2026-11-12T03:30:00.000Z"))
        // 03:30 UTC on the 12th is 10:30 PM on Wednesday the 11th in New York
        let text = try #require(later.readyText(now: Self.now))
        #expect(text.contains("Wed"))
        #expect(text.contains("10:30"))
    }

    @Test("says so when the weather is too cold, or the water hasn't settled, and stays quiet when it can't tell")
    func otherStatuses() throws {
        let cold = try Self.decoded(Self.estimate(status: "unreachable", minutes: nil, readyAt: nil, reachesAtMost: 81.4))
        #expect(cold.summary(now: Self.now) == "Pool won’t reach 84° in this weather")
        #expect(cold.explanation.contains("81"))
        let olderServerSettling = try Self.decoded(Self.estimate(status: "settling", minutes: nil, readyAt: nil))
        #expect(olderServerSettling.summary(now: Self.now) == "Pool: estimating…")
        #expect(olderServerSettling.isSettling)
        for status in ["noModel", "noReading", "insufficientData"] {
            let quiet = try Self.decoded(Self.estimate(status: status, minutes: nil, readyAt: nil))
            #expect(quiet.summary(now: Self.now) == nil)
            #expect(!quiet.isShown)
            #expect(!quiet.explanation.isEmpty)
        }
        #expect(try Self.decoded(Self.estimate()).isShown)
    }

    @Test("says when a heating rule timed it, in whole or in part")
    func byRule() throws {
        let learned = try Self.decoded(Self.estimate(basis: "history"))
        #expect(learned.basis == .history)
        #expect(learned.summary(now: Self.now) == "Pool ready in 1 h 20 min")
        #expect(learned.explanation == "Worked out from how this pool has warmed in the past.")

        let ruled = try Self.decoded(Self.estimate(basis: "rule", ruleSources: ["heater1"]))
        #expect(ruled.summary(now: Self.now) == "Pool ready in 1 h 20 min (by rule)")
        #expect(ruled.explanation.contains("timed by the heating rules"))
        #expect(ruled.explanation.contains("Server Maintenance › Heating Estimates"))

        let mixed = try Self.decoded(Self.estimate(basis: "mixed", ruleSources: ["heater1"]))
        #expect(mixed.summary(now: Self.now) == "Pool ready in 1 h 20 min (partly by rule)")
        #expect(mixed.explanation.contains("except the heater’s rate"))

        let settlingByRule = try Self.decoded(Self.estimate(settling: true, basis: "rule", ruleSources: ["heater1"]))
        #expect(settlingByRule.summary(now: Self.now) == "Pool ready in about 1 h 20 min, settling… (by rule)")
        #expect(try Self.decoded(Self.estimate()).basis == nil, "an older server says nothing about it")
    }

    @Test("the heating rules are read, and one is changed, through the settings")
    func rules() throws {
        let settings = #"{"timeZone":"UTC","timeZoneSource":"system","detectedTimeZone":"UTC","rawRetentionDays":365,"minimumRetentionDays":7,"maximumRetentionDays":3650,"location":null,"heatingRules":{"pool":{"heater":1,"heatPump":0.5},"spa":{"heater":20,"heatPump":4}},"preheatMarginMinutes":15}"#
        let decoded = try StatusClient.decoder.decode(ServerSettings.self, from: Data(settings.utf8))
        let rules = try #require(decoded.heatingRules)
        #expect(rules.rate(.heater1, for: .spa) == 20)
        #expect(rules.rate(.heatpump, for: .pool) == 0.5)
        #expect(decoded.preheatMarginMinutes == 15)

        let change = ServerSettings.Changes(heatingRule: HeatingRuleChange(body: .spa, device: .heatpump, rate: 6))
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(change)) as? [String: Any]
        #expect((sent?["heatingRules"] as? [String: [String: Double]]) == ["spa": ["heatPump": 6]])
        #expect(sent?.count == 1, "nothing else changes")
    }

    @Test("says for each source whether history taught its rate or a rule stands in, and why")
    func ruleBasis() throws {
        #expect(HeatingRules.basis(of: .heater1, for: .pool, in: nil) == .rule(why: "No model has been saved yet."))

        let json = #"{"id":"m1","createdAt":"2026-11-12T02:18:39.407Z","createdBy":"rick","range":{"from":"2019-06-06T17:34:18.937Z","to":"2026-01-01T00:00:00.000Z"},"timeZone":"America/New_York","bodies":{"pool":{"available":true,"heater":null,"heatPump":{"base":0.55,"slope":0,"referenceAirTemperature":60,"minimumAirTemperature":null},"loss":0.012,"solar":0.41},"spa":{"available":false,"reason":"needs at least 5 windows; has 1"}}}"#
        let model = try StatusClient.decoder.decode(HeatingModel.self, from: Data(json.utf8))
        #expect(HeatingRules.basis(of: .heatpump, for: .pool, in: model) == .learned(perHour: 0.55))
        #expect(HeatingRules.basis(of: .heater1, for: .pool, in: model) == .rule(why: "History doesn’t show the heater warming this water."))
        #expect(HeatingRules.basis(of: .heater1, for: .spa, in: model) == .rule(why: "Needs at least 5 windows; has 1."))
    }

    @Test("the server's display setting is read and changed through the settings")
    func displaySetting() async throws {
        let settings = #"{"timeZone":"America/New_York","timeZoneSource":"system","detectedTimeZone":"America/New_York","rawRetentionDays":365,"minimumRetentionDays":7,"maximumRetentionDays":3650,"location":null,"heatingEstimateDisplay":"readyAt"}"#
        let decoded = try StatusClient.decoder.decode(ServerSettings.self, from: Data(settings.utf8))
        #expect(decoded.heatingEstimateDisplay == .readyAt)
        let older = settings.replacingOccurrences(of: #","heatingEstimateDisplay":"readyAt""#, with: "")
        #expect(try StatusClient.decoder.decode(ServerSettings.self, from: Data(older.utf8)).heatingEstimateDisplay == nil)

        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ServerSettings.Changes(heatingEstimateDisplay: .remaining))) as? [String: Any]
        #expect(sent?["heatingEstimateDisplay"] as? String == "remaining")
        #expect(sent?.count == 1, "nothing else changes")
    }
}

@Suite("Heating estimates screen")
struct HeatingEstimatesModelTests {
    nonisolated private static let range = #"{"from":"2019-06-06T17:34:15.833Z","to":"2026-01-01T00:00:00.000Z"}"#

    nonisolated private static func body(heater: String = "1.2", available: Bool = true) -> String {
        available
            ? #"{"available":true,"heater":\#(heater),"heatPump":{"base":0.55,"slope":0.012,"referenceAirTemperature":60,"minimumAirTemperature":15.8},"loss":0.012,"solar":0.41,"windows":{"heater":3,"heatpump":330,"both":42,"cooling":951,"total":1326},"outliers":23,"rSquared":0.62,"rmse":0.34,"airRange":[37,104],"waterRange":[62,104],"notes":[]}"#
            : #"{"available":false,"reason":"needs at least 5 windows; has 1","windows":{"heater":0,"heatpump":0,"both":1,"cooling":0,"total":1}}"#
    }

    nonisolated private static func model(id: String = "m1", heater: String = "1.2") -> String {
        #"{"id":"\#(id)","createdAt":"2026-11-10T12:00:00.000Z","createdBy":"owner","range":\#(range),"timeZone":"America/New_York","bodies":{"pool":\#(body(heater: heater)),"spa":\#(body(available: false))}}"#
    }

    nonisolated private static func state(model saved: String? = nil) -> String {
        #"{"model":\#(saved ?? "null"),"defaultRange":\#(range)}"#
    }

    nonisolated private static func scan(_ state: String = "finished", id: String = "scan-1") -> String {
        #"{"id":"\#(id)","state":"\#(state)","from":"2019-06-06T17:34:15.833Z","to":"2026-01-01T00:00:00.000Z","requestedBy":"owner","requestedAt":"2026-11-10T12:00:00.000Z","startedAt":null,"finishedAt":null,"through":null,"scanned":165000,"gaps":488,"summary":{"windows":4,"suitable":3,"bodies":{"pool":{"heater":{"windows":1,"suitable":1,"hours":2},"heatpump":{"windows":1,"suitable":1,"hours":3},"both":{"windows":0,"suitable":0,"hours":0},"cooling":{"windows":2,"suitable":1,"hours":4}},"spa":{"heater":{"windows":0,"suitable":0,"hours":0}}},"reasons":[{"reason":"too few readings","count":1}]},"error":null}"#
    }

    nonisolated private static func window(_ id: String, _ sources: String, suitable: Bool = true, hours: Double = 2) -> String {
        #"{"id":"\#(id)","body":"pool","sources":"\#(sources)","start":"2020-06-01T13:00:00.000Z","end":"2020-06-01T15:00:00.000Z","hours":\#(hours),"readings":9,"startTemperature":78,"endTemperature":80,"waterTemperature":79,"airTemperature":72,"sun":0.8,"slope":0.9,"scatter":0.3,"suitable":\#(suitable),"reason":\#(suitable ? "null" : "\"too few readings\"")}"#
    }

    nonisolated private static let windows = #"{"scanId":"scan-1","windows":[\#(window("pool:1", "heater")),\#(window("pool:2", "heatpump")),\#(window("pool:3", "cooling")),\#(window("pool:4", "cooling", suitable: false))]}"#

    nonisolated private static func preview(id: String = "preview-1", current: String? = nil, spa: Bool = false) -> String {
        #"{"previewId":"\#(id)","scanId":"scan-1","createdAt":"2026-11-10T12:05:00.000Z","range":\#(range),"timeZone":"America/New_York","windowsUsed":3,"excludedWindows":0,"sources":["heater","heatpump","both","cooling"],"bodies":{"pool":\#(body()),"spa":\#(body(available: spa))},"current":\#(current ?? "null"),"samples":[{"body":"pool","sources":"heatpump","from":74,"to":84,"airTemperature":80,"status":"ready","minutes":125},{"body":"pool","sources":"heater","from":74,"to":84,"airTemperature":50,"status":"unreachable","minutes":null}]}"#
    }

    private struct Harness {
        let server: StubServer
        let store: StatusStore
        let scans: Shared<[String]>
        let saved: Shared<String?>
    }

    /// A signed-in admin's store; `scans` are handed out in turn for each look at the scan.
    private func harness(scans: [String] = [Self.scan()], saved: String? = nil, previewReply: String = Self.preview(),
                         windowsFailing: Int = 0) async throws -> Harness {
        let looks = Shared(scans)
        let failing = Shared(windowsFailing)
        let kept = Shared<String?>(saved)
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"):
                return .ok(Fixture.login("owner", role: "admin"))
            case ("GET", "heating/model"):
                return .ok(Self.state(model: kept.value))
            case ("POST", "heating/model/scan"):
                return .json(202, Self.scan("waiting"))
            case ("GET", "heating/model/scan"):
                var next = ""
                looks.modify { remaining in
                    next = remaining.count > 1 ? remaining.removeFirst() : remaining.first ?? ""
                }
                return next.isEmpty ? .status(404, message: "no scan") : .ok(next)
            case ("GET", "heating/model/scan/windows"):
                var fail = false
                failing.modify { remaining in
                    if remaining > 0 {
                        remaining -= 1
                        fail = true
                    }
                }
                return fail ? .status(500, message: "try again") : .ok(Self.windows)
            case ("POST", "heating/model/preview"):
                return .ok(previewReply)
            case ("PUT", "heating/model"):
                kept.value = Self.model(id: "saved")
                return .ok(Self.state(model: kept.value))
            default:
                return .status(404)
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "owner", password: "owner-password")
        return Harness(server: server, store: store, scans: looks, saved: kept)
    }

    @Test("starts on the server's default range, all history before the simulator's, until edited")
    func defaultRange() async throws {
        let h = try await harness(scans: [])
        let model = HeatingEstimatesModel()
        await model.load(store: h.store)
        #expect(model.from == (try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse("2019-06-06T17:34:15.833Z")))
        #expect(model.to == (try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse("2026-01-01T00:00:00.000Z")))
        #expect(model.state?.model == nil)
        #expect(model.scan == nil)
        #expect(model.errorMessage == nil)

        let edited = HeatingEstimatesModel()
        edited.from = try Date.ISO8601FormatStyle().parse("2024-01-01T00:00:00Z")
        edited.rangeEdited()
        await edited.load(store: h.store)
        #expect(edited.from == (try Date.ISO8601FormatStyle().parse("2024-01-01T00:00:00Z")), "the admin's range stays")
    }

    @Test("finds windows, following the scan until it's done, then lists them")
    func finds() async throws {
        let h = try await harness(scans: [Self.scan("running"), Self.scan("running"), Self.scan()])
        let waits = Shared([Duration]())
        let model = HeatingEstimatesModel(sleep: { duration in waits.modify { $0.append(duration) } })
        await model.load(store: h.store)
        await model.find(store: h.store)
        #expect(model.scan?.state == .waiting)
        #expect(!model.canFind(isAdmin: true), "not while a scan goes on")
        await model.follow(store: h.store)
        #expect(model.scan?.state == .finished)
        #expect(waits.value == [HeatingEstimatesModel.pollInterval, HeatingEstimatesModel.pollInterval])
        #expect(model.windows.count == 4)
        #expect(model.bodiesWithWindows == [.pool])
        #expect(model.canFind(isAdmin: true))
        #expect(model.canCalculate(isAdmin: true))
        #expect(!model.canCalculate(isAdmin: false))
        #expect(HeatingEstimatesModel.stateText(try #require(model.scan)) == "Found 4 windows in 165,000 events")
        #expect(model.scan?.summary?.count(.pool, .cooling)?.suitable == 1)
    }

    @Test("a finished scan is only taken with its windows, so a failed or cancelled read is tried again")
    func windowsNotLostWithTheScan() async throws {
        let h = try await harness(scans: [Self.scan("running"), Self.scan()], windowsFailing: 1)
        let model = HeatingEstimatesModel(sleep: { _ in })
        await model.load(store: h.store)
        await model.find(store: h.store)
        await model.follow(store: h.store)
        #expect(model.scan?.state == .finished)
        #expect(model.windows.count == 4, "the windows came with the scan that finished")
        #expect(model.canCalculate(isAdmin: true))

        let failed = try await harness(scans: [Self.scan()], windowsFailing: 1)
        let other = HeatingEstimatesModel()
        await other.loadScan(store: failed.store)
        #expect(other.scan == nil, "not finished as far as the screen is concerned without the windows")
        #expect(!other.canCalculate(isAdmin: true))
        #expect(other.errorMessage != nil)
        await other.loadScan(store: failed.store)
        #expect(other.scan?.state == .finished)
        #expect(other.windows.count == 4)
        #expect(other.errorMessage == nil)
    }

    @Test("ticks the suitable windows, and turning off a kind or a window changes what is used")
    func selection() async throws {
        let h = try await harness()
        let model = HeatingEstimatesModel()
        await model.load(store: h.store)
        #expect(model.windows.count == 4, "an earlier finished scan's windows are read")
        let all = model.windows
        #expect(all.filter(model.isIncluded).map(\.id) == ["pool:1", "pool:2", "pool:3"], "the unsuitable one is never used")
        #expect(model.includedCount(.pool) == 3)
        #expect(model.detail(.pool, .cooling) == "1 of 1 windows · 2 hours")

        model.setIncluded(all[0], false)
        #expect(!model.isIncluded(all[0]))
        #expect(model.includedCount(.pool) == 2)
        model.setIncluded(all[3], true)
        #expect(!model.isIncluded(all[3]), "an unsuitable window can't be turned on")
        model.kinds.remove(.cooling)
        #expect(model.includedCount(.pool) == 1)
        model.kinds.insert(.cooling)
        model.setIncluded(all[0], true)
        #expect(model.includedCount(.pool) == 3)
    }

    @Test("calculates beside the model in use, and changing the selection clears the result")
    func calculates() async throws {
        let h = try await harness(saved: Self.model(), previewReply: Self.preview(current: Self.model()))
        let model = HeatingEstimatesModel()
        await model.load(store: h.store)
        await model.calculate(store: h.store)
        let preview = try #require(model.preview)
        #expect(preview.previewId == "preview-1")
        #expect(preview.bodies.pool?.heater == 1.2)
        #expect(preview.bodies.spa?.available == false)
        #expect(preview.current?.id == "m1")
        #expect(preview.canSave)
        #expect(preview.samples.count == 2)
        #expect(model.state?.model?.id == "m1", "the model in use is unchanged until saved")
        #expect(h.server.requests.contains("POST heating/model/preview"))
        #expect(!h.server.requests.contains("PUT heating/model"))

        model.setIncluded(model.windows[0], false)
        #expect(model.preview == nil, "the result no longer matches what is ticked")
        await model.calculate(store: h.store)
        model.discard()
        #expect(model.preview == nil)
        #expect(h.saved.value == Self.model())
    }

    @Test("sends the windows turned off and the kinds used")
    func request() throws {
        let request = HeatingModelRequest(scanId: "scan-1", excludeWindowIds: ["pool:1"], includeSources: [.heatpump, .cooling])
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        #expect(sent?["scanId"] as? String == "scan-1")
        #expect(sent?["excludeWindowIds"] as? [String] == ["pool:1"])
        #expect(sent?["includeSources"] as? [String] == ["heatpump", "cooling"])
        let range = try JSONSerialization.jsonObject(with: JSONEncoder().encode(HeatingScanRequest(
            from: try Date.ISO8601FormatStyle().parse("2020-07-19T04:00:00Z"),
            to: try Date.ISO8601FormatStyle().parse("2020-07-20T04:00:00Z")))) as? [String: Any]
        #expect(range?["from"] as? String == "2020-07-19T04:00:00.000Z")
    }

    @Test("saves exactly what was calculated, and the model in use becomes it")
    func saves() async throws {
        let h = try await harness()
        let model = HeatingEstimatesModel()
        await model.load(store: h.store)
        #expect(!model.canSave(isAdmin: true), "nothing calculated yet")
        await model.calculate(store: h.store)
        #expect(model.canSave(isAdmin: true))
        #expect(!model.canSave(isAdmin: false))
        await model.save(store: h.store)
        #expect(model.state?.model?.id == "saved")
        #expect(model.preview == nil)
        #expect(model.savedMessage == "Saved. Every estimate uses this model from now on.")
        #expect(h.server.requests.last == "PUT heating/model")
    }

    @Test("won't save a calculation with no body of water to learn from")
    func nothingToSave() async throws {
        let none = Self.preview().replacingOccurrences(of: Self.body(), with: Self.body(available: false))
        let h = try await harness(previewReply: none)
        let model = HeatingEstimatesModel()
        await model.load(store: h.store)
        await model.calculate(store: h.store)
        #expect(model.preview?.canSave == false)
        #expect(!model.canSave(isAdmin: true))
    }

    @Test("shows what the server said when it can't scan or calculate")
    func failures() async throws {
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): .ok(Fixture.login("owner", role: "admin"))
            case ("GET", "heating/model"): .ok(Self.state())
            case ("POST", "heating/model/scan"): .status(409, message: "history is already being scanned; wait for it to finish")
            case ("POST", "heating/model/preview"): .status(409, message: "there is no finished scan; find windows first")
            default: .status(404, message: "history hasn’t been scanned since the server started")
            }
        }
        let store = server.makeStore()
        try await store.auth.signIn(name: "owner", password: "owner-password")
        let model = HeatingEstimatesModel()
        await model.load(store: store)
        #expect(model.scan == nil)
        #expect(model.errorMessage == nil)
        await model.find(store: store)
        #expect(model.errorMessage == "History is already being scanned; wait for it to finish")
        #expect(!model.starting)
    }

    @Test("describes the model in plain lines, and what warming would take")
    func words() throws {
        let pool = try StatusClient.decoder.decode(HeatingBodyModel.self, from: Data(Self.body().utf8))
        let lines = HeatingEstimatesModel.lines(pool)
        #expect(lines.map(\.title) == ["Heater", "Heat Pump", "Full sun", "Heat lost to air"])
        #expect(lines[0].value == "1.20 °F/h")
        #expect(lines[1].value.contains("0.55 °F/h at 60° air"))
        #expect(lines[1].value.contains("0.012"))
        #expect(lines[3].value == "1.2% per hour")
        #expect(pool.quality == "Fair fit")

        let unknown = try StatusClient.decoder.decode(HeatingBodyModel.self, from: Data(Self.body(heater: "null").utf8))
        #expect(HeatingEstimatesModel.lines(unknown)[0].value == "not known")
        let spa = try StatusClient.decoder.decode(HeatingBodyModel.self, from: Data(Self.body(available: false).utf8))
        #expect(HeatingEstimatesModel.lines(spa)[0].value == "needs at least 5 windows; has 1")
        #expect(spa.quality == nil)

        let preview = try StatusClient.decoder.decode(HeatingModelPreview.self, from: Data(Self.preview().utf8))
        #expect(HeatingEstimatesModel.sampleText(preview.samples[0]) == "74° → 84° in 80° air: 2 h 5 min")
        #expect(HeatingEstimatesModel.sampleText(preview.samples[1]) == "74° → 84° in 50° air: out of reach")
    }
}
