import Charts
import SwiftUI

/// Temperature against time for the pool or spa, with air temperature and the times the
/// heater was warming it.
struct TemperatureHistoryView: View {
    enum Preset: String, CaseIterable, Identifiable {
        case day = "Day", week = "Week", month = "Month"

        var id: String { rawValue }
        var length: TimeInterval {
            switch self {
            case .day: 24 * 60 * 60
            case .week: 7 * 24 * 60 * 60
            case .month: 30 * 24 * 60 * 60
            }
        }
    }

    static let minimumLength: TimeInterval = 60 * 60
    static let maximumLength: TimeInterval = 365 * 24 * 60 * 60
    static let zoomStep = 2.0
    /// How often to fetch readings newer than the last fetch while the page is open.
    static let refreshInterval: Duration = .seconds(60)
    static let waterColor = Color.blue
    static let airColor = Color.gray
    static let heaterColor = Color.orange
    static let heatPumpColor = Color.pink

    let water: WaterBody

    @AppStorage("serverAddress") private var serverAddress = StatusView.defaultServerAddress
    @AppStorage("showAirTemperature") private var showAir = true
    @State private var model: TemperatureHistoryModel
    @State private var now = Date.now
    @State private var visibleLength: TimeInterval
    @State private var scrollPosition: Date
    @State private var preset: Preset?
    @State private var pinchStartLength: TimeInterval?

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
    }

    var body: some View {
        let end = model.loadedThrough.map { min($0, now) } ?? now
        let segments = model.waterSegments(through: end)
        let air = showAir ? model.airSegment(through: end) : []
        let heater = model.heatingIntervals(from: TemperatureHistoryModel.heaterName, through: end)
        let heatPump = model.heatingIntervals(from: TemperatureHistoryModel.heatPumpName, through: end)

        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Range", selection: $preset) {
                    ForEach(Preset.allCases) { preset in
                        Text(preset.rawValue).tag(Preset?.some(preset))
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: preset) { _, newValue in
                    if let newValue {
                        show(length: newValue.length, endingAt: now)
                    }
                }

                HStack {
                    Text(rangeDescription)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Spacer()
                    if model.isLoading {
                        ProgressView()
                    }
                }

                chart(segments: segments, air: air, heater: heater, heatPump: heatPump)
                    .frame(height: 320)

                legend

                Toggle("Air Temperature", isOn: $showAir)

                if let errorMessage = model.errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                Text("Drag the graph to move through time; pinch or use the magnifiers to zoom.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("\(water.title) Temperature")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
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
        .task(id: LoadKey(start: scrollPosition, length: visibleLength)) {
            // let scrolling and pinching settle before asking for more data
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else {
                return
            }
            let margin = visibleLength / 2
            let wanted = scrollPosition.addingTimeInterval(-margin)...min(now, scrollPosition.addingTimeInterval(visibleLength + margin))
            await model.ensureLoaded(wanted, serverAddress: serverAddress)
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.refreshInterval)
                let following = scrollPosition.addingTimeInterval(visibleLength) >= now.addingTimeInterval(-visibleLength / 20)
                now = .now
                if following {
                    scrollPosition = now.addingTimeInterval(-visibleLength)
                }
                if let through = model.loadedThrough {
                    await model.ensureLoaded(through...now, serverAddress: serverAddress)
                }
            }
        }
    }

    private func chart(segments: [TemperatureHistoryModel.Segment], air: [TemperatureHistoryModel.Sample],
                       heater: [TemperatureHistoryModel.Interval],
                       heatPump: [TemperatureHistoryModel.Interval]) -> some View {
        Chart {
            ForEach(heater) { interval in
                RectangleMark(xStart: .value("Heater starts", interval.start),
                              xEnd: .value("Heater stops", interval.end))
                    .foregroundStyle(Self.heaterColor.opacity(0.18))
            }
            ForEach(heatPump) { interval in
                RectangleMark(xStart: .value("Heat pump starts", interval.start),
                              xEnd: .value("Heat pump stops", interval.end))
                    .foregroundStyle(Self.heatPumpColor.opacity(0.16))
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
        }
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
                        Text("\(Int(degrees))°")
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                AxisGridLine()
                AxisValueLabel(format: visibleLength <= 2 * 24 * 60 * 60
                               ? .dateTime.hour()
                               : .dateTime.month(.abbreviated).day(),
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
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }

    private var legend: some View {
        HStack(spacing: 16) {
            legendItem(water.title) {
                Capsule().fill(Self.waterColor).frame(width: 18, height: 3)
            }
            if showAir {
                legendItem("Air") {
                    Capsule().fill(Self.airColor).frame(width: 18, height: 2)
                }
            }
            legendItem("Heater") {
                RoundedRectangle(cornerRadius: 2).fill(Self.heaterColor.opacity(0.35)).frame(width: 14, height: 12)
            }
            legendItem("Heat Pump") {
                RoundedRectangle(cornerRadius: 2).fill(Self.heatPumpColor.opacity(0.3)).frame(width: 14, height: 12)
            }
        }
        .font(.footnote)
    }

    private func legendItem(_ title: String, @ViewBuilder swatch: () -> some View) -> some View {
        HStack(spacing: 6) {
            swatch()
            Text(title)
        }
    }

    private var rangeDescription: String {
        let format = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        return "\(visibleRange.lowerBound.formatted(format)) – \(visibleRange.upperBound.formatted(format))"
    }

    /// Fits the readings in view, with a little room above and below.
    private func yDomain(segments: [TemperatureHistoryModel.Segment], air: [TemperatureHistoryModel.Sample]) -> ClosedRange<Double> {
        let range = visibleRange
        let visible = (segments.flatMap(\.samples) + air).filter { range.contains($0.date) }.map(\.value)
        guard let low = visible.min(), let high = visible.max() else {
            return 40...100
        }
        return (low - 3).rounded(.down)...(high + 3).rounded(.up)
    }

    private func show(length: TimeInterval, endingAt end: Date) {
        visibleLength = length
        scrollPosition = end.addingTimeInterval(-length)
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

#Preview {
    NavigationStack {
        TemperatureHistoryView(water: .pool)
    }
}
