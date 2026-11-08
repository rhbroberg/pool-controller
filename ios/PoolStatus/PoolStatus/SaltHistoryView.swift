import Charts
import PoolStatusCore
import SwiftUI

/// Salt level against time; salt changes slowly, so the ranges run longer than temperature's.
struct SaltHistoryView: View {
    enum Range: String, CaseIterable, Identifiable {
        case week = "Week", month = "Month", year = "Year"

        var id: String { rawValue }

        var title: String {
            switch self {
            case .week: String(localized: "Week")
            case .month: String(localized: "Month")
            case .year: String(localized: "Year")
            }
        }

        var length: TimeInterval {
            switch self {
            case .week: 7 * 24 * 60 * 60
            case .month: 30 * 24 * 60 * 60
            case .year: 365 * 24 * 60 * 60
            }
        }
    }

    static let lineColor = Color.teal

    @Environment(StatusStore.self) private var store
    @Environment(\.displayScale) private var displayScale
    @State private var model = SaltHistoryModel()
    /// Nil while showing days picked in the calendar.
    @State private var range: Range? = .month
    @State private var custom: ClosedRange<Date>?
    @State private var end = Date.now
    @State private var selectedDate: Date?
    @State private var choosingDates = false
    /// The plot's width, so a long range comes back as about one point per pixel.
    @State private var chartWidth: CGFloat = 360

    private var start: Date {
        custom?.lowerBound ?? end.addingTimeInterval(-(range ?? .month).length)
    }

    private var maxPoints: Int {
        min(HistoryResolution.maxPoints, max(50, Int(chartWidth * displayScale)))
    }

    private struct LoadKey: Equatable {
        let range: Range?
        let custom: ClosedRange<Date>?
        let maxPoints: Int
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Range", selection: $range) {
                ForEach(Range.allCases) { range in
                    Text(range.title).tag(Range?.some(range))
                }
                if custom != nil {
                    Text("Custom").tag(Range?.none)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: range) { _, newValue in
                if newValue != nil {
                    custom = nil
                }
            }

            HStack(alignment: .firstTextBaseline) {
                if let selectedDate, let value = value(at: selectedDate) {
                    Text(selectedDate, format: .dateTime.month(.abbreviated).day().year())
                        .foregroundStyle(.secondary)
                    Text("\(Int(value)) ppm")
                        .foregroundStyle(Self.lineColor)
                } else {
                    Text("\(start, format: .dateTime.month(.abbreviated).day().year()) – \(end, format: .dateTime.month(.abbreviated).day().year())")
                }
                Spacer(minLength: 0)
                if model.isLoading {
                    ProgressView()
                }
            }
            .font(.headline.monospacedDigit())
            .frame(minHeight: 24)

            chart
                .frame(minHeight: 160, maxHeight: .infinity)

            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            Text("Touch and hold the graph to read a level.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Salt Level")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Choose Dates", systemImage: "calendar") {
                    choosingDates = true
                }
            }
        }
        .sheet(isPresented: $choosingDates) {
            HistoryCalendarSheet(initialRange: start...end) { picked in
                custom = picked.lowerBound...min(picked.upperBound, .now)
                range = nil
            }
        }
        .task(id: LoadKey(range: range, custom: custom, maxPoints: maxPoints)) {
            end = custom?.upperBound ?? .now
            await model.load(from: start, to: end, maxPoints: maxPoints, client: store.client)
        }
    }

    private var chart: some View {
        Chart {
            // a long range comes back as buckets, each shaded across its lowest to highest level
            ForEach(model.samples.filter { $0.low != nil }) { sample in
                AreaMark(x: .value("Time", sample.date),
                         yStart: .value("Lowest", sample.low ?? sample.value),
                         yEnd: .value("Highest", sample.high ?? sample.value))
                    .foregroundStyle(Self.lineColor.opacity(0.16))
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
        .chartXScale(domain: start...end)
        .chartYScale(domain: yDomain)
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
        .chartYAxisLabel("ppm", position: .topLeading)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            chartWidth = width
        }
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

    /// Fits the readings, with room above and below.
    private var yDomain: ClosedRange<Double> {
        let values = model.samples.flatMap { [$0.value, $0.low, $0.high].compactMap(\.self) }
        guard let low = values.min(), let high = values.max() else {
            return 2000...4000
        }
        return max(0, (low - 200).rounded(.down))...(high + 200).rounded(.up)
    }

    private func value(at date: Date) -> Double? {
        model.samples.last { $0.date <= date }?.value
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
