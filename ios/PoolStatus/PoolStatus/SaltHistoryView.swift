import Charts
import PoolStatusCore
import SwiftUI

/// Salt level against time. Zoom, pan, presets and restore match the temperature graphs.
struct SaltHistoryView: View {
    enum Preset: String, CaseIterable, Identifiable {
        case day = "Day", week = "Week", month = "Month"

        var id: String { rawValue }

        var title: String {
            switch self {
            case .day: String(localized: "Day")
            case .week: String(localized: "Week")
            case .month: String(localized: "Month")
            }
        }

        var length: TimeInterval {
            switch self {
            case .day: 24 * 60 * 60
            case .week: 7 * 24 * 60 * 60
            case .month: 30 * 24 * 60 * 60
            }
        }
    }

    static let minimumLength: TimeInterval = 60 * 60
    static let maximumLength: TimeInterval = 10 * 365 * 24 * 60 * 60
    static let zoomStep = 2.0
    /// How often to fetch readings newer than the last fetch while the page is open.
    static let refreshInterval: Duration = .seconds(60)
    static let lineColor = Color.teal
    static let bandOpacity = 0.16

    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.historyHelpSeen) private var helpSeen = false
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.displayScale) private var displayScale
    @State private var model = SaltHistoryModel()
    @State private var now = Date.now
    @State private var visibleLength: TimeInterval
    @State private var scrollPosition: Date
    /// Nil once the window has been zoomed away from every preset: shown as Custom.
    @State private var preset: Preset?
    @State private var pinchStartLength: TimeInterval?
    @State private var selectedDate: Date?
    @State private var choosingDates = false
    /// The plot's width, so a long range comes back as about one point per pixel.
    @State private var chartWidth: CGFloat = 360
    /// Scroll to restore after the first fetch; the chart is remounted so Charts doesn't clamp it.
    @State private var pendingScroll: Date?
    /// Bumped to remount the chart once the restored pan is safe to show.
    @State private var chartEpoch = 0
    /// Y scale locked for the current strip so a fetch doesn't rebuild the scrollable chart mid-pan.
    @State private var axisYDomain: ClosedRange<Double> = 2500...3500
    @State private var axisYStrip: Date?
    @State private var viewportSaveTask: Task<Void, Never>?

    init(initialPreset: Preset = .month) {
        if let saved = HistoryViewport.load(forKey: SettingsKey.saltHistory) {
            let length = min(max(saved.visibleLength, Self.minimumLength), Self.maximumLength)
            let start = min(saved.scrollPosition, Date.now.addingTimeInterval(-length))
            _visibleLength = State(initialValue: length)
            _scrollPosition = State(initialValue: start)
            _preset = State(initialValue: Preset.allCases.first { abs($0.length - length) < 1 })
            _pendingScroll = State(initialValue: start)
        } else {
            _visibleLength = State(initialValue: initialPreset.length)
            _scrollPosition = State(initialValue: Date.now.addingTimeInterval(-initialPreset.length))
            _preset = State(initialValue: initialPreset)
        }
    }

    private var visibleRange: ClosedRange<Date> {
        scrollPosition...scrollPosition.addingTimeInterval(visibleLength)
    }

    /// The strip of history drawn around the view; marks and the Y scale stay put while scrolling inside it.
    private var plotWindow: ClosedRange<Date> {
        let aim = pendingScroll ?? scrollPosition
        let window = HistoryWindow.around(aim, visibleLength: visibleLength)
        let upper = min(window.upperBound, now)
        let dataStart = model.earliest ?? window.lowerBound
        let lower = max(min(window.lowerBound, upper), min(dataStart, upper))
        return lower...upper
    }

    /// Scrollable X domain near the view—not `earliest...now`. A multi-year domain makes Charts
    /// treat history as one huge scroll view; at day zoom a fling warps months and can snap to the start.
    /// Steps in 4× the visible length so neighboring strip draws don't rewrite the scale every screen.
    private var scrollDomain: ClosedRange<Date> {
        let aim = pendingScroll ?? scrollPosition
        let step = visibleLength * 4
        let window = HistoryWindow.around(aim, visibleLength: step)
        var lo = window.lowerBound
        var hi = min(window.upperBound, now)
        if let earliest = model.earliest {
            lo = max(lo, earliest)
        }
        if hi.timeIntervalSince(lo) < visibleLength {
            hi = min(lo.addingTimeInterval(visibleLength), now)
            if let earliest = model.earliest, hi.timeIntervalSince(lo) < visibleLength {
                lo = max(earliest, hi.addingTimeInterval(-visibleLength))
            }
        }
        return lo...hi
    }

    /// Leading edge of the visible window, kept inside captured history.
    private func clampedScroll(_ value: Date) -> Date {
        let latestStart = now.addingTimeInterval(-visibleLength)
        let lo = model.earliest.map { min($0, latestStart) } ?? latestStart
        let hi = max(lo, latestStart)
        return min(max(value, lo), hi)
    }

    private func clampScrollToData() {
        let next = clampedScroll(scrollPosition)
        if next != scrollPosition {
            scrollPosition = next
        }
        if let pending = pendingScroll {
            let clamped = clampedScroll(pending)
            if clamped != pending {
                pendingScroll = clamped
            }
        }
    }

    private var maxPoints: Int {
        min(HistoryResolution.maxPoints, max(50, Int(chartWidth * displayScale)))
    }

    private struct LoadKey: Equatable {
        let windowStart: Date
        let windowEnd: Date
        let length: TimeInterval
        let maxPoints: Int
    }

    var body: some View {
        let window = plotWindow
        let samples = model.samples(within: window)
        let summarySeconds = summarySpan(in: samples)
        let plotIdentity = SaltChartPlot.Identity(
            window: window, scrollDomain: scrollDomain, visibleLength: visibleLength, revision: model.revision,
            selectedDate: selectedDate, empty: samples.isEmpty && !model.isLoading && model.errorMessage == nil,
            yDomain: axisYDomain, sampleCount: samples.count)

        VStack(alignment: .leading, spacing: 12) {
            Picker("Range", selection: $preset) {
                ForEach(Preset.allCases) { preset in
                    Text(preset.title).tag(Preset?.some(preset))
                }
                Text("Custom").tag(Preset?.none)
            }
            .pickerStyle(.segmented)
            .onChange(of: preset) { _, newValue in
                if let newValue {
                    show(length: newValue.length, endingAt: now)
                }
            }

            HStack(alignment: .firstTextBaseline) {
                if let selectedDate, let value = value(at: selectedDate, in: samples) {
                    Text(selectedDate, format: .dateTime.month(.abbreviated).day().hour().minute())
                        .foregroundStyle(.secondary)
                    Text("\(Int(value)) ppm")
                        .foregroundStyle(Self.lineColor)
                } else {
                    Text(rangeDescription)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer(minLength: 0)
            }
            .font(.headline.monospacedDigit())
            .frame(minHeight: 24)
            // over the row rather than in it: a spinner has no baseline to line up with the text, so
            // it would hang below it and make the row taller, moving the graph
            .overlay(alignment: .trailing) {
                if model.isLoading {
                    ProgressView()
                }
            }

            SaltChartPlot(
                identity: plotIdentity,
                samples: samples,
                scrollPosition: $scrollPosition,
                selectedDate: $selectedDate,
                chartWidth: $chartWidth
            )
            .equatable()
            .transaction { $0.animation = nil }
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { gesture in
                        let start = pinchStartLength ?? visibleLength
                        pinchStartLength = start
                        setLength(start / gesture.magnification)
                    }
                    .onEnded { _ in
                        pinchStartLength = nil
                    }
            )
            // remount after restore so chartScrollPosition opens at the saved pan
            .id(chartEpoch)
            .frame(minHeight: 160, maxHeight: .infinity)
            .overlay(alignment: .topTrailing) {
                summaryBadge(seconds: summarySeconds)
                    .padding(8)
            }

            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if verticalSizeClass != .compact {
                VStack(alignment: .leading, spacing: 4) {
                    if summarySeconds > 0 {
                        Text("Each step averages \(Duration.seconds(summarySeconds), format: .units(allowed: [.days, .hours, .minutes], width: .wide)); the shading behind it spans its lowest to highest reading.")
                    }
                    if !helpSeen {
                        Text("Drag the graph to move through time, pinch to zoom, and touch and hold to read a level.")
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(.systemGroupedBackground))
        .onChange(of: scrollPosition) { _, _ in
            // Don't rewrite scrollPosition here: clamping mid-gesture fights Charts and loops.
            guard pendingScroll == nil else {
                return
            }
            scheduleViewportSave()
        }
        .onChange(of: visibleLength) { _, _ in
            clampScrollToData()
            guard pendingScroll == nil else {
                return
            }
            scheduleViewportSave()
        }
        .onChange(of: model.earliest) { _, _ in
            clampScrollToData()
        }
        .onChange(of: model.revision) { _, _ in
            guard !samples.isEmpty else {
                return
            }
            if axisYStrip != window.lowerBound {
                axisYDomain = Self.yDomain(samples: samples)
                axisYStrip = window.lowerBound
            }
        }
        .onDisappear {
            helpSeen = true
            saveViewport()
        }
        .navigationTitle("Salt Level")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Choose Dates", systemImage: "calendar") {
                    choosingDates = true
                }
                Button("Zoom Out", systemImage: "minus.magnifyingglass") {
                    zoom(by: Self.zoomStep)
                }
                .disabled(visibleLength >= Self.maximumLength)
                Button("Zoom In", systemImage: "plus.magnifyingglass") {
                    zoom(by: 1 / Self.zoomStep)
                }
                .disabled(visibleLength <= Self.minimumLength)
            }
        }
        .sheet(isPresented: $choosingDates) {
            HistoryCalendarSheet(initialRange: visibleRange) { picked in
                show(picked)
            }
        }
        .task(id: LoadKey(windowStart: window.lowerBound, windowEnd: window.upperBound,
                          length: visibleLength, maxPoints: maxPoints)) {
            // let scrolling and pinching settle before asking for more data
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else {
                return
            }
            guard window.lowerBound < window.upperBound else {
                return
            }
            await model.ensureLoaded(window, maxPoints: maxPoints, client: store.client)
            guard !Task.isCancelled else {
                return
            }
            finishRestoreIfNeeded()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.refreshInterval)
                let following = scrollPosition.addingTimeInterval(visibleLength) >= now.addingTimeInterval(-visibleLength / 20)
                now = .now
                if following {
                    scrollPosition = now.addingTimeInterval(-visibleLength)
                }
                let refreshWindow = plotWindow
                guard refreshWindow.lowerBound < refreshWindow.upperBound else {
                    continue
                }
                await model.ensureLoaded(refreshWindow, maxPoints: maxPoints, client: store.client)
            }
        }
    }

    private func summarySpan(in samples: [HistorySample]) -> Int {
        let range = visibleRange
        let span = samples.compactMap { sample -> TimeInterval? in
            guard sample.span > 0 else { return nil }
            let stop = sample.date.addingTimeInterval(sample.span)
            return sample.date < range.upperBound && stop > range.lowerBound ? sample.span : nil
        }.max() ?? 0
        return Int(span)
    }

    @ViewBuilder
    private func summaryBadge(seconds: Int) -> some View {
        if seconds > 0 {
            HStack(spacing: 6) {
                Text("Summary")
                Text(Duration.seconds(seconds), format: .units(allowed: [.days, .hours, .minutes], width: .abbreviated))
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.regularMaterial, in: Capsule())
            .accessibilityElement(children: .combine)
            .allowsHitTesting(false)
        }
    }

    private var rangeDescription: String {
        let format = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        return "\(visibleRange.lowerBound.formatted(format)) – \(visibleRange.upperBound.formatted(format))"
    }

    /// Fits the readings in the drawn strip, so a small pan doesn't rescale the graph.
    fileprivate static func yDomain(samples: [HistorySample]) -> ClosedRange<Double> {
        let values = samples.flatMap { [$0.value, $0.low, $0.high].compactMap(\.self) }
        guard let low = values.min(), let high = values.max() else {
            return 2000...4000
        }
        return max(0, (low - 200).rounded(.down))...(high + 200).rounded(.up)
    }

    private func value(at date: Date, in samples: [HistorySample]) -> Double? {
        samples.last { $0.date <= date }?.value
    }

    /// After the first fetch widens the domain, remount the chart on the saved pan.
    private func finishRestoreIfNeeded() {
        guard let pending = pendingScroll else {
            return
        }
        scrollPosition = pending
        pendingScroll = nil
        chartEpoch += 1
        saveViewport()
    }

    private func scheduleViewportSave() {
        viewportSaveTask?.cancel()
        viewportSaveTask = Task {
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else {
                return
            }
            saveViewport()
        }
    }

    private func saveViewport() {
        viewportSaveTask?.cancel()
        viewportSaveTask = nil
        HistoryViewport(visibleLength: visibleLength, scrollPosition: pendingScroll ?? scrollPosition)
            .save(forKey: SettingsKey.saltHistory)
    }

    private func show(length: TimeInterval, endingAt end: Date) {
        pendingScroll = nil
        visibleLength = length
        scrollPosition = clampedScroll(end.addingTimeInterval(-length))
        saveViewport()
    }

    /// Shows the days picked in the calendar, as far as the zoom limits allow.
    private func show(_ range: ClosedRange<Date>) {
        preset = nil
        let end = min(range.upperBound, now)
        let length = min(max(end.timeIntervalSince(range.lowerBound), Self.minimumLength), Self.maximumLength)
        show(length: length, endingAt: end)
    }

    private func zoom(by factor: Double) {
        preset = nil
        setLength(visibleLength * factor)
    }

    /// Changes the zoom, keeping the right edge on "now" if it was there, or the center otherwise.
    private func setLength(_ requested: TimeInterval) {
        let length = min(max(requested, Self.minimumLength), Self.maximumLength)
        let end = scrollPosition.addingTimeInterval(visibleLength)
        let atNow = end >= now.addingTimeInterval(-visibleLength / 20)
        if pinchStartLength != nil {
            preset = nil
        }
        if atNow {
            show(length: length, endingAt: now)
        } else {
            pendingScroll = nil
            let center = scrollPosition.addingTimeInterval(visibleLength / 2)
            visibleLength = length
            scrollPosition = min(center.addingTimeInterval(-length / 2), now.addingTimeInterval(-length))
            saveViewport()
        }
    }
}

/// The plot itself. Equality ignores the scroll binding, so a pan doesn't rebuild every mark.
private struct SaltChartPlot: View, Equatable {
    struct Identity: Equatable {
        var window: ClosedRange<Date>
        var scrollDomain: ClosedRange<Date>
        var visibleLength: TimeInterval
        var revision: Int
        var selectedDate: Date?
        var empty: Bool
        var yDomain: ClosedRange<Double>
        var sampleCount: Int
    }

    let identity: Identity
    let samples: [HistorySample]
    @Binding var scrollPosition: Date
    @Binding var selectedDate: Date?
    @Binding var chartWidth: CGFloat

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.identity == rhs.identity
    }

    var body: some View {
        Chart {
            ForEach(samples.filter { $0.low != nil }) { sample in
                AreaMark(x: .value("Time", sample.date),
                         yStart: .value("Lowest", sample.low ?? sample.value),
                         yEnd: .value("Highest", sample.high ?? sample.value))
                    .foregroundStyle(SaltHistoryView.lineColor.opacity(SaltHistoryView.bandOpacity))
                    .interpolationMethod(.stepEnd)
            }
            ForEach(samples) { sample in
                LineMark(x: .value("Time", sample.date), y: .value("Salt", sample.value))
                    .foregroundStyle(SaltHistoryView.lineColor)
                    .lineStyle(StrokeStyle(lineWidth: 2.5))
                    .interpolationMethod(.stepEnd)
            }
            // a reading or two make too short a line to see
            if samples.count < 3 {
                ForEach(samples) { sample in
                    PointMark(x: .value("Time", sample.date), y: .value("Salt", sample.value))
                        .foregroundStyle(SaltHistoryView.lineColor)
                }
            }
            if let selectedDate, let value = samples.last(where: { $0.date <= selectedDate })?.value {
                RuleMark(x: .value("Selected", selectedDate))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                PointMark(x: .value("Selected", selectedDate), y: .value("Salt", value))
                    .foregroundStyle(SaltHistoryView.lineColor)
                    .symbolSize(70)
            }
        }
        .chartXSelection(value: $selectedDate)
        .chartXScale(domain: identity.scrollDomain)
        .chartYScale(domain: identity.yDomain)
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: identity.visibleLength)
        .chartScrollPosition(x: $scrollPosition)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let ppm = value.as(Double.self) {
                        Text("\(Int(ppm))")
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: HistoryWindow.ticks(in: identity.window, visibleLength: identity.visibleLength)) { _ in
                AxisGridLine()
                AxisValueLabel(format: identity.visibleLength <= 2 * 24 * 60 * 60
                               ? .dateTime.hour()
                               : identity.visibleLength <= 200 * 24 * 60 * 60
                               ? .dateTime.month(.abbreviated).day()
                               : .dateTime.month(.abbreviated).year(.twoDigits),
                               collisionResolution: .greedy)
            }
        }
        .chartYAxisLabel("ppm", position: .topLeading)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            chartWidth = width
        }
        .overlay {
            if identity.empty {
                Text("No salt readings in this range")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .cardBackground()
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SaltHistoryView()
    }
    .environment(StatusStore.preview())
}
#endif
