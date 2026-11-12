import PoolStatusCore
import SwiftUI

/// The time until the water is warm, beside the Heating heading; tapping it opens the details.
struct HeatingEstimateButton: View {
    let estimate: HeatingEstimate
    let action: () -> Void

    var body: some View {
        if let summary = estimate.summary() {
            Button(action: action) {
                HStack(spacing: 4) {
                    Image(systemName: estimate.status == .unreachable ? "thermometer.snowflake" : "clock")
                    Text(summary)
                        .monospacedDigit()
                }
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(summary)
            .accessibilityHint("Shows how it was worked out")
        }
    }
}

/// How the heating estimate was worked out: where the water and air are now, how fast each source
/// warms the water, what the model it came from was made of.
struct HeatingEstimateView: View {
    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private var estimate: HeatingEstimate? { store.heating?.estimate }

    var body: some View {
        NavigationStack {
            Form {
                if let estimate {
                    headline(estimate)
                    nowSection(estimate)
                    if let rate = estimate.rate {
                        rateSection(rate)
                    }
                    if let model = estimate.model {
                        modelSection(model)
                    }
                } else {
                    Section {
                        Text("Nothing is heating the water right now.")
                            .foregroundStyle(.secondary)
                    } footer: {
                        Text("An estimate appears while the pump runs and the heater or heat pump is calling for heat.")
                    }
                }
            }
            .navigationTitle("Heating Estimate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func headline(_ estimate: HeatingEstimate) -> some View {
        Section {
            if let summary = estimate.summary() {
                Text(summary)
                    .font(.headline)
            }
            if estimate.status == .ready {
                if let minutes = estimate.minutes {
                    LabeledContent("Time Remaining", value: HeatingEstimate.duration(minutes: minutes))
                }
                if let ready = estimate.readyText() {
                    LabeledContent("Ready About", value: ready)
                }
            }
        } footer: {
            Text(estimate.explanation)
        }
    }

    private func nowSection(_ estimate: HeatingEstimate) -> some View {
        Section("Now") {
            LabeledContent("\(estimate.body.title) Water", value: degrees(estimate.temperature))
            LabeledContent("Heating To", value: "\(estimate.setpoint)°")
            LabeledContent("Air", value: degrees(estimate.airTemperature))
            LabeledContent("Heating With", value: estimate.sources.compactMap(sourceTitle).joined(separator: ", "))
        }
    }

    private func rateSection(_ rate: HeatingEstimate.Rate) -> some View {
        Section {
            LabeledContent("Water Is Changing", value: HeatingEstimatesModel.rate(rate.net))
            if let heater = rate.heater, heater != 0 {
                LabeledContent("Heater", value: HeatingEstimatesModel.rate(heater))
            }
            if let heatPump = rate.heatPump, heatPump != 0 {
                LabeledContent("Heat Pump", value: HeatingEstimatesModel.rate(heatPump))
            }
            LabeledContent("Sun", value: HeatingEstimatesModel.rate(rate.solar))
            LabeledContent("Lost to the Air", value: HeatingEstimatesModel.rate(rate.loss))
        } header: {
            Text("Rate")
        } footer: {
            Text("Degrees per hour right now. Colder air costs more heat, and the heat pump gives less of it.")
        }
    }

    private func modelSection(_ model: HeatingEstimate.Model) -> some View {
        Section {
            LabeledContent("Calculated", value: model.calculatedAt.formatted(.dateTime.month(.abbreviated).day().year()))
            LabeledContent("Windows of History", value: model.windows.formatted())
            if let rSquared = model.rSquared {
                LabeledContent("Fit", value: String(localized: "\(Int((rSquared * 100).rounded()))% explained"))
            }
            if let range = model.airRange, range.count == 2 {
                LabeledContent("Air Temperatures Seen", value: "\(Int(range[0].rounded()))°–\(Int(range[1].rounded()))°")
            }
            ForEach(model.notes, id: \.self) { note in
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Learned From History")
        } footer: {
            Text("Estimates are less sure in weather the history doesn’t cover.")
        }
    }

    private func degrees(_ value: Double?) -> String {
        value.map { "\(Int($0.rounded()))°" } ?? "—"
    }

    private func sourceTitle(_ name: String) -> String? {
        HeatingDevice(rawValue: name)?.title
    }
}

#if DEBUG
#Preview {
    HeatingEstimateView()
        .environment(StatusStore.preview())
}
#endif
