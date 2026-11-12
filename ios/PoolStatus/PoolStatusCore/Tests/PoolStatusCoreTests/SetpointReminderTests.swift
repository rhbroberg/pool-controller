import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Setpoint reminder")
struct SetpointReminderTests {
    nonisolated private static let now = try! Date.ISO8601FormatStyle().parse("2026-11-10T17:00:00Z")

    /// The pool's heat pump with the water at `temperature` and its setpoint at 86, and the
    /// estimate the server would send with it.
    nonisolated private static func heating(temperature: Double = 80, calling: Bool = true, target: String? = "pool",
                                            status: String? = "ready", minutes: Int? = 90,
                                            readyAt: String? = "2026-11-10T18:30:00Z") -> HeatingStatus {
        let body = target.map { "\"\($0)\"" } ?? "null"
        let minutesJSON = minutes.map(String.init) ?? "null"
        let readyJSON = readyAt.map { "\"\($0)\"" } ?? "null"
        let estimate = status.map {
            #"{"status":"\#($0)","body":"pool","temperature":\#(temperature),"setpoint":86,"airTemperature":60,"minutes":\#(minutesJSON),"readyAt":\#(readyJSON),"reachesAtMost":null,"sources":["heatpump"],"rate":null,"model":null,"display":"remaining","timeZone":"UTC"}"#
        } ?? "null"
        let json = """
        {"units":"fahrenheit","target":\(body),"minimum":65,"maximum":104,"setpointsReachController":true,
         "setpoints":{"pool":{"heater1":84,"heatpump":86},"spa":{"heater1":102,"heatpump":100}},
         "devices":{
           "heater1":{"enabled":false,"heating":false,"callingForHeat":false,"body":\(body),"setpoint":84,"temperature":\(temperature)},
           "heatpump":{"enabled":true,"heating":\(calling),"callingForHeat":\(calling),"body":\(body),"setpoint":86,"temperature":\(temperature)}},
         "estimate":\(estimate)}
        """
        return try! StatusClient.decoder.decode(HeatingStatus.self, from: Data(json.utf8))
    }

    private let expected = SetpointReminder(body: .pool, setpoint: 86,
                                            date: try! Date.ISO8601FormatStyle().parse("2026-11-10T18:30:00Z"))

    @Test("is set for the time the estimate gives, and says which water and how warm")
    func schedules() {
        #expect(SetpointReminder.next(after: nil, heating: Self.heating(), now: Self.now) == .schedule(expected))
        #expect(expected.title == "Pool is warm")
        #expect(expected.expectedMessage == "The pool should be at 86° now.")
        #expect(expected.reachedMessage == "The pool reached 86°.")
    }

    @Test("moves when the estimate does, but not for a few seconds' difference")
    func moves() {
        #expect(SetpointReminder.next(after: expected, heating: Self.heating(readyAt: "2026-11-10T18:30:40Z"), now: Self.now) == .keep)
        let later = SetpointReminder(body: .pool, setpoint: 86, date: try! Date.ISO8601FormatStyle().parse("2026-11-10T19:00:00Z"))
        #expect(SetpointReminder.next(after: expected, heating: Self.heating(readyAt: "2026-11-10T19:00:00Z"), now: Self.now) == .schedule(later))
    }

    @Test("says so straight away when the water gets there before the estimate")
    func early() {
        let atSetpoint = Self.heating(temperature: 86, calling: false, status: nil)
        #expect(SetpointReminder.next(after: expected, heating: atSetpoint, now: Self.now) == .deliverNow(expected))
        #expect(SetpointReminder.next(after: nil, heating: atSetpoint, now: Self.now) == .keep, "nothing was waiting")
    }

    @Test("is withdrawn when the heating stops short of the setpoint")
    func withdrawn() {
        let pumpOff = Self.heating(target: nil, status: nil)
        #expect(SetpointReminder.next(after: expected, heating: pumpOff, now: Self.now) == .cancel)
        let heatPumpOff = Self.heating(temperature: 81, calling: false, status: nil)
        #expect(SetpointReminder.next(after: expected, heating: heatPumpOff, now: Self.now) == .cancel)
        let tooCold = Self.heating(status: "unreachable", minutes: nil, readyAt: nil)
        #expect(SetpointReminder.next(after: expected, heating: tooCold, now: Self.now) == .cancel)
    }

    @Test("waits out answers that can't tell, and a server that didn't answer")
    func waits() {
        #expect(SetpointReminder.next(after: expected, heating: nil, now: Self.now) == .keep)
        for status in ["insufficientData", "noReading", "settling"] {
            let unsure = Self.heating(status: status, minutes: nil, readyAt: nil)
            #expect(SetpointReminder.next(after: expected, heating: unsure, now: Self.now) == .keep, "\(status)")
        }
    }

    @Test("forgets one that has already been shown once the heating stops")
    func shown() {
        let afterwards = expected.date.addingTimeInterval(600)
        let atSetpoint = Self.heating(temperature: 86, calling: false, status: nil)
        #expect(SetpointReminder.next(after: expected, heating: atSetpoint, now: afterwards) == .cancel)
    }
}
