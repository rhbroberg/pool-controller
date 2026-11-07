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
    /// The heater warms whichever body is circulating; the spa circulates while its filter (aux14) runs.
    var heatsWhileSpaFilterRuns: Bool { self == .spa }
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
    static let spaFilterName = "aux14"

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
        [water.temperatureName, Self.airName, Self.heaterName, Self.spaFilterName]
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

    /// Times the heater was firing for this body of water, ending no later than `end`.
    func heatingIntervals(through end: Date) -> [Interval] {
        let heater = samples(Self.heaterName).map { (date: $0.date, heater: Optional($0.value != 0), spa: Bool?.none) }
        let spaFilter = samples(Self.spaFilterName).map { (date: $0.date, heater: Bool?.none, spa: Optional($0.value != 0)) }
        let changes = (heater + spaFilter).sorted { $0.date < $1.date }

        var intervals: [Interval] = []
        var heaterOn = false
        var spaOn = false
        var heatingSince: Date?
        for change in changes where change.date <= end {
            heaterOn = change.heater ?? heaterOn
            spaOn = change.spa ?? spaOn
            let heating = heaterOn && spaOn == water.heatsWhileSpaFilterRuns
            if heating, heatingSince == nil {
                heatingSince = change.date
            } else if !heating, let start = heatingSince {
                intervals.append(Interval(start: start, end: change.date))
                heatingSince = nil
            }
        }
        if let start = heatingSince {
            intervals.append(Interval(start: start, end: end))
        }
        return intervals
    }

    /// The water temperature line. Readings persist until they change, so each segment is
    /// carried to its end. The spa's line only covers times its filter ran and starts at that
    /// run's first reading, since a reading from an earlier run is stale.
    func waterSegments(through end: Date) -> [Segment] {
        let readings = waterSamples.filter { $0.date <= end }
        guard !readings.isEmpty else {
            return []
        }
        let spaFilter = samples(Self.spaFilterName)
        guard water == .spa, !spaFilter.isEmpty else {
            return [Segment(id: 0, samples: extended(readings, to: end))]
        }
        return runningIntervals(spaFilter, through: end).enumerated().compactMap { index, interval in
            let inside = readings.filter { $0.date >= interval.start && $0.date <= interval.end }
            return inside.isEmpty ? nil : Segment(id: index, samples: extended(inside, to: interval.end))
        }
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

    private func runningIntervals(_ switchSamples: [Sample], through end: Date) -> [Interval] {
        var intervals: [Interval] = []
        var since: Date?
        for sample in switchSamples where sample.date <= end {
            if sample.value != 0, since == nil {
                since = sample.date
            } else if sample.value == 0, let start = since {
                intervals.append(Interval(start: start, end: sample.date))
                since = nil
            }
        }
        if let start = since {
            intervals.append(Interval(start: start, end: end))
        }
        return intervals
    }
}
