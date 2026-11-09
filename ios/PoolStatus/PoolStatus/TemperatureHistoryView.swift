import Charts
import PoolStatusCore
import SwiftUI

/// Temperature against time for the pool or spa, with air temperature and the times the
/// heater was warming it.
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
    /// The heating bands and their legend swatches share these, so the legend matches the plot.
    static let heaterOpacity = 0.28
    static let heatPumpOpacity = 0.24
    /// A bucket's range, behind its average.
    static let bandOpacity = 0.16

    let water: WaterBody

    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.showAirTemperature) private var showAir = true
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

    init(water: WaterBody, initialPreset: Preset = .day) {
        self.water = water
        _model = State(initialValue: TemperatureHistoryModel(water: water))
        _visibleLength = State(initialValue: initialPreset.length)
        _scrollPosition = State(initialValue: Date.now.addingTimeInterval(-initialPreset.length))
        _preset = State(initialValue: initialPreset)
    }

    private var visibleRange: ClosedRange<Date> {
        scrollPosition...scrollPosition.addingTimeInterval(visibleLength)
    }

    private var domain: ClosedRange<Date> {
        let start = min(model.earliest ?? now, now.addingTimeInterval(-visibleLength))
        return start...now
    }

    private struct LoadKey: Equatable {
        let start: Date
        let length: TimeInterval
        let level: Int
    }

    /// The bucket length that gives about one point per pixel at this zoom.
    private var level: Int {
        HistoryResolution.level(visibleLength: visibleLength, pixels: chartWidth * displayScale)
    }

    var body: some View {
        let drawn = model.displayLevel(for: level, visible: visibleRange)
        let end = model.loadedThrough(level: drawn).map { min($0, now) } ?? now
        let window = HistoryWindow.around(scrollPosition, visibleLength: visibleLength)
        let data = model.chartData(through: end, level: drawn, within: window)
        let segments = data.water
        let air = showAir ? data.air : []
        let heater = data.heater
        let heatPump = data.heatPump

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
                                     heating: heater + heatPump)
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

            chart(segments: segments, air: air, heater: heater, heatPump: heatPump,
                  ticks: HistoryWindow.ticks(in: window, visibleLength: visibleLength))
                .frame(minHeight: 160, maxHeight: .infinity)

            legend

            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if verticalSizeClass != .compact {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Gaps in the line are times the pump was off, when the sensor can’t read the water.")
                    if data.resolution > 0 {
                        Text("Each step averages \(Duration.seconds(data.resolution), format: .units(allowed: [.days, .hours, .minutes], width: .wide)); the shading behind it spans its lowest to highest reading.")
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
        .onDisappear {
            helpSeen = true
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
            HistoryCalendarSheet(initialRange: visibleRange) { range in
                show(range)
            }
        }
        .task(id: LoadKey(start: scrollPosition, length: visibleLength, level: level)) {
            // let scrolling and pinching settle before asking for more data
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else {
                return
            }
            let margin = visibleLength / 2
            let start = scrollPosition.addingTimeInterval(-margin)
            let end = min(now, scrollPosition.addingTimeInterval(visibleLength + margin))
            guard start < end else {
                return
            }
            await model.ensureLoaded(start...end, level: level, client: store.client)
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

    private func chart(segments: [TemperatureHistoryModel.Segment], air: [HistorySample],
                       heater: [TemperatureHistoryModel.HeatingSpan],
                       heatPump: [TemperatureHistoryModel.HeatingSpan], ticks: [Date]) -> some View {
        Chart {
            // a bucket is shaded by how much of it the heat was on
            ForEach(heater) { span in
                RectangleMark(xStart: .value("Heater starts", span.start),
                              xEnd: .value("Heater stops", span.end))
                    .foregroundStyle(Self.heaterColor.opacity(Self.heaterOpacity * span.intensity))
            }
            ForEach(heatPump) { span in
                RectangleMark(xStart: .value("Heat pump starts", span.start),
                              xEnd: .value("Heat pump stops", span.end))
                    .foregroundStyle(Self.heatPumpColor.opacity(Self.heatPumpOpacity * span.intensity))
            }
            ForEach(segments) { segment in
                ForEach(segment.samples.filter { $0.low != nil }) { sample in
                    AreaMark(x: .value("Time", sample.date),
                             yStart: .value("Lowest", sample.low ?? sample.value),
                             yEnd: .value("Highest", sample.high ?? sample.value),
                             series: .value("Range", "water range \(segment.id)"))
                        .foregroundStyle(Self.waterColor.opacity(Self.bandOpacity))
                        .interpolationMethod(.stepEnd)
                }
            }
            ForEach(air) { sample in
                LineMark(x: .value("Time", sample.date), y: .value("Temperature", sample.value),
                         series: .value("Line", "air"))
                    .foregroundStyle(Self.airColor)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .interpolationMethod(.stepEnd)
            }
            ForEach(segments) { segment in
                ForEach(segment.samples) { sample in
                    LineMark(x: .value("Time", sample.date), y: .value("Temperature", sample.value),
                             series: .value("Line", "water \(segment.id)"))
                        .foregroundStyle(Self.waterColor)
                        .lineStyle(StrokeStyle(lineWidth: 2.5))
                        .interpolationMethod(.stepEnd)
                }
            }
            if let selectedDate {
                RuleMark(x: .value("Selected", selectedDate))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                if let value = waterValue(at: selectedDate, segments: segments) {
                    PointMark(x: .value("Selected", selectedDate), y: .value("Temperature", value))
                        .foregroundStyle(Self.waterColor)
                        .symbolSize(70)
                }
            }
        }
        .chartXSelection(value: $selectedDate)
        .chartXScale(domain: domain)
        .chartYScale(domain: yDomain(segments: segments, air: air))
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: visibleLength)
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
                AxisValueLabel(format: visibleLength <= 2 * 24 * 60 * 60
                               ? .dateTime.hour()
                               : visibleLength <= 200 * 24 * 60 * 60
                               ? .dateTime.month(.abbreviated).day()
                               : .dateTime.month(.abbreviated).year(.twoDigits),
                               collisionResolution: .greedy)
            }
        }
        .overlay {
            if segments.isEmpty && !model.isLoading {
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
        .padding()
        .cardBackground()
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
        legendItem("Heater") {
            RoundedRectangle(cornerRadius: 2).fill(Self.heaterColor.opacity(Self.heaterOpacity)).frame(width: 14, height: 12)
        }
    }

    private var heatPumpLegend: some View {
        legendItem("Heat Pump") {
            RoundedRectangle(cornerRadius: 2).fill(Self.heatPumpColor.opacity(Self.heatPumpOpacity)).frame(width: 14, height: 12)
        }
    }

    private var airLegend: some View {
        // the air entry doubles as its show/hide switch, which keeps the page short enough
        // to fit without scrolling
        Button {
                showAir.toggle()
            } label: {
                HStack(spacing: 6) {
                    Capsule().fill(Self.airColor.opacity(showAir ? 1 : 0.35)).frame(width: 18, height: 2)
                    Text("Air")
                    Image(systemName: showAir ? "eye" : "eye.slash")
                        .font(.caption2)
                }
                .foregroundStyle(showAir ? Color.primary : Color.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color(.tertiarySystemFill), in: .capsule)
            }
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityLabel("Air temperature")
            .accessibilityValue(showAir ? "Shown" : "Hidden")
            .accessibilityHint("Shows or hides air temperature on the graph")
    }

    /// The values under the finger, in place of the date range while reading the graph.
    private func selectionReadout(at date: Date, segments: [TemperatureHistoryModel.Segment],
                                  air: [HistorySample],
                                  heating: [TemperatureHistoryModel.HeatingSpan]) -> some View {
        let water = waterValue(at: date, segments: segments)
        let airValue = air.last { $0.date <= date }?.value
        let heated = heating.contains { $0.start <= date && date <= $0.end }
        let when = Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
            .foregroundStyle(.secondary)
        let values = HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(water.map { String(localized: "\(self.water.title) \(Int($0))°F") }
                 ?? String(localized: "\(self.water.title) pump off"))
                .foregroundStyle(Self.waterColor)
            if let airValue {
                Text("Air \(Int(airValue))°F")
                    .foregroundStyle(.secondary)
            }
            if heated {
                Image(systemName: "flame.fill")
                    .foregroundStyle(Self.heaterColor)
                    .accessibilityLabel("Heating")
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
    private func waterValue(at date: Date, segments: [TemperatureHistoryModel.Segment]) -> Double? {
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

    /// Fits the readings in view, with a little room above and below.
    private func yDomain(segments: [TemperatureHistoryModel.Segment], air: [HistorySample]) -> ClosedRange<Double> {
        let range = visibleRange
        let visible = (segments.flatMap(\.samples) + air).filter { range.contains($0.date) }
            .flatMap { [$0.value, $0.low, $0.high].compactMap(\.self) }
        guard let low = visible.min(), let high = visible.max() else {
            return 40...100
        }
        return (low - 3).rounded(.down)...(high + 3).rounded(.up)
    }

    private func show(length: TimeInterval, endingAt end: Date) {
        visibleLength = length
        scrollPosition = end.addingTimeInterval(-length)
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
            let center = scrollPosition.addingTimeInterval(visibleLength / 2)
            visibleLength = length
            scrollPosition = min(center.addingTimeInterval(-length / 2), now.addingTimeInterval(-length))
        }
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
