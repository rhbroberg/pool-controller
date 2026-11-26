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

    /// Includes the restored pan from the first frame so Charts has room to show it.
    private var domain: ClosedRange<Date> {
        let floor = now.addingTimeInterval(-visibleLength)
        let start = [model.earliest, scrollPosition, pendingScroll, floor].compactMap { $0 }.min() ?? floor
        return start...now
    }

    private var maxPoints: Int {
        min(HistoryResolution.maxPoints, max(50, Int(chartWidth * displayScale)))
    }

    private struct LoadKey: Equatable {
        let start: Date
        let length: TimeInterval
        let maxPoints: Int
    }

    var body: some View {
        let summarySeconds = summarySpan()

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
                if let selectedDate, let value = value(at: selectedDate) {
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

            chart
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
            guard pendingScroll == nil else {
                return
            }
            scheduleViewportSave()
        }
        .onChange(of: visibleLength) { _, _ in
            guard pendingScroll == nil else {
                return
            }
            scheduleViewportSave()
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
        .task(id: LoadKey(start: pendingScroll ?? scrollPosition, length: visibleLength, maxPoints: maxPoints)) {
            // let scrolling and pinching settle before asking for more data
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else {
                return
            }
            let aim = pendingScroll ?? scrollPosition
            let margin = visibleLength / 2
            let start = aim.addingTimeInterval(-margin)
            let end = min(now, aim.addingTimeInterval(visibleLength + margin))
            guard start < end else {
                return
            }
            await model.load(from: start, to: end, maxPoints: maxPoints, client: store.client)
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
                let start = scrollPosition.addingTimeInterval(-visibleLength / 2)
                let end = min(now, scrollPosition.addingTimeInterval(visibleLength + visibleLength / 2))
                guard start < end else {
                    continue
                }
                await model.load(from: start, to: end, maxPoints: maxPoints, client: store.client)
            }
        }
    }

    private func summarySpan() -> Int {
        let range = visibleRange
        let span = model.samples.compactMap { sample -> TimeInterval? in
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

    private var chart: some View {
        Chart {
            // a long range comes back as buckets, each shaded across its lowest to highest level
            ForEach(model.samples.filter { $0.low != nil }) { sample in
                AreaMark(x: .value("Time", sample.date),
                         yStart: .value("Lowest", sample.low ?? sample.value),
                         yEnd: .value("Highest", sample.high ?? sample.value))
                    .foregroundStyle(Self.lineColor.opacity(Self.bandOpacity))
                    .interpolationMethod(.stepEnd)
            }
            ForEach(model.samples) { sample in
                LineMark(x: .value("Time", sample.date), y: .value("Salt", sample.value))
                    .foregroundStyle(Self.lineColor)
                    .lineStyle(StrokeStyle(lineWidth: 2.5))
                    .interpolationMethod(.stepEnd)
            }
            // a reading or two make too short a line to see
            if model.samples.count < 3 {
                ForEach(model.samples) { sample in
                    PointMark(x: .value("Time", sample.date), y: .value("Salt", sample.value))
                        .foregroundStyle(Self.lineColor)
                }
            }
            if let selectedDate, let value = value(at: selectedDate) {
                RuleMark(x: .value("Selected", selectedDate))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                PointMark(x: .value("Selected", selectedDate), y: .value("Salt", value))
                    .foregroundStyle(Self.lineColor)
                    .symbolSize(70)
            }
        }
        .chartXSelection(value: $selectedDate)
        .chartXScale(domain: domain)
        .chartYScale(domain: yDomain)
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: visibleLength)
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
            AxisMarks(values: HistoryWindow.ticks(in: HistoryWindow.around(scrollPosition, visibleLength: visibleLength),
                                                   visibleLength: visibleLength)) { _ in
                AxisGridLine()
                AxisValueLabel(format: visibleLength <= 2 * 24 * 60 * 60
                               ? .dateTime.hour()
                               : visibleLength <= 200 * 24 * 60 * 60
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
        .overlay {
            if model.samples.isEmpty && !model.isLoading && model.errorMessage == nil {
                Text("No salt readings in this range")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .cardBackground()
    }

    private var rangeDescription: String {
        let format = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        return "\(visibleRange.lowerBound.formatted(format)) – \(visibleRange.upperBound.formatted(format))"
    }

    /// Fits the readings in view, with room above and below.
    private var yDomain: ClosedRange<Double> {
        let range = visibleRange
        let values = model.samples.filter { range.contains($0.date) }
            .flatMap { [$0.value, $0.low, $0.high].compactMap(\.self) }
        guard let low = values.min(), let high = values.max() else {
            return 2000...4000
        }
        return max(0, (low - 200).rounded(.down))...(high + 200).rounded(.up)
    }

    private func value(at date: Date) -> Double? {
        model.samples.last { $0.date <= date }?.value
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
        scrollPosition = end.addingTimeInterval(-length)
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

#if DEBUG
#Preview {
    NavigationStack {
        SaltHistoryView()
    }
    .environment(StatusStore.preview())
}
#endif
