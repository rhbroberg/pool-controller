import Charts
import PoolStatusCore
import SwiftUI

/// Temperature against time for the pool or spa, with air temperature. The heater and heat
/// pump color the water line itself while they were warming it.
struct TemperatureHistoryView: View {
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
    // years of history are summarized by day, so even the longest view stays light
    static let maximumLength: TimeInterval = 10 * 365 * 24 * 60 * 60
    static let zoomStep = 2.0
    /// How often to fetch readings newer than the last fetch while the page is open.
    static let refreshInterval: Duration = .seconds(60)
    static let waterColor = Color.blue
    static let airColor = Color.gray
    static let heaterColor = Color.orange
    static let heatPumpColor = Color.pink
    /// A bucket's range, behind its average.
    static let bandOpacity = 0.16

    fileprivate static func stroke(_ source: TemperatureHistoryModel.HeatingSource) -> Color {
        switch source {
        case .water: waterColor
        case .heater: heaterColor
        case .heatPump: heatPumpColor
        }
    }

    let water: WaterBody

    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.showAirTemperature) private var showAir = true
    @AppStorage(SettingsKey.showHeater) private var showHeater = true
    @AppStorage(SettingsKey.showHeatPump) private var showHeatPump = true
    @AppStorage(SettingsKey.historyHelpSeen) private var helpSeen = false
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.displayScale) private var displayScale
    @State private var model: TemperatureHistoryModel
    @State private var now = Date.now
    @State private var visibleLength: TimeInterval
    @State private var scrollPosition: Date
    /// Nil once the window has been zoomed away from every preset: shown as Custom.
    @State private var preset: Preset?
    @State private var pinchStartLength: TimeInterval?
    /// The time under the finger while reading values off the graph.
    @State private var selectedDate: Date?
    @State private var choosingDates = false
    /// The plot's width, for asking the server for about one point per pixel.
    @State private var chartWidth: CGFloat = 360
    /// Scroll to restore after the first fetch; the chart is remounted so Charts doesn't clamp it.
    @State private var pendingScroll: Date?
    /// Bumped to remount the chart once the restored pan is safe to show.
    @State private var chartEpoch = 0
    /// Y scale locked for the current strip so a fetch doesn't rebuild the scrollable chart mid-pan.
    @State private var axisYDomain: ClosedRange<Double> = 40...100
    @State private var axisYStrip: Date?
    @State private var viewportSaveTask: Task<Void, Never>?

    init(water: WaterBody, initialPreset: Preset = .day) {
        self.water = water
        _model = State(initialValue: TemperatureHistoryModel(water: water))
        let key = water == .pool ? SettingsKey.poolTemperatureHistory : SettingsKey.spaTemperatureHistory
        if let saved = HistoryViewport.load(forKey: key) {
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

    private var viewportKey: String {
        water == .pool ? SettingsKey.poolTemperatureHistory : SettingsKey.spaTemperatureHistory
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

    private struct LoadKey: Equatable {
        let windowStart: Date
        let windowEnd: Date
        let length: TimeInterval
        let level: Int
    }

    /// The bucket length that gives about one point per pixel at this zoom.
    private var level: Int {
        HistoryResolution.level(visibleLength: visibleLength, pixels: chartWidth * displayScale)
    }

    var body: some View {
        let window = plotWindow
        let drawn = model.displayLevel(for: level, visible: visibleRange)
        let end = model.loadedThrough(level: drawn).map { min($0, now) } ?? now
        let data = model.chartData(through: end, level: drawn, within: window)
        let segments = data.water
        let air = showAir ? data.air : []
        let heater = showHeater ? data.heater : []
        let heatPump = showHeatPump ? data.heatPump : []
        let waterSummary = summarySeconds(segments.flatMap(\.samples))
        let airSummary = summarySeconds(air)
        let ticks = HistoryWindow.ticks(in: window, visibleLength: visibleLength)
        let plotIdentity = TemperatureChartPlot.Identity(
            window: window, scrollDomain: scrollDomain, visibleLength: visibleLength,
            revision: model.revision, drawnLevel: drawn,
            showAir: showAir, showHeater: showHeater, showHeatPump: showHeatPump,
            selectedDate: selectedDate, empty: segments.isEmpty && !model.isLoading,
            yDomain: axisYDomain)

        // no scroll view around the graph, so dragging it moves through time and never the page
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
                if let selectedDate {
                    selectionReadout(at: selectedDate, segments: segments, air: air,
                                     heater: heater, heatPump: heatPump)
                } else {
                    Text(rangeDescription)
                        .font(.headline.monospacedDigit())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 24)
            // over the row rather than in it: a spinner has no baseline to line up with the text, so
            // it would hang below it, and taking room would rewrap the readout, either way moving the graph
            .overlay(alignment: .trailing) {
                if model.isLoading {
                    ProgressView()
                }
            }

            TemperatureChartPlot(
                identity: plotIdentity,
                water: water,
                segments: segments,
                air: air,
                heater: heater,
                heatPump: heatPump,
                ticks: ticks,
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
                summaryBadge(water: waterSummary, air: airSummary)
                    .padding(8)
            }

            legend

            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if verticalSizeClass != .compact {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Gaps in the line are times the pump was off, when the sensor can’t read the water.")
                    if waterSummary > 0 {
                        Text("Each step averages \(Duration.seconds(waterSummary), format: .units(allowed: [.days, .hours, .minutes], width: .wide)); the shading behind it spans its lowest to highest reading.")
                    }
                    if airSummary > 0, airSummary != waterSummary {
                        Text("The air line averages \(Duration.seconds(airSummary), format: .units(allowed: [.days, .hours, .minutes], width: .wide)).")
                    }
                    if !helpSeen {
                        Text("Drag the graph to move through time, pinch to zoom, and touch and hold to read a temperature.")
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
            guard !segments.isEmpty || !air.isEmpty else {
                return
            }
            // Lock Y for the strip after the first readings arrive; later fetches keep the scale.
            if axisYStrip != window.lowerBound {
                axisYDomain = Self.yDomain(segments: segments, air: air)
                axisYStrip = window.lowerBound
            }
        }
        .onDisappear {
            helpSeen = true
            saveViewport()
        }
        .navigationTitle("\(water.title) Temperature")
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
            HistoryCalendarSheet(initialRange: visibleRange, reading: water.temperatureName) { range in
                show(range)
            }
        }
        .task(id: LoadKey(windowStart: window.lowerBound, windowEnd: window.upperBound,
                          length: visibleLength, level: level)) {
            // let scrolling and pinching settle before asking for more data
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else {
                return
            }
            // fetch the drawn strip, not every scroll tick
            guard window.lowerBound < window.upperBound else {
                return
            }
            await model.ensureLoaded(window, level: level, client: store.client)
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
                if let through = model.loadedThrough(level: level) {
                    await model.ensureLoaded(through...now, level: level, client: store.client)
                }
            }
        }
    }

    /// The longest bucket overlapping the time in view, in seconds, or 0 for readings as recorded.
    private func summarySeconds(_ samples: [HistorySample]) -> Int {
        let range = visibleRange
        let span = samples.compactMap { sample -> TimeInterval? in
            guard sample.span > 0 else { return nil }
            let stop = sample.date.addingTimeInterval(sample.span)
            return sample.date < range.upperBound && stop > range.lowerBound ? sample.span : nil
        }.max() ?? 0
        return Int(span)
    }

    /// On the graph itself, so a summary is marked even when the footnote is off the screen.
    @ViewBuilder
    private func summaryBadge(water: Int, air: Int) -> some View {
        let seconds = water > 0 ? water : air
        if seconds > 0 {
            HStack(spacing: 6) {
                Text(water > 0 ? "Summary" : "Air summary")
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


    /// One row where it fits, otherwise two, so no entry is cut short on a narrow phone.
    private var legend: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) {
                waterLegend
                airLegend
                heaterLegend
                heatPumpLegend
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 14) {
                    waterLegend
                    airLegend
                }
                HStack(spacing: 14) {
                    heaterLegend
                    heatPumpLegend
                }
            }
        }
        .font(.footnote)
    }

    private var waterLegend: some View {
        legendItem(water.title) {
            Capsule().fill(Self.waterColor).frame(width: 18, height: 3)
        }
    }

    private var heaterLegend: some View {
        legendToggle("Heater", isOn: $showHeater, accessibilityLabel: "Heater",
                     hint: "Shows or hides heater stretches on the temperature line") {
            Capsule().fill(Self.heaterColor.opacity(showHeater ? 1 : 0.35)).frame(width: 18, height: 3)
        }
    }

    private var heatPumpLegend: some View {
        legendToggle("Heat Pump", isOn: $showHeatPump, accessibilityLabel: "Heat pump",
                     hint: "Shows or hides heat-pump stretches on the temperature line") {
            Capsule().fill(Self.heatPumpColor.opacity(showHeatPump ? 1 : 0.35)).frame(width: 18, height: 3)
        }
    }

    private var airLegend: some View {
        legendToggle("Air", isOn: $showAir, accessibilityLabel: "Air temperature",
                     hint: "Shows or hides air temperature on the graph") {
            Capsule().fill(Self.airColor.opacity(showAir ? 1 : 0.35)).frame(width: 18, height: 2)
        }
    }

    // the air, heater and heat pump entries double as their show/hide switches, which keeps the
    // page short enough to fit without scrolling
    private func legendToggle(_ title: LocalizedStringKey, isOn: Binding<Bool>,
                              accessibilityLabel: LocalizedStringKey, hint: LocalizedStringKey,
                              @ViewBuilder swatch: () -> some View) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            HStack(spacing: 6) {
                swatch()
                Text(title)
                Image(systemName: isOn.wrappedValue ? "eye" : "eye.slash")
                    .font(.caption2)
            }
            .foregroundStyle(isOn.wrappedValue ? Color.primary : Color.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(.tertiarySystemFill), in: .capsule)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(isOn.wrappedValue ? "Shown" : "Hidden")
        .accessibilityHint(hint)
    }

    /// The values under the finger, in place of the date range while reading the graph.
    private func selectionReadout(at date: Date, segments: [TemperatureHistoryModel.Segment],
                                  air: [HistorySample],
                                  heater: [TemperatureHistoryModel.HeatingSpan],
                                  heatPump: [TemperatureHistoryModel.HeatingSpan]) -> some View {
        let water = Self.waterValue(at: date, segments: segments)
        let airValue = air.last { $0.date <= date }?.value
        let heated = TemperatureHistoryModel.heating(at: date, heater: heater, heatPump: heatPump)
        let when = Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
            .foregroundStyle(.secondary)
        let values = HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(water.map { String(localized: "\(self.water.title) \(Int($0))°F") }
                 ?? String(localized: "\(self.water.title) pump off"))
                .foregroundStyle(Self.stroke(heated ?? .water))
            if let airValue {
                Text("Air \(Int(airValue))°F")
                    .foregroundStyle(.secondary)
            }
            if let heated {
                Image(systemName: "flame.fill")
                    .foregroundStyle(Self.stroke(heated))
                    .accessibilityLabel(heated == .heater ? "Heater" : "Heat pump")
            }
        }
        // the time beside the values where they fit, above them where they don't
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                when
                values
            }
            VStack(alignment: .leading, spacing: 2) {
                when
                    .font(.subheadline)
                values
            }
        }
        .font(.headline.monospacedDigit())
        .accessibilityElement(children: .combine)
    }

    /// The water temperature at `date`, or nil when the pump was off and the line has a gap.
    fileprivate static func waterValue(at date: Date, segments: [TemperatureHistoryModel.Segment]) -> Double? {
        for segment in segments {
            guard let first = segment.samples.first, let last = segment.samples.last,
                  first.date <= date, date <= last.date else {
                continue
            }
            return segment.samples.last { $0.date <= date }?.value
        }
        return nil
    }

    private func legendItem(_ title: String, @ViewBuilder swatch: () -> some View) -> some View {
        HStack(spacing: 6) {
            swatch()
            Text(title)
        }
        .fixedSize()
    }

    private var rangeDescription: String {
        let format = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        return "\(visibleRange.lowerBound.formatted(format)) – \(visibleRange.upperBound.formatted(format))"
    }

    /// Fits the readings in the drawn strip, so a small pan doesn't rescale the graph.
    fileprivate static func yDomain(segments: [TemperatureHistoryModel.Segment],
                                    air: [HistorySample]) -> ClosedRange<Double> {
        let values = (segments.flatMap(\.samples) + air)
            .flatMap { [$0.value, $0.low, $0.high].compactMap(\.self) }
        guard let low = values.min(), let high = values.max() else {
            return 40...100
        }
        return (low - 3).rounded(.down)...(high + 3).rounded(.up)
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
            .save(forKey: viewportKey)
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
private struct TemperatureChartPlot: View, Equatable {
    struct Identity: Equatable {
        var window: ClosedRange<Date>
        var scrollDomain: ClosedRange<Date>
        var visibleLength: TimeInterval
        var revision: Int
        var drawnLevel: Int
        var showAir: Bool
        var showHeater: Bool
        var showHeatPump: Bool
        var selectedDate: Date?
        var empty: Bool
        var yDomain: ClosedRange<Double>
    }

    let identity: Identity
    let water: WaterBody
    let segments: [TemperatureHistoryModel.Segment]
    let air: [HistorySample]
    let heater: [TemperatureHistoryModel.HeatingSpan]
    let heatPump: [TemperatureHistoryModel.HeatingSpan]
    let ticks: [Date]
    @Binding var scrollPosition: Date
    @Binding var selectedDate: Date?
    @Binding var chartWidth: CGFloat

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.identity == rhs.identity
    }

    var body: some View {
        let waterLines = TemperatureHistoryModel.coloredWaterLines(segments: segments, heater: heater,
                                                                   heatPump: heatPump)
        let heated = selectedDate.flatMap {
            TemperatureHistoryModel.heating(at: $0, heater: heater, heatPump: heatPump)
        }
        Chart {
            ForEach(waterLines) { segment in
                ForEach(segment.samples.filter { $0.low != nil }) { sample in
                    AreaMark(x: .value("Time", sample.date),
                             yStart: .value("Lowest", sample.low ?? sample.value),
                             yEnd: .value("Highest", sample.high ?? sample.value),
                             series: .value("Range", "water range \(segment.id)"))
                        .foregroundStyle(TemperatureHistoryView.stroke(segment.source)
                            .opacity(TemperatureHistoryView.bandOpacity))
                        .interpolationMethod(.stepEnd)
                }
            }
            ForEach(air) { sample in
                LineMark(x: .value("Time", sample.date), y: .value("Temperature", sample.value),
                         series: .value("Line", "air"))
                    .foregroundStyle(TemperatureHistoryView.airColor)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .interpolationMethod(.stepEnd)
            }
            ForEach(waterLines) { segment in
                ForEach(segment.samples) { sample in
                    LineMark(x: .value("Time", sample.date), y: .value("Temperature", sample.value),
                             series: .value("Line", "water \(segment.id)"))
                        .foregroundStyle(TemperatureHistoryView.stroke(segment.source))
                        .lineStyle(StrokeStyle(lineWidth: 2.5))
                        .interpolationMethod(.stepEnd)
                }
            }
            if let selectedDate {
                RuleMark(x: .value("Selected", selectedDate))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                if let value = TemperatureHistoryView.waterValue(at: selectedDate, segments: segments) {
                    PointMark(x: .value("Selected", selectedDate), y: .value("Temperature", value))
                        .foregroundStyle(TemperatureHistoryView.stroke(heated ?? .water))
                        .symbolSize(70)
                }
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
                    if let degrees = value.as(Double.self) {
                        Text("\(Int(degrees))°F")
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: ticks) { _ in
                AxisGridLine()
                AxisValueLabel(format: identity.visibleLength <= 2 * 24 * 60 * 60
                               ? .dateTime.hour()
                               : identity.visibleLength <= 200 * 24 * 60 * 60
                               ? .dateTime.month(.abbreviated).day()
                               : .dateTime.month(.abbreviated).year(.twoDigits),
                               collisionResolution: .greedy)
            }
        }
        .overlay {
            if identity.empty {
                Text("No \(water.title.lowercased()) temperature readings yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            chartWidth = width
        }
        .padding()
        .cardBackground()
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        TemperatureHistoryView(water: .pool)
    }
    .environment(StatusStore.preview())
}
#endif
