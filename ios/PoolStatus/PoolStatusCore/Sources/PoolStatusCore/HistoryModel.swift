import Foundation
import Observation

/// `GET /history`. Readings are stored when they change, so `before` is each series' value as
/// the window opens. A series with few enough readings has every one as recorded; otherwise one
/// point per bucket of `resolution` seconds: the average weighted by how long each value held,
/// with the bucket's lowest and highest.
public nonisolated struct HistoryResponse: Decodable, Sendable {
    public struct Point: Decodable, Sendable {
        public let date: Date
        /// Nil where the reading was missing.
        public let value: Double?
        public let low: Double?
        public let high: Double?

        private enum CodingKeys: String, CodingKey {
            case date = "t", value = "v", low = "min", high = "max"
        }
    }

    public struct Series: Decodable, Sendable {
        public let name: ReadingName
        /// Bucket length in seconds, or 0 for every reading as recorded.
        public let resolution: Int
        public let before: Point?
        public let points: [Point]

        private enum CodingKeys: String, CodingKey {
            case name, resolution, before, points
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            name = try container.decode(ReadingName.self, forKey: .name)
            resolution = try container.decodeIfPresent(Int.self, forKey: .resolution) ?? 0
            before = try container.decodeIfPresent(Point.self, forKey: .before)
            points = try container.decode([Point].self, forKey: .points)
        }
    }

    public let from: Date
    public let to: Date
    public let timeZone: String?
    public let earliest: Date?
    public let series: [Series]
}

/// The bucket lengths the server uses, and how a graph picks one.
public nonisolated enum HistoryResolution {
    /// In seconds, as the server has them.
    public static let ladder = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000]
    /// The most points the server sends for one series.
    public static let maxPoints = 5000

    /// About one point per pixel across a graph showing `visibleLength`.
    public static func level(visibleLength: TimeInterval, pixels: Double) -> Int {
        let wanted = visibleLength / max(pixels, 50)
        return ladder.first { Double($0) >= wanted } ?? ladder[ladder.count - 1]
    }

    /// The points a window `span` long needs at `level`, within the server's limit.
    public static func points(for span: TimeInterval, level: Int) -> Int {
        min(maxPoints, max(10, Int((span / Double(level)).rounded(.up)) + 2))
    }
}

/// One reading on a history graph, or one bucket of readings.
public struct HistorySample: Identifiable {
    public let date: Date
    public let value: Double
    /// A bucket's lowest and highest values; nil for a reading as recorded.
    public let low: Double?
    public let high: Double?
    /// A bucket's length; 0 for a reading, which holds until the next.
    public let span: TimeInterval
    public var id: Date { date }

    public init(date: Date, value: Double, low: Double? = nil, high: Double? = nil, span: TimeInterval = 0) {
        self.date = date
        self.value = value
        self.low = low
        self.high = high
        self.span = span
    }

    public var isBucket: Bool { span > 0 }

    init?(_ point: HistoryResponse.Point, resolution: Int) {
        guard let value = point.value else {
            return nil
        }
        self.init(date: point.date, value: value, low: point.low, high: point.high, span: TimeInterval(resolution))
    }
}

/// Temperature, air and heating history for one body of water. Each graph resolution keeps its
/// own fetched windows, so zooming in asks only for the finer readings it doesn't have yet,
/// and zooming back out finds the coarser ones still there.
@Observable
public final class TemperatureHistoryModel {
    /// A stretch of time the heater or heat pump was warming this water; `intensity` is the
    /// share of the stretch it was on, 1 for exact readings.
    public struct HeatingSpan: Identifiable {
        public let start: Date
        public let end: Date
        public let intensity: Double
        public var id: Date { start }
    }

    /// A stretch of line drawn without breaks.
    public struct Segment: Identifiable {
        public let id: Int
        public let samples: [HistorySample]
    }

    /// Everything the graph draws, up to one time.
    public struct ChartData {
        public let water: [Segment]
        public let air: [HistorySample]
        public let heater: [HeatingSpan]
        public let heatPump: [HeatingSpan]
        /// The bucket length the lines are drawn from, or 0 for readings as recorded.
        public let resolution: Int
    }

    /// How many resolutions to keep fetched readings for.
    static let keptLevels = 4

    public let water: WaterBody

    public private(set) var earliest: Date?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    /// Counts merged responses, so the graph is redrawn from new data.
    public private(set) var revision = 0

    /// Readings fetched at one resolution, and the windows they cover.
    private struct Level {
        var values: [ReadingName: [Date: HistorySample]] = [:]
        var sorted: [ReadingName: [HistorySample]] = [:]
        var loaded: [ClosedRange<Date>] = []
        /// The resolution the server answered with, which can be coarser than asked.
        var resolution = 0
        var used = Date.now
    }

    private var levels: [Int: Level] = [:]
    /// The fetch under way; another waits for it rather than fetching the same window.
    @ObservationIgnored private var fetching: Task<Void, Never>?
    /// The graph is redrawn for every touch while reading values off it, so its lines are kept
    /// until the data, the level or the end time changes.
    @ObservationIgnored private var chartCache: (end: Date, level: Int, revision: Int, data: ChartData)?

    public init(water: WaterBody) {
        self.water = water
    }

    private var names: [ReadingName] {
        [water.temperatureName, .airTemperature, water.pump, .heating(water, by: .heater), .heating(water, by: .heatPump)]
    }

    /// The latest time `level` has readings for.
    public func loadedThrough(level: Int) -> Date? {
        levels[level]?.loaded.last?.upperBound
    }

    // MARK: - Loading

    /// Fetches whatever part of `range` hasn't been fetched at `level` yet, after any fetch
    /// already under way.
    public func ensureLoaded(_ range: ClosedRange<Date>, level: Int, client: StatusClient) async {
        while let running = fetching {
            await running.value
            if Task.isCancelled {
                return
            }
        }
        levels[level, default: Level()].used = .now
        let gaps = missing(from: range, level: level)
        guard !gaps.isEmpty else {
            return
        }
        let fetch = Task {
            await self.fetch(gaps, level: level, client: client)
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

    private func fetch(_ gaps: [ClosedRange<Date>], level: Int, client: StatusClient) async {
        for gap in gaps {
            do {
                let span = gap.upperBound.timeIntervalSince(gap.lowerBound)
                let response = try await client.fetchHistory(names: names, from: gap.lowerBound, to: gap.upperBound,
                                                             maxPoints: HistoryResolution.points(for: span, level: level),
                                                             resolution: level)
                merge(response, level: level)
                record(gap, level: level)
                errorMessage = nil
            } catch {
                if !error.isCancellation {
                    errorMessage = error.localizedDescription
                }
                return
            }
        }
        evictUnusedLevels(keeping: level)
    }

    private func missing(from range: ClosedRange<Date>, level: Int) -> [ClosedRange<Date>] {
        var gaps: [ClosedRange<Date>] = []
        var cursor = range.lowerBound
        for covered in levels[level]?.loaded ?? [] where covered.upperBound > cursor && covered.lowerBound < range.upperBound {
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

    private func record(_ range: ClosedRange<Date>, level: Int) {
        var merged: [ClosedRange<Date>] = []
        for next in ((levels[level]?.loaded ?? []) + [range]).sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = merged.last, next.lowerBound <= last.upperBound {
                merged[merged.count - 1] = last.lowerBound...max(last.upperBound, next.upperBound)
            } else {
                merged.append(next)
            }
        }
        levels[level, default: Level()].loaded = merged
    }

    private func merge(_ response: HistoryResponse, level: Int) {
        if let oldest = response.earliest {
            earliest = min(earliest ?? oldest, oldest)
        }
        var store = levels[level] ?? Level()
        for series in response.series {
            var known = store.values[series.name] ?? [:]
            for point in series.points {
                if let sample = HistorySample(point, resolution: series.resolution) {
                    known[sample.date] = sample
                }
            }
            // a bucket already counts the value carried into it
            if series.resolution == 0, let before = series.before, let sample = HistorySample(before, resolution: 0),
               known[sample.date] == nil {
                known[sample.date] = sample
            }
            store.values[series.name] = known
            store.sorted[series.name] = known.values.sorted { $0.date < $1.date }
            store.resolution = max(store.resolution, series.resolution)
        }
        levels[level] = store
        revision += 1
    }

    private func evictUnusedLevels(keeping current: Int) {
        let stale = levels.filter { $0.key != current }.sorted { $0.value.used > $1.value.used }.dropFirst(Self.keptLevels - 1)
        for (level, _) in stale {
            levels[level] = nil
        }
    }

    // MARK: - Chart data

    /// The level to draw `visible` from: `level` once it covers the window, otherwise the most
    /// recently used one that does, so zooming in shows the coarser lines until finer arrive.
    public func displayLevel(for level: Int, visible: ClosedRange<Date>) -> Int {
        func covers(_ store: Level) -> Bool {
            store.loaded.contains { $0.lowerBound <= visible.lowerBound && $0.upperBound >= min(visible.upperBound, Date.now) }
        }
        if let store = levels[level], covers(store) {
            return level
        }
        return levels.filter { covers($0.value) }.max { $0.value.used < $1.value.used }?.key ?? level
    }

    public func samples(_ name: ReadingName, level: Int) -> [HistorySample] {
        levels[level]?.sorted[name] ?? []
    }

    public func chartData(through end: Date, level: Int) -> ChartData {
        if let chartCache, chartCache.end == end, chartCache.level == level, chartCache.revision == revision {
            return chartCache.data
        }
        let data = ChartData(water: waterSegments(through: end, level: level),
                             air: airSegment(through: end, level: level),
                             heater: heatingSpans(from: .heater, through: end, level: level),
                             heatPump: heatingSpans(from: .heatPump, through: end, level: level),
                             resolution: levels[level]?.resolution ?? 0)
        chartCache = (end, level, revision, data)
        return data
    }

    /// Times `source` (the heater or the heat pump) was warming this body of water, ending no
    /// later than `end`. The server works out where the heat went from the circulation switches.
    public func heatingSpans(from source: ReadingName, through end: Date, level: Int) -> [HeatingSpan] {
        Self.holds(samples(.heating(water, by: source), level: level), through: end)
            .filter { $0.value > 0 }
            .map { HeatingSpan(start: $0.start, end: $0.end, intensity: min($0.value, 1)) }
    }

    /// The water temperature line. Each sensor sits just downstream of its pump, so the line
    /// only covers times that pump ran, starting at that run's first reading, since an earlier
    /// one is stale.
    public func waterSegments(through end: Date, level: Int) -> [Segment] {
        let readings = samples(water.temperatureName, level: level).filter { $0.date <= end }
        guard !readings.isEmpty else {
            return []
        }
        let pump = samples(water.pump, level: level)
        guard !pump.isEmpty else {
            return [Segment(id: 0, samples: Self.extended(readings, to: end))]
        }
        let running = Self.merged(Self.holds(pump, through: end).filter { $0.value > 0 })
        return running.enumerated().compactMap { index, interval in
            let inside = readings.filter { $0.date >= interval.start && $0.date <= interval.end }
            return inside.isEmpty ? nil : Segment(id: index, samples: Self.extended(inside, to: interval.end))
        }
    }

    public func airSegment(through end: Date, level: Int) -> [HistorySample] {
        let readings = samples(.airTemperature, level: level).filter { $0.date <= end }
        return readings.isEmpty ? [] : Self.extended(readings, to: end)
    }

    /// How long each sample's value held: a reading until the next one, a bucket for its length.
    static func holds(_ samples: [HistorySample], through end: Date) -> [(start: Date, end: Date, value: Double)] {
        var result: [(start: Date, end: Date, value: Double)] = []
        for (index, sample) in samples.enumerated() where sample.date < end {
            var stop = index + 1 < samples.count ? samples[index + 1].date : end
            if sample.isBucket {
                stop = min(stop, sample.date.addingTimeInterval(sample.span))
            }
            stop = min(stop, end)
            if stop > sample.date {
                result.append((sample.date, stop, sample.value))
            }
        }
        return result
    }

    /// Back-to-back stretches joined into one.
    static func merged(_ stretches: [(start: Date, end: Date, value: Double)]) -> [(start: Date, end: Date)] {
        var result: [(start: Date, end: Date)] = []
        for stretch in stretches {
            if let last = result.last, stretch.start <= last.end {
                result[result.count - 1].end = max(last.end, stretch.end)
            } else {
                result.append((stretch.start, stretch.end))
            }
        }
        return result
    }

    private static func extended(_ readings: [HistorySample], to end: Date) -> [HistorySample] {
        var line = readings
        if let last = line.last, last.date < end {
            line.append(HistorySample(date: end, value: last.value, low: last.low, high: last.high, span: last.span))
        }
        return line
    }
}

/// Salt level for one time window, from `GET /history`.
@Observable
public final class SaltHistoryModel {
    public private(set) var samples: [HistorySample] = []
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?

    public init() {}

    /// `maxPoints` is the graph's width in pixels, so a long window comes back as buckets.
    public func load(from start: Date, to end: Date, maxPoints: Int = HistoryResolution.maxPoints, client: StatusClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await client.fetchHistory(names: [.salt], from: start, to: end, maxPoints: maxPoints)
            let series = response.series.first { $0.name == .salt }
            let resolution = series?.resolution ?? 0
            var loaded = (series?.before.flatMap { HistorySample($0, resolution: 0) }.map { [$0] } ?? [])
                .map { HistorySample(date: max($0.date, start), value: $0.value) }
            loaded += (series?.points ?? []).compactMap { HistorySample($0, resolution: resolution) }
            // readings are stored when they change, so the last one holds until now
            if let last = loaded.last, last.date < end {
                loaded.append(HistorySample(date: end, value: last.value, low: last.low, high: last.high, span: last.span))
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
