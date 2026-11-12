import PoolStatusCore
import SwiftUI

/// The pool and spa setpoints for the heater or the heat pump.
struct SetpointView: View {
    let device: HeatingDevice

    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var drafts: [WaterBody: Int] = [:]
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var heating: HeatingStatus? { store.heating }

    private var hasChanges: Bool {
        WaterBody.allCases.contains { body in
            drafts[body] != nil && drafts[body] != heating?.setpoint(device, for: body)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(WaterBody.allCases) { water in
                        Stepper(value: binding(for: water), in: heating?.range ?? 65...104) {
                            LabeledContent {
                                Text("\(drafts[water] ?? 0)°F")
                                    .monospacedDigit()
                                    .foregroundStyle(.primary)
                            } label: {
                                Text(water.title)
                                if water == heating?.target {
                                    Text("Water is flowing here now")
                                }
                            }
                        }
                    }
                } footer: {
                    Text(explanation)
                }
                .disabled(!store.auth.canControl || isSaving)

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("\(device.title) Setpoints")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(store.auth.canControl ? "Cancel" : "Done") { dismiss() }
                }
                if store.auth.canControl {
                    ToolbarItem(placement: .confirmationAction) {
                        if isSaving {
                            ProgressView()
                        } else {
                            Button("Save") {
                                errorMessage = nil
                                isSaving = true
                            }
                            .disabled(!hasChanges)
                        }
                    }
                }
            }
            .onAppear(perform: loadDrafts)
        }
        .presentationDetents([.medium, .large])
        .task(id: isSaving) {
            if isSaving {
                await save()
            }
        }
    }

    private var explanation: String {
        var parts = [device == .heater1
            ? String(localized: "The heater heats the spa while the spa filter runs, and otherwise the pool while the filter runs in Pool or Spillover flow. Once that water reaches its setpoint it stops, and starts again when the water cools below it.")
            : String(localized: "The heat pump heats the spa while the spa filter runs, and otherwise the pool while the filter runs in Pool or Spillover flow. Once that water reaches its setpoint it stops, and starts again when the water cools below it.")]
        if heating?.setpointsReachController == false {
            parts.append(String(localized: "For now the server keeps these setpoints itself; they aren’t read from or sent to the controller yet."))
        }
        if !store.auth.canControl {
            parts.append(String(localized: "Your account can see the setpoints but not change them."))
        }
        return parts.joined(separator: " ")
    }

    private func binding(for water: WaterBody) -> Binding<Int> {
        Binding(get: { drafts[water] ?? heating?.setpoint(device, for: water) ?? 80 },
                set: { drafts[water] = $0 })
    }

    private func loadDrafts() {
        for water in WaterBody.allCases {
            drafts[water] = heating?.setpoint(device, for: water)
        }
    }

    private func save() async {
        do {
            try await store.setSetpoints(drafts, device: device)
            dismiss()
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        isSaving = false
    }
}
