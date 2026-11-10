import PoolStatusCore
import SwiftUI

/// Reading stored history again with the server's current protocol code, as after a parser fix:
/// pick the range and the kinds of event, preview what would change, then rewrite it.
struct ReprocessHistoryView: View {
    @Environment(StatusStore.self) private var store
    @State private var model = ReprocessModel()
    @State private var confirming = false

    var body: some View {
        Form {
            Section {
                DatePicker("From", selection: $model.from, in: ...Date.now)
                DatePicker("To", selection: $model.to, in: ...Date.now)
            } header: {
                Text("Range")
            } footer: {
                if let problem = model.rangeProblem {
                    Text(problem)
                        .foregroundStyle(.orange)
                } else {
                    Text("Reprocessing stops just before the end.")
                }
            }

            Section {
                ForEach(EventKind.reprocessable) { kind in
                    Toggle(isOn: Binding(
                        get: { model.kinds.contains(kind) },
                        set: { on in
                            if on {
                                model.kinds.insert(kind)
                            } else {
                                model.kinds.remove(kind)
                            }
                        })) {
                        Label(kind.title, systemImage: kind.systemImage)
                    }
                }
            } header: {
                Text("Events")
            } footer: {
                Text("The kinds of event read again from their stored frames; the others stay as they are. Communication errors hold the frames the server couldn’t read. Readings and equipment also lose repeats of a value the server once stored again.")
            }

            Section {
                Button("Preview") {
                    Task { await model.start(dryRun: true, store: store) }
                }
                .disabled(!model.canStart(isAdmin: store.auth.isAdmin))
                Button("Reprocess", role: .destructive) {
                    confirming = true
                }
                .disabled(!model.canStart(isAdmin: store.auth.isAdmin))
            } footer: {
                Text("The server reads each stored frame again with its current decoding and keeps what changed, as if it had read them that way at the time. Frames that now change nothing are removed. Preview counts the changes without making them.")
            }

            if let errorMessage = model.errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }

            if let run = model.run {
                runSection(run)
            }

            if store.auth.credentials == nil {
                Section {
                    Text("Sign in as an admin to reprocess history.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(!store.auth.isAdmin)
        .navigationTitle("Reprocess History")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Reprocess history?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Reprocess", role: .destructive) {
                Task { await model.start(dryRun: false, store: store) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Events from \(model.from, format: .dateTime) to \(model.to, format: .dateTime) are rewritten from their stored frames, and ones that now change nothing are removed. This can’t be undone. The history summaries are then redone from the start of the range.")
        }
        .task(id: store.auth.isAdmin) {
            if store.auth.isAdmin {
                await model.load(store: store)
            }
        }
        .task(id: model.run?.isActive == true) {
            await model.follow(store: store)
        }
    }

    private func runSection(_ run: ReprocessRun) -> some View {
        Section {
            HStack {
                Text(ReprocessModel.stateText(run))
                    .foregroundStyle(run.state == .failed ? Color.orange : .primary)
                Spacer(minLength: 8)
                if run.isActive {
                    ProgressView()
                }
            }
            LabeledContent("Range", value: "\(run.from.formatted(.dateTime.month(.abbreviated).day().year().hour().minute())) – \(run.to.formatted(.dateTime.month(.abbreviated).day().year().hour().minute()))")
            ForEach(ReprocessModel.rows(run)) { row in
                LabeledContent(row.title, value: row.count.formatted())
            }
        } header: {
            Text(run.dryRun ? "Preview" : "Last Run")
        } footer: {
            if let footer = ReprocessModel.footer(run) {
                Text(footer)
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ReprocessHistoryView()
    }
    .environment(StatusStore.preview())
}
#endif
