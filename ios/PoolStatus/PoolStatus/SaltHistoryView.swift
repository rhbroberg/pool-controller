import Charts
import Observation
import SwiftUI

/// Salt level for one time window, from `GET /history`.
@Observable
final class SaltHistoryModel {
    static let readingName = "salt"

    private(set) var samples: [TemperatureHistoryModel.Sample] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    func load(from start: Date, to end: Date, serverAddress: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await StatusClient(serverAddress: serverAddress)
                .fetchHistory(names: [Self.readingName], from: start, to: end)
            let series = response.series.first { $0.name == Self.readingName }
            let points = (series?.before.map { [$0] } ?? []) + (series?.points ?? [])
            var loaded = points.compactMap { point in
                point.v.map { TemperatureHistoryModel.Sample(date: max(point.t, start), value: $0) }
            }
            // readings are stored when they change, so the last one holds until now
            if let last = loaded.last, last.date < end {
                loaded.append(TemperatureHistoryModel.Sample(date: end, value: last.value))
            }
            samples = loaded
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Salt level against time; salt changes slowly, so the ranges run longer than temperature's.
struct SaltHistoryView: View {
    enum Range: String, CaseIterable, Identifiable {
        case week = "Week", month = "Month", year = "Year"

        var id: String { rawValue }
        var length: TimeInterval {
            switch self {
            case .week: 7 * 24 * 60 * 60
            case .month: 30 * 24 * 60 * 60
            case .year: 365 * 24 * 60 * 60
            }
        }
    }

    static let lineColor = Color.teal

    @AppStorage("serverAddress") private var serverAddress = StatusView.defaultServerAddress
    @State private var model = SaltHistoryModel()
    @State private var range = Range.month
    @State private var end = Date.now
    @State private var selectedDate: Date?

    private var start: Date { end.addingTimeInterval(-range.length) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Range", selection: $range) {
                ForEach(Range.allCases) { range in
                    Text(range.rawValue).tag(range)
                }
            }
            .pickerStyle(.segmented)

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
        .task(id: range) {
            end = .now
            await model.load(from: start, to: end, serverAddress: serverAddress)
        }
    }

    private var chart: some View {
        Chart {
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
        .overlay {
            if model.samples.isEmpty && !model.isLoading && model.errorMessage == nil {
                Text("No salt readings in this range")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }

    /// Fits the readings, with room above and below.
    private var yDomain: ClosedRange<Double> {
        let values = model.samples.map(\.value)
        guard let low = values.min(), let high = values.max() else {
            return 2000...4000
        }
        return max(0, (low - 200).rounded(.down))...(high + 200).rounded(.up)
    }

    private func value(at date: Date) -> Double? {
        model.samples.last { $0.date <= date }?.value
    }
}

#Preview {
    NavigationStack {
        SaltHistoryView()
    }
}
