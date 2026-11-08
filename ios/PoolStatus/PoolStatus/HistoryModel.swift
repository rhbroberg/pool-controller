import Foundation
import Observation

/// `GET /history`: readings are stored when they change, so `before` is each series' value
/// as the window opens.
nonisolated struct HistoryResponse: Decodable, Sendable {
    struct Point: Decodable {
        let date: Date
        /// Nil where the reading was missing.
        let value: Double?

        private enum CodingKeys: String, CodingKey {
            case date = "t", value = "v"
        }
    }

    struct Series: Decodable {
        let name: ReadingName
        let before: Point?
        let points: [Point]
    }

    let from: Date
    let to: Date
    let earliest: Date?
    let series: [Series]
}

/// One reading on a history graph.
struct HistorySample: Identifiable {
    let date: Date
    let value: Double
    var id: Date { date }
}

/// Temperature, air and heater history for one body of water, fetched a time window at a
/// time and kept, so only windows that haven't been seen are requested.
@Observable
final class TemperatureHistoryModel {
    struct Interval: Identifiable {
        let start: Date
        let end: Date
        var id: Date { start }
    }

    /// A stretch of line drawn without breaks.
    struct Segment: Identifiable {
        let id: Int
        let samples: [HistorySample]
    }

    /// Everything the graph draws, up to one time.
    struct ChartData {
        let water: [Segment]
        let air: [HistorySample]
        let heater: [Interval]
        let heatPump: [Interval]
    }

    let water: WaterBody

    private(set) var earliest: Date?
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// The latest time covered by fetched data.
    private(set) var loadedThrough: Date?
    /// Counts merged responses, so the graph is redrawn from new data.
    private(set) var revision = 0

    private var values: [ReadingName: [Date: Double]] = [:]
    private var sorted: [ReadingName: [HistorySample]] = [:]
    private var loaded: [ClosedRange<Date>] = []
    /// The fetch under way; another waits for it rather than fetching the same window.
    @ObservationIgnored private var fetching: Task<Void, Never>?
    /// The graph is redrawn for every touch while reading values off it, so its lines are kept
    /// until the data or the end time changes.
    @ObservationIgnored private var chartCache: (end: Date, revision: Int, data: ChartData)?

    init(water: WaterBody) {
        self.water = water
    }

    private var names: [ReadingName] {
        [water.temperatureName, .airTemperature, .heater, .heatPump, .filter] + Self.circulationNames
    }

    func samples(_ name: ReadingName) -> [HistorySample] {
        sorted[name] ?? []
    }

    var waterSamples: [HistorySample] { samples(water.temperatureName) }
    var airSamples: [HistorySample] { samples(.airTemperature) }

    // MARK: - Loading

    /// Fetches whatever part of `range` hasn't been fetched yet, after any fetch already under way.
    func ensureLoaded(_ range: ClosedRange<Date>, client: StatusClient) async {
        while let running = fetching {
            await running.value
            if Task.isCancelled {
                return
            }
        }
        let gaps = missing(from: range)
        guard !gaps.isEmpty else {
            return
        }
        let fetch = Task {
            await self.fetch(gaps, client: client)
            self.fetching = nil
            self.isLoading = false
        }
        fetching = fetch
        isLoading = true
        await withTaskCancellationHandler {
            await fetch.value
        } onCancel: {
            fetch.cancel()
        }
    }

    private func fetch(_ gaps: [ClosedRange<Date>], client: StatusClient) async {
        for gap in gaps {
            do {
                let response = try await client.fetchHistory(names: names, from: gap.lowerBound, to: gap.upperBound)
                merge(response)
                record(gap)
                errorMessage = nil
            } catch {
                if !error.isCancellation {
                    errorMessage = error.localizedDescription
                }
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
                if let value = point.value {
                    known[point.date] = value
                }
            }
            values[series.name] = known
            sorted[series.name] = known.map { HistorySample(date: $0.key, value: $0.value) }.sorted { $0.date < $1.date }
        }
        revision += 1
    }

    // MARK: - Chart data

    func chartData(through end: Date) -> ChartData {
        if let chartCache, chartCache.end == end, chartCache.revision == revision {
            return chartCache.data
        }
        let data = ChartData(water: waterSegments(through: end),
                             air: airSegment(through: end),
                             heater: heatingIntervals(from: .heater, through: end),
                             heatPump: heatingIntervals(from: .heatPump, through: end))
        chartCache = (end, revision, data)
        return data
    }

    /// Times `source` (the heater or the heat pump) was warming this body of water, ending no
    /// later than `end`. The two are in series, so both send their heat to the same place.
    func heatingIntervals(from source: ReadingName, through end: Date) -> [Interval] {
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
        let pump = water.pump
        guard !samples(pump).isEmpty else {
            return [Segment(id: 0, samples: extended(readings, to: end))]
        }
        let running = intervals([pump], through: end) { $0[pump] == true }
        return running.enumerated().compactMap { index, interval in
            let inside = readings.filter { $0.date >= interval.start && $0.date <= interval.end }
            return inside.isEmpty ? nil : Segment(id: index, samples: extended(inside, to: interval.end))
        }
    }

    /// The switches that decide where water, and so heat, goes.
    private static let circulationNames: [ReadingName] = [.spaFilter, .spa, .spillover]

    /// Heat reaches both bodies in spillover; otherwise the spa while water flows through it
    /// (spa mode or the spa filter), and the pool the rest of the time.
    private func heats(_ state: [ReadingName: Bool]) -> Bool {
        if state[.spillover] == true {
            return true
        }
        let toSpa = state[.spa] == true || state[.spaFilter] == true
        return water == .spa ? toSpa : !toSpa
    }

    /// The stretches of time `condition` held, replaying every change to the switches in `names`.
    private func intervals(_ names: [ReadingName], through end: Date,
                           where condition: ([ReadingName: Bool]) -> Bool) -> [Interval] {
        let changes = names
            .flatMap { name in samples(name).map { (date: $0.date, name: name, on: $0.value != 0) } }
            .filter { $0.date <= end }
            .sorted { $0.date < $1.date }

        var state: [ReadingName: Bool] = [:]
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

    func airSegment(through end: Date) -> [HistorySample] {
        let readings = airSamples.filter { $0.date <= end }
        return readings.isEmpty ? [] : extended(readings, to: end)
    }

    private func extended(_ readings: [HistorySample], to end: Date) -> [HistorySample] {
        var line = readings
        if let last = line.last, last.date < end {
            line.append(HistorySample(date: end, value: last.value))
        }
        return line
    }
}

/// Salt level for one time window, from `GET /history`.
@Observable
final class SaltHistoryModel {
    private(set) var samples: [HistorySample] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    func load(from start: Date, to end: Date, client: StatusClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await client.fetchHistory(names: [.salt], from: start, to: end)
            let series = response.series.first { $0.name == .salt }
            let points = (series?.before.map { [$0] } ?? []) + (series?.points ?? [])
            var loaded = points.compactMap { point in
                point.value.map { HistorySample(date: max(point.date, start), value: $0) }
            }
            // readings are stored when they change, so the last one holds until now
            if let last = loaded.last, last.date < end {
                loaded.append(HistorySample(date: end, value: last.value))
            }
            samples = loaded
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }
}
