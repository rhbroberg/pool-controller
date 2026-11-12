import PoolStatusCore
import SwiftUI

/// Pool, Spa Preheat and Spa Party, each a switch; a preheat can instead be scheduled to be
/// ready by a time, which shows plainly as scheduled until it starts.
struct TaskRows: View {
    @Environment(StatusStore.self) private var store
    @State private var schedulingPreheat = false

    private var isLocked: Bool { !store.auth.canControl || !store.isConnected }

    var body: some View {
        if let tasks = store.tasks {
            ForEach(PoolTask.allCases) { task in
                TaskRow(task: task, tasks: tasks, pending: store.pendingTasks[task], isLocked: isLocked,
                        set: { on in set(task, on: on) },
                        schedule: task == .spaPreheat ? { schedulingPreheat = true } : nil)
            }
            .sheet(isPresented: $schedulingPreheat) {
                PreheatScheduleView(current: tasks.scheduledPreheat?.readyAt) { readyAt in
                    set(.spaPreheat, on: true, readyAt: readyAt)
                }
            }
        } else {
            Text("This server doesn’t offer tasks yet. Use Equipment below.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .cardBackground()
        }
    }

    // the store's change outlives this view, so leaving the page doesn't stop it
    private func set(_ task: PoolTask, on: Bool, readyAt: Date? = nil) {
        Task { await store.setTask(task, on: on, readyAt: readyAt) }
    }
}

/// One task: what it does, whether it's on, turning on or off, or scheduled, and its switch.
private struct TaskRow: View {
    let task: PoolTask
    let tasks: TaskStatus
    let pending: Bool?
    let isLocked: Bool
    let set: (Bool) -> Void
    /// Opens the time picker; nil for tasks that can't be scheduled.
    let schedule: (() -> Void)?

    @ScaledMetric(relativeTo: .title3) private var iconSize: CGFloat = 36

    private var isOn: Bool { tasks.isOn(task) }
    private var scheduled: TaskStatus.ScheduledPreheat? { task == .spaPreheat && !isOn ? tasks.scheduledPreheat : nil }
    /// What the switch shows: the request while it's under way, and on while scheduled.
    private var shownOn: Bool { pending ?? (isOn || scheduled != nil) }

    private var tint: Color {
        switch task {
        case .pool: .blue
        case .spaPreheat: .orange
        case .spaParty: .pink
        }
    }

    private var status: (text: String, color: Color) {
        if let pending {
            return (pending ? String(localized: "Turning on…") : String(localized: "Turning off…"), .secondary)
        }
        if let scheduled {
            return (String(localized: "Scheduled · \(scheduled.readyText())"), .blue)
        }
        if isOn {
            return (String(localized: "On"), .green)
        }
        return (task.summary, .secondary)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: scheduled != nil ? "clock.fill" : task.systemImage)
                    .font(.title3)
                    .foregroundStyle(isOn || scheduled != nil ? .white : tint)
                    .frame(width: iconSize, height: iconSize)
                    .background(isOn ? tint : scheduled != nil ? Color.blue : tint.opacity(0.15), in: .rect(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .font(.headline)
                    Text(status.text)
                        .font(.caption.weight(isOn || scheduled != nil ? .semibold : .regular))
                        .foregroundStyle(status.color)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let scheduled, pending == nil {
                        Text(scheduled.startText())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                Toggle(task.title, isOn: Binding(get: { shownOn }, set: { set($0) }))
                    .labelsHidden()
                    .tint(scheduled != nil ? .blue : tint)
                    .disabled(isLocked || pending != nil)
            }
            if let schedule, !isOn {
                Button(action: schedule) {
                    Label(scheduled == nil ? String(localized: "Ready At…") : String(localized: "Change Time…"),
                          systemImage: "clock")
                        .font(.subheadline)
                }
                .buttonStyle(.borderless)
                .disabled(isLocked || pending != nil)
            }
        }
        .padding(12)
        .cardBackground(cornerRadius: Card.tileCornerRadius)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task-\(task.rawValue)")
    }
}

/// Picks when the spa should be ready; the server starts it only as early as it must.
private struct PreheatScheduleView: View {
    let current: Date?
    let schedule: (Date) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var readyAt = Date.now

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Ready At", selection: $readyAt, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                } footer: {
                    Text("The spa starts heating only as early as it needs to, to be at its setpoint by then. A time too soon to make starts it now.")
                }
            }
            .navigationTitle("Spa Preheat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schedule") {
                        dismiss()
                        schedule(readyAt)
                    }
                }
            }
            .onAppear {
                readyAt = current ?? .now
            }
        }
        .presentationDetents([.medium])
    }
}
