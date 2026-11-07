import Foundation
import Observation

/// `GET /history`: readings are stored when they change, so `before` is each series' value
/// as the window opens.
struct HistoryResponse: Decodable {
    struct Point: Decodable {
        let t: Date
        let v: Double?
    }

    struct Series: Decodable {
        let name: String
        let before: Point?
        let points: [Point]
    }

    let from: Date
    let to: Date
    let earliest: Date?
    let series: [Series]
}

enum WaterBody: String, Identifiable {
    case pool, spa

    var id: String { rawValue }
    var title: String { self == .pool ? "Pool" : "Spa" }
    var temperatureName: String { self == .pool ? "pool temp" : "spa temp" }
}

/// Temperature, air and heater history for one body of water, fetched a time window at a
/// time and kept, so only windows that haven't been seen are requested.
@Observable
final class TemperatureHistoryModel {
    struct Sample: Identifiable {
        let date: Date
        let value: Double
        var id: Date { date }
    }

    struct Interval: Identifiable {
        let start: Date
        let end: Date
        var id: Date { start }
    }

    /// A stretch of line drawn without breaks.
    struct Segment: Identifiable {
        let id: Int
        let samples: [Sample]
    }

    static let airName = "ambient"
    static let heaterName = "heater1"
    static let heatPumpName = "valve4"
    static let spaFilterName = "aux14"
    static let poolPumpName = "filter"
    static let spaModeName = "spa"
    static let spilloverName = "spillover"

    let water: WaterBody

    private(set) var earliest: Date?
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// The latest time covered by fetched data.
    private(set) var loadedThrough: Date?

    private var values: [String: [Date: Double]] = [:]
    private var sorted: [String: [Sample]] = [:]
    private var loaded: [ClosedRange<Date>] = []

    init(water: WaterBody) {
        self.water = water
    }

    private var names: [String] {
        [water.temperatureName, Self.airName, Self.heaterName, Self.heatPumpName, Self.poolPumpName] + Self.circulationNames
    }

    func samples(_ name: String) -> [Sample] {
        sorted[name] ?? []
    }

    var waterSamples: [Sample] { samples(water.temperatureName) }
    var airSamples: [Sample] { samples(Self.airName) }

    // MARK: - Loading

    /// Fetches whatever part of `range` hasn't been fetched yet, after any fetch already under way.
    func ensureLoaded(_ range: ClosedRange<Date>, serverAddress: String) async {
        while isLoading {
            try? await Task.sleep(for: .milliseconds(100))
            if Task.isCancelled {
                return
            }
        }
        let gaps = missing(from: range)
        guard !gaps.isEmpty else {
            return
        }
        isLoading = true
        defer { isLoading = false }

        let client = StatusClient(serverAddress: serverAddress)
        for gap in gaps {
            do {
                let response = try await client.fetchHistory(names: names, from: gap.lowerBound, to: gap.upperBound)
                merge(response)
                record(gap)
                errorMessage = nil
            } catch is CancellationError {
                return
            } catch let error as URLError where error.code == .cancelled {
                return
            } catch {
                errorMessage = error.localizedDescription
                return
            }
        }
    }

    private func missing(from range: ClosedRange<Date>) -> [ClosedRange<Date>] {
        var gaps: [ClosedRange<Date>] = []
        var cursor = range.lowerBound
        for covered in loaded where covered.upperBound > cursor && covered.lowerBound < range.upperBound {
            if covered.lowerBound > cursor {
                gaps.append(cursor...covered.lowerBound)
            }
            cursor = max(cursor, covered.upperBound)
        }
        if cursor < range.upperBound {
            gaps.append(cursor...range.upperBound)
        }
        return gaps.filter { $0.upperBound.timeIntervalSince($0.lowerBound) >= 1 }
    }

    private func record(_ range: ClosedRange<Date>) {
        var merged: [ClosedRange<Date>] = []
        for next in (loaded + [range]).sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = merged.last, next.lowerBound <= last.upperBound {
                merged[merged.count - 1] = last.lowerBound...max(last.upperBound, next.upperBound)
            } else {
                merged.append(next)
            }
        }
        loaded = merged
        loadedThrough = merged.last?.upperBound
    }

    private func merge(_ response: HistoryResponse) {
        if let oldest = response.earliest {
            earliest = min(earliest ?? oldest, oldest)
        }
        for series in response.series {
            var known = values[series.name] ?? [:]
            for point in series.points + (series.before.map { [$0] } ?? []) {
                if let value = point.v {
                    known[point.t] = value
                }
            }
            values[series.name] = known
            sorted[series.name] = known.map { Sample(date: $0.key, value: $0.value) }.sorted { $0.date < $1.date }
        }
    }

    // MARK: - Chart data

    /// Times `source` (the heater or the heat pump) was warming this body of water, ending no
    /// later than `end`. The two are in series, so both send their heat to the same place.
    func heatingIntervals(from source: String, through end: Date) -> [Interval] {
        intervals([source] + Self.circulationNames, through: end) { state in
            (state[source] ?? false) && heats(state)
        }
    }

    /// The water temperature line. Readings persist until they change, so each segment is
    /// carried to its end. Each sensor sits just downstream of its pump, so the line only covers
    /// times that pump ran, starting at that run's first reading, since an earlier one is stale.
    func waterSegments(through end: Date) -> [Segment] {
        let readings = waterSamples.filter { $0.date <= end }
        guard !readings.isEmpty else {
            return []
        }
        guard !samples(pumpName).isEmpty else {
            return [Segment(id: 0, samples: extended(readings, to: end))]
        }
        let running = intervals([pumpName], through: end) { $0[pumpName] == true }
        return running.enumerated().compactMap { index, interval in
            let inside = readings.filter { $0.date >= interval.start && $0.date <= interval.end }
            return inside.isEmpty ? nil : Segment(id: index, samples: extended(inside, to: interval.end))
        }
    }

    /// The pump just upstream of this body's temperature sensor.
    private var pumpName: String {
        water == .pool ? Self.poolPumpName : Self.spaFilterName
    }

    /// The switches that decide where water, and so heat, goes.
    private static let circulationNames = [spaFilterName, spaModeName, spilloverName]

    /// Heat reaches both bodies in spillover; otherwise the spa while water flows through it
    /// (spa mode or the spa filter), and the pool the rest of the time.
    private func heats(_ state: [String: Bool]) -> Bool {
        if state[Self.spilloverName] == true {
            return true
        }
        let toSpa = state[Self.spaModeName] == true || state[Self.spaFilterName] == true
        return water == .spa ? toSpa : !toSpa
    }

    /// The stretches of time `condition` held, replaying every change to the switches in `names`.
    private func intervals(_ names: [String], through end: Date,
                           where condition: ([String: Bool]) -> Bool) -> [Interval] {
        let changes = names
            .flatMap { name in samples(name).map { (date: $0.date, name: name, on: $0.value != 0) } }
            .filter { $0.date <= end }
            .sorted { $0.date < $1.date }

        var state: [String: Bool] = [:]
        var result: [Interval] = []
        var since: Date?
        for change in changes {
            state[change.name] = change.on
            let holds = condition(state)
            if holds, since == nil {
                since = change.date
            } else if !holds, let start = since {
                result.append(Interval(start: start, end: change.date))
                since = nil
            }
        }
        if let start = since {
            result.append(Interval(start: start, end: end))
        }
        return result
    }

    func airSegment(through end: Date) -> [Sample] {
        let readings = airSamples.filter { $0.date <= end }
        return readings.isEmpty ? [] : extended(readings, to: end)
    }

    private func extended(_ readings: [Sample], to end: Date) -> [Sample] {
        var line = readings
        if let last = line.last, last.date < end {
            line.append(Sample(date: end, value: last.value))
        }
        return line
    }

}
