import PoolStatusCore
import SwiftUI

/// Teaching the server how long the water takes to warm: look through history for the windows to
/// learn from, choose which to use, calculate a model and compare it with the one in use, then
/// save it.
struct HeatingEstimatesView: View {
    @Environment(StatusStore.self) private var store
    @State private var model = HeatingEstimatesModel()
    @State private var confirming = false

    var body: some View {
        Form {
            HeatingRulesSections(model: model.state?.model)
            rangeSection
            findSection
            ForEach(model.bodiesWithWindows) { water in
                windowsSection(water)
            }
            if model.scan?.state == .finished {
                calculateSection
            }
            if let preview = model.preview {
                previewSections(preview)
            } else if let current = model.state?.model {
                inUseSections(current)
            }

            if let errorMessage = model.errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            if let savedMessage = model.savedMessage {
                Section {
                    Label(savedMessage, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
        }
        .disabled(!store.auth.isAdmin)
        .navigationTitle("Heating Estimates")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Save this model?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Save Model") {
                Task { await model.save(store: store) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every heating estimate, in every app, uses it from now on. The model in use is kept as a record.")
        }
        .task(id: store.auth.isAdmin) {
            if store.auth.isAdmin {
                await model.load(store: store)
            }
        }
        .task(id: model.scan?.isActive == true) {
            await model.follow(store: store)
        }
    }

    // MARK: Looking

    private var rangeSection: some View {
        Section {
            DatePicker("From", selection: Binding(get: { model.from }, set: { model.from = $0; model.rangeEdited() }),
                       in: ...Date.now)
            DatePicker("To", selection: Binding(get: { model.to }, set: { model.to = $0; model.rangeEdited() }),
                       in: ...Date.now)
        } header: {
            Text("History to Learn From")
        } footer: {
            if let problem = model.rangeProblem {
                Text(problem)
                    .foregroundStyle(.orange)
            } else {
                Text("Starts as all the history before the simulated data begins in 2026.")
            }
        }
    }

    private var findSection: some View {
        Section {
            Button("Find Windows") {
                Task { await model.find(store: store) }
            }
            .disabled(!model.canFind(isAdmin: store.auth.isAdmin))
            if let scan = model.scan {
                HStack {
                    Text(HeatingEstimatesModel.stateText(scan))
                        .foregroundStyle(scan.state == .failed ? Color.orange : .primary)
                    Spacer(minLength: 8)
                    if scan.isActive {
                        ProgressView()
                    }
                }
                if let summary = scan.summary, scan.state == .finished {
                    LabeledContent("Suitable", value: "\(summary.suitable.formatted()) of \(summary.windows.formatted())")
                    ForEach(summary.reasons) { reason in
                        LabeledContent(reason.reason.prefix(1).uppercased() + reason.reason.dropFirst(), value: reason.count.formatted())
                            .font(.footnote)
                    }
                }
            }
        } header: {
            Text("Windows")
        } footer: {
            Text("A window is a stretch while the pump ran and the heater or heat pump stayed the same, with how fast the water warmed or cooled in it. Raw history is only kept so long, so windows come only from what is still stored.")
        }
    }

    // MARK: Choosing

    private func windowsSection(_ water: WaterBody) -> some View {
        Section {
            ForEach(HeatingWindowKind.allCases) { kind in
                if model.windows(for: water, kind: kind).contains(where: \.suitable) {
                    Toggle(isOn: Binding(
                        get: { model.kinds.contains(kind) },
                        set: { on in
                            if on {
                                model.kinds.insert(kind)
                            } else {
                                model.kinds.remove(kind)
                            }
                        })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(kind.title)
                            Text(model.detail(water, kind))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            NavigationLink("Review Windows") {
                HeatingWindowsView(model: model, water: water)
            }
        } header: {
            Text(String(localized: "\(water.title) Windows"))
        } footer: {
            Text("\(model.includedCount(water)) windows will be used. A kind turned off is left out entirely; Review Windows turns off single ones.")
        }
    }

    private var calculateSection: some View {
        Section {
            Button {
                Task { await model.calculate(store: store) }
            } label: {
                HStack {
                    Text("Calculate")
                    Spacer(minLength: 8)
                    if model.calculating {
                        ProgressView()
                    }
                }
            }
            .disabled(!model.canCalculate(isAdmin: store.auth.isAdmin))
        } footer: {
            Text("Works out the model from the windows used and shows it beside the one in use. Nothing is saved until you save it.")
        }
    }

    // MARK: Results

    @ViewBuilder
    private func previewSections(_ preview: HeatingModelPreview) -> some View {
        ForEach(WaterBody.allCases) { water in
            if let result = preview.bodies[water] {
                modelSection(title: String(localized: "New \(water.title) Model"), result: result, footer: nil)
                let samples = preview.samples.filter { $0.body == water }
                if !samples.isEmpty {
                    Section {
                        ForEach(samples) { sample in
                            LabeledContent(sample.sources.title) {
                                Text(HeatingEstimatesModel.sampleText(sample))
                                    .font(.footnote)
                                    .multilineTextAlignment(.trailing)
                            }
                        }
                    } header: {
                        Text(String(localized: "What the New \(water.title) Model Says"))
                    } footer: {
                        Text("Warming ten degrees, with the sun half out, at a few air temperatures.")
                    }
                }
            }
        }
        if let current = preview.current {
            inUseSections(current)
        } else {
            Section {
                Text("No model is saved yet.")
                    .foregroundStyle(.secondary)
            } header: {
                Text("In Use Now")
            }
        }
        Section {
            Button("Save Model") {
                confirming = true
            }
            .disabled(!model.canSave(isAdmin: store.auth.isAdmin))
            Button("Discard", role: .cancel) {
                model.discard()
            }
        } footer: {
            Text(preview.canSave
                 ? String(localized: "Built from \(preview.windowsUsed.formatted()) windows.")
                 : String(localized: "No body of water has enough windows to make a model. Use more of them."))
        }
    }

    @ViewBuilder
    private func inUseSections(_ current: HeatingModel) -> some View {
        ForEach(WaterBody.allCases) { water in
            if let result = current.bodies[water] {
                modelSection(title: String(localized: "\(water.title) Model in Use"), result: result,
                             footer: water == WaterBody.allCases.first
                                ? String(localized: "Calculated \(current.createdAt.formatted(.dateTime.month(.abbreviated).day().year())) from history \(current.range.from.formatted(.dateTime.month(.abbreviated).year())) – \(current.range.to.formatted(.dateTime.month(.abbreviated).year())).")
                                : nil)
            }
        }
    }

    private func modelSection(title: String, result: HeatingBodyModel, footer: String?) -> some View {
        Section {
            ForEach(Array(HeatingEstimatesModel.lines(result).enumerated()), id: \.offset) { _, line in
                LabeledContent(line.title) {
                    Text(line.value)
                        .multilineTextAlignment(.trailing)
                }
            }
            if let quality = result.quality {
                LabeledContent("Quality", value: quality)
            }
            if let windows = result.windows {
                LabeledContent("Windows", value: windows.total.formatted())
            }
            ForEach(result.notes ?? [], id: \.self) { note in
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(title)
        } footer: {
            if let footer {
                Text(footer)
            }
        }
    }
}

/// Every window of one body of water, each with a switch to leave it out of the model.
struct HeatingWindowsView: View {
    let model: HeatingEstimatesModel
    let water: WaterBody

    var body: some View {
        List {
            ForEach(HeatingWindowKind.allCases) { kind in
                let windows = model.windows(for: water, kind: kind).sorted { $0.start > $1.start }
                if !windows.isEmpty {
                    Section {
                        ForEach(windows) { window in
                            row(window)
                        }
                    } header: {
                        Text(kind.title)
                    } footer: {
                        Text(kind.detail)
                    }
                }
            }
        }
        .navigationTitle(String(localized: "\(water.title) Windows"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ window: HeatingWindow) -> some View {
        Toggle(isOn: Binding(
            get: { model.isIncluded(window) },
            set: { model.setIncluded(window, $0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(window.start.formatted(.dateTime.month(.abbreviated).day().year().hour().minute()))
                Text(detail(window))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .disabled(!window.suitable)
    }

    private func detail(_ window: HeatingWindow) -> String {
        if !window.suitable {
            return window.reason.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? String(localized: "Not suitable")
        }
        let hours = window.hours.formatted(.number.precision(.fractionLength(1)))
        let rate = window.slope.map { HeatingEstimatesModel.rate($0) } ?? "—"
        let air = window.airTemperature.map { "\(Int($0.rounded()))°" } ?? "—"
        return String(localized: "\(hours) h · \(rate) · air \(air)")
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        HeatingEstimatesView()
    }
    .environment(StatusStore.preview())
}
#endif
