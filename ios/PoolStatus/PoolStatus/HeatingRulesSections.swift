import PoolStatusCore
import SwiftUI

/// How each body of water's heating is timed: each source's rate as learned from history, or
/// the heating rule standing in for it and why, which an admin sets here; and how much earlier a
/// scheduled spa preheat starts.
struct HeatingRulesSections: View {
    /// The model in use; nil until one is saved.
    let model: HeatingModel?

    @Environment(StatusStore.self) private var store
    @State private var settings: ServerSettings?
    @State private var errorMessage: String?

    static let poolRates: [Double] = [0.25, 0.5, 0.75, 1, 1.5, 2, 3]
    static let spaRates: [Double] = [2, 4, 6, 10, 15, 20, 30, 40, 60]
    static let marginChoices = [0, 10, 15, 30, 45, 60]

    /// The usual choices, with the current one among them even when it was set some other way.
    static func choices<Value: Hashable & Comparable>(_ usual: [Value], keeping current: Value) -> [Value] {
        Array(Set(usual + [current])).sorted()
    }

    var body: some View {
        Group {
            if let rules = settings?.heatingRules {
                ForEach(WaterBody.allCases) { water in
                    Section {
                        ForEach(HeatingDevice.allCases) { device in
                            row(device, water, rules)
                        }
                        if water == .spa, let margin = settings?.preheatMarginMinutes {
                            marginPicker(margin)
                        }
                    } header: {
                        Text(String(localized: "How the \(water.title) Is Timed"))
                    } footer: {
                        Text(footer(water))
                    }
                }
            }
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            } else if settings == nil {
                // a view with nothing in it never appears, so it would never load
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .task(id: store.auth.isAdmin) {
            if store.auth.isAdmin {
                await load()
            }
        }
    }

    @ViewBuilder
    private func row(_ device: HeatingDevice, _ water: WaterBody, _ rules: HeatingRules) -> some View {
        switch HeatingRules.basis(of: device, for: water, in: model) {
        case .learned(let perHour):
            LabeledContent {
                Text(HeatingEstimatesModel.rate(perHour))
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.title)
                    Text("Learned from history")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            }
        case .rule(let why):
            let current = rules.rate(device, for: water)
            Picker(selection: Binding(
                get: { current },
                set: { rate in Task { await apply(.init(heatingRule: HeatingRuleChange(body: water, device: device, rate: rate))) } })) {
                ForEach(Self.choices(water == .pool ? Self.poolRates : Self.spaRates, keeping: current), id: \.self) { rate in
                    Text(HeatingEstimatesModel.rate(rate)).tag(rate)
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.title)
                    Text("By rule · \(why)")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private func marginPicker(_ margin: Int) -> some View {
        Picker("Preheat Starts Early By", selection: Binding(
            get: { margin },
            set: { minutes in Task { await apply(.init(preheatMarginMinutes: minutes)) } })) {
            ForEach(Self.choices(Self.marginChoices, keeping: margin), id: \.self) { minutes in
                Text(Duration.seconds(minutes * 60), format: .units(allowed: [.hours, .minutes], width: .abbreviated))
                    .tag(minutes)
            }
        }
    }

    private func footer(_ water: WaterBody) -> String {
        let rules = String(localized: "A rule stands in for what history hasn’t shown yet, and its estimates say “by rule”. A model that learns the rate takes over from it.")
        guard water == .spa else {
            return rules
        }
        return "\(rules) \(String(localized: "A spa preheat scheduled to be ready by a time starts this much earlier than it needs to."))"
    }

    private func load() async {
        do {
            settings = try await store.serverSettings()
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func apply(_ changes: ServerSettings.Changes) async {
        do {
            settings = try await store.updateServerSettings(changes)
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }
}
