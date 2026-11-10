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

    /// As many points as the server will send, so a window comes back as the readings themselves
    /// whenever they are still stored and fit. `level` is the bucket length sent with the request,
    /// which the server uses when a window has more readings than this.
    public static func points(for span: TimeInterval, level: Int) -> Int {
        _ = (span, level)
        return maxPoints
    }
}

/// What a scrolling graph draws around the part in view. Its scale reaches back to the earliest
/// reading, which can be thousands of screens away, and a chart lays out its marks and axis
/// ticks across all of it; giving it only the stretch near the view keeps each frame light.
public nonisolated enum HistoryWindow {
    private enum Step {
        case hours(Int), days(Int), weeks(Int), months(Int), years(Int)

        var approximateLength: TimeInterval {
            switch self {
            case .hours(let n): Double(n) * 3600
            case .days(let n): Double(n) * 86400
            case .weeks(let n): Double(n) * 7 * 86400
            case .months(let n): Double(n) * 30 * 86400
            case .years(let n): Double(n) * 365 * 86400
            }
        }
    }

    private static let steps: [Step] = [
        .hours(1), .hours(2), .hours(3), .hours(6), .hours(12), .days(1), .days(2), .weeks(1), .weeks(2),
        .months(1), .months(2), .months(3), .months(6), .years(1), .years(2), .years(5), .years(10)
    ]
    /// About this many ticks across the part in view.
    static let ticksInView = 5.0
    static let maximumTicks = 500

    /// The view, a whole view's length on each side and up to another; it moves a view's length at
    /// a time, so scrolling within it leaves the drawn data and ticks as they were.
    public static func around(_ start: Date, visibleLength: TimeInterval) -> ClosedRange<Date> {
        let index = (start.timeIntervalSinceReferenceDate / visibleLength).rounded(.down)
        return Date(timeIntervalSinceReferenceDate: (index - 1) * visibleLength)...Date(timeIntervalSinceReferenceDate: (index + 3) * visibleLength)
    }

    /// Calendar-aligned axis ticks across `window`, spaced for about five in a view `visibleLength`
    /// long, so the same times are ticks whichever window they fall in.
    public static func ticks(in window: ClosedRange<Date>, visibleLength: TimeInterval, calendar: Calendar = .current) -> [Date] {
        let step = steps.first { $0.approximateLength >= visibleLength / ticksInView } ?? steps[steps.count - 1]
        guard var tick = alignedStart(step, atOrBefore: window.lowerBound, calendar: calendar) else {
            return []
        }
        var ticks: [Date] = []
        while tick <= window.upperBound && ticks.count < maximumTicks {
            if tick >= window.lowerBound {
                ticks.append(tick)
            }
            guard let next = advance(tick, by: step, calendar: calendar), next > tick else {
                break
            }
            tick = next
        }
        return ticks
    }

    private static func alignedStart(_ step: Step, atOrBefore date: Date, calendar: Calendar) -> Date? {
        switch step {
        case .hours(let n):
            guard let hour = calendar.dateInterval(of: .hour, for: date)?.start else { return nil }
            return calendar.date(byAdding: .hour, value: -(calendar.component(.hour, from: hour) % n), to: hour)
        case .days(let n):
            let day = calendar.startOfDay(for: date)
            let ordinal = calendar.ordinality(of: .day, in: .era, for: day) ?? 0
            return calendar.date(byAdding: .day, value: -(ordinal % n), to: day)
        case .weeks(let n):
            guard let week = calendar.dateInterval(of: .weekOfYear, for: date)?.start else { return nil }
            let ordinal = (calendar.ordinality(of: .day, in: .era, for: week) ?? 0) / 7
            return calendar.date(byAdding: .weekOfYear, value: -(ordinal % n), to: week)
        case .months(let n):
            guard let month = calendar.dateInterval(of: .month, for: date)?.start else { return nil }
            let index = calendar.component(.year, from: month) * 12 + calendar.component(.month, from: month) - 1
            return calendar.date(byAdding: .month, value: -(index % n), to: month)
        case .years(let n):
            guard let year = calendar.dateInterval(of: .year, for: date)?.start else { return nil }
            return calendar.date(byAdding: .year, value: -(calendar.component(.year, from: year) % n), to: year)
        }
    }

    private static func advance(_ date: Date, by step: Step, calendar: Calendar) -> Date? {
        switch step {
        case .hours(let n): calendar.date(byAdding: .hour, value: n, to: date)
        case .days(let n): calendar.date(byAdding: .day, value: n, to: date)
        case .weeks(let n): calendar.date(byAdding: .weekOfYear, value: n, to: date)
        case .months(let n): calendar.date(byAdding: .month, value: n, to: date)
        case .years(let n): calendar.date(byAdding: .year, value: n, to: date)
        }
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
        /// The water line's bucket length, in seconds, or 0 when it is readings as recorded.
        public let resolution: Int
        /// The air line's bucket length, in seconds, or 0 when it is readings or hidden from the draw.
        public let airResolution: Int
    }

    /// How many resolutions to keep fetched readings for.
    static let keptLevels = 4

    public let water: WaterBody

    public private(set) var earliest: Date?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    /// Counts merged responses, so the graph is redrawn from new data.
    public private(set) var revision = 0

    /// One fetch: the window it covered, and whether any series in it was a summary.
    private struct Fetch: Equatable {
        var range: ClosedRange<Date>
        var summarized: Bool
    }

    /// Readings fetched at one resolution, and the windows they cover.
    private struct Level {
        var values: [ReadingName: [Date: HistorySample]] = [:]
        var sorted: [ReadingName: [HistorySample]] = [:]
        var loaded: [Fetch] = []
        /// The coarsest resolution the server answered with, which can be coarser than asked.
        var resolution = 0
        var used = Date.now
    }

    /// A summary fetched for a window this many times wider is fetched again for the closer one.
    private static let summaryZoom = 1.5

    private var levels: [Int: Level] = [:]
    /// The fetch under way; another waits for it rather than fetching the same window.
    @ObservationIgnored private var fetching: Task<Void, Never>?
    /// The graph is redrawn for every touch while reading values off it, so its lines are kept
    /// until the data, the level or the end time changes.
    @ObservationIgnored private var chartCache: (end: Date, level: Int, window: ClosedRange<Date>?, revision: Int, data: ChartData)?

    public init(water: WaterBody) {
        self.water = water
    }

    private var names: [ReadingName] {
        [water.temperatureName, .airTemperature, water.pump, .heating(water, by: .heater), .heating(water, by: .heatPump)]
    }

    /// The latest time `level` has readings for.
    public func loadedThrough(level: Int) -> Date? {
        levels[level]?.loaded.map(\.range.upperBound).max()
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
                record(gap, summarized: response.series.contains { $0.resolution > 0 }, level: level)
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

    /// Readings answer any window they overlap. A summary answers one only when it isn't much
    /// wider, so zooming in asks again and can come back as the readings if they are still stored.
    private func covers(_ fetch: Fetch, request: ClosedRange<Date>) -> Bool {
        guard fetch.range.upperBound > request.lowerBound, fetch.range.lowerBound < request.upperBound else {
            return false
        }
        guard fetch.summarized else {
            return true
        }
        let requestSpan = request.upperBound.timeIntervalSince(request.lowerBound)
        let fetchedSpan = fetch.range.upperBound.timeIntervalSince(fetch.range.lowerBound)
        return fetchedSpan <= requestSpan * Self.summaryZoom
    }

    private func missing(from range: ClosedRange<Date>, level: Int) -> [ClosedRange<Date>] {
        let covering = (levels[level]?.loaded ?? []).filter { covers($0, request: range) }
            .sorted { $0.range.lowerBound < $1.range.lowerBound }
        var gaps: [ClosedRange<Date>] = []
        var cursor = range.lowerBound
        for fetch in covering where fetch.range.upperBound > cursor && fetch.range.lowerBound < range.upperBound {
            if fetch.range.lowerBound > cursor {
                gaps.append(cursor...fetch.range.lowerBound)
            }
            cursor = max(cursor, fetch.range.upperBound)
        }
        if cursor < range.upperBound {
            gaps.append(cursor...range.upperBound)
        }
        return gaps.filter { $0.upperBound.timeIntervalSince($0.lowerBound) >= 1 }
    }

    private func record(_ range: ClosedRange<Date>, summarized: Bool, level: Int) {
        var merged: [Fetch] = []
        let fetches = (levels[level]?.loaded ?? []) + [Fetch(range: range, summarized: summarized)]
        for next in fetches.sorted(by: { $0.range.lowerBound < $1.range.lowerBound }) {
            // a closer summary has to stay separate, or the wider one would hide that it was already fetched
            if let last = merged.last, !last.summarized, !next.summarized, next.range.lowerBound <= last.range.upperBound {
                merged[merged.count - 1].range = last.range.lowerBound...max(last.range.upperBound, next.range.upperBound)
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
            let span = TimeInterval(series.resolution)
            known = known.filter { date, sample in
                let stop = sample.span > 0 ? date.addingTimeInterval(sample.span) : date
                let overlaps = date < response.to && stop > response.from
                return !(overlaps && sample.span > span)
            }
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
            store.loaded.contains { $0.range.lowerBound <= visible.lowerBound && $0.range.upperBound >= min(visible.upperBound, Date.now) }
        }
        if let store = levels[level], covers(store) {
            return level
        }
        return levels.filter { covers($0.value) }.max { $0.value.used < $1.value.used }?.key ?? level
    }

    public func samples(_ name: ReadingName, level: Int) -> [HistorySample] {
        levels[level]?.sorted[name] ?? []
    }

    /// The lines through `end`; within `window`, a stretch from `HistoryWindow`, only what crosses
    /// it, so the graph has no more to draw than the part in view needs.
    public func chartData(through end: Date, level: Int, within window: ClosedRange<Date>? = nil) -> ChartData {
        if let chartCache, chartCache.end == end, chartCache.level == level, chartCache.window == window,
           chartCache.revision == revision {
            return chartCache.data
        }
        var water = waterSegments(through: end, level: level)
        var air = airSegment(through: end, level: level)
        var heater = heatingSpans(from: .heater, through: end, level: level)
        var heatPump = heatingSpans(from: .heatPump, through: end, level: level)
        if let window {
            water = water.compactMap { segment in
                let samples = Self.clipped(segment.samples, to: window)
                return samples.isEmpty ? nil : Segment(id: segment.id, samples: samples)
            }
            air = Self.clipped(air, to: window)
            heater = heater.filter { $0.end >= window.lowerBound && $0.start <= window.upperBound }
            heatPump = heatPump.filter { $0.end >= window.lowerBound && $0.start <= window.upperBound }
        }
        let data = ChartData(water: water, air: air, heater: heater, heatPump: heatPump,
                             resolution: Self.bucketSeconds(water.flatMap(\.samples), within: window),
                             airResolution: Self.bucketSeconds(air, within: window))
        chartCache = (end, level, window, revision, data)
        return data
    }

    /// The longest bucket overlapping `window`, in seconds, or 0 when the samples are readings.
    /// With no window, any bucket counts.
    private static func bucketSeconds(_ samples: [HistorySample], within window: ClosedRange<Date>?) -> Int {
        let spans = samples.compactMap { sample -> TimeInterval? in
            guard sample.span > 0 else { return nil }
            guard let window else { return sample.span }
            let stop = sample.date.addingTimeInterval(sample.span)
            return sample.date < window.upperBound && stop > window.lowerBound ? sample.span : nil
        }
        return Int(spans.max() ?? 0)
    }

    /// The samples of one stepped line that cross `window`, with the one before it, whose value
    /// holds into it, and the one after, so the line runs off both edges.
    static func clipped(_ samples: [HistorySample], to window: ClosedRange<Date>) -> [HistorySample] {
        guard let first = samples.first, let last = samples.last,
              last.date >= window.lowerBound, first.date <= window.upperBound else {
            return []
        }
        let inside = firstIndex(in: samples) { $0.date >= window.lowerBound }
        let after = firstIndex(in: samples) { $0.date > window.upperBound }
        return Array(samples[max(0, inside - 1)..<min(samples.count, after + 1)])
    }

    /// The first index of sorted `samples` where `isPast` holds, by bisection.
    private static func firstIndex(in samples: [HistorySample], where isPast: (HistorySample) -> Bool) -> Int {
        var low = 0
        var high = samples.count
        while low < high {
            let middle = (low + high) / 2
            if isPast(samples[middle]) {
                high = middle
            } else {
                low = middle + 1
            }
        }
        return low
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
