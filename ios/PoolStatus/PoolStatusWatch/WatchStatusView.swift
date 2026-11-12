import PoolStatusCore
import SwiftUI

/// The pool at a glance, then the few switches the watch offers. Everything else, setup and
/// signing in included, stays on the iPhone, and nothing from the pool shows until the iPhone
/// has sent both a server and a sign-in.
struct WatchStatusView: View {
    static let defaultPoolName = "Pool"

    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.poolName) private var poolName = WatchStatusView.defaultPoolName
    @Environment(\.scenePhase) private var scenePhase
    /// Bumped to refresh at once when the app comes back to the front.
    @State private var pollGeneration = 0

    private struct PollKey: Equatable {
        let serverAddress: String
        let isSignedIn: Bool
        let generation: Int
    }

    private var isSignedIn: Bool { store.auth.credentials != nil }

    var body: some View {
        NavigationStack {
            if store.serverAddress.isEmpty {
                OnPhone(systemImage: "iphone",
                        title: "Set Up on iPhone",
                        message: "Open Pool Status on your iPhone and connect it to your pool’s server.")
            } else if !isSignedIn {
                OnPhone(systemImage: "lock.fill",
                        title: "Sign In on iPhone",
                        message: "Open Pool Status on your iPhone and sign in to see and control the pool.")
            } else {
                TabView {
                    GlancePage(title: poolName.isEmpty ? Self.defaultPoolName : poolName)
                    TasksPage()
                }
                .tabViewStyle(.verticalPage)
            }
        }
        .task(id: PollKey(serverAddress: store.serverAddress, isSignedIn: isSignedIn, generation: pollGeneration)) {
            guard !store.serverAddress.isEmpty, isSignedIn else {
                return
            }
            await store.poll(reconnectSeconds: StatusStore.defaultReconnectSeconds)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                pollGeneration += 1
            }
        }
        .sensoryFeedback(.success, trigger: store.confirmedChanges)
    }
}

/// Shown until the iPhone app has sent a server and a sign-in, with why asking it hasn't worked yet.
private struct OnPhone: View {
    let systemImage: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey

    @Environment(PhoneLink.self) private var phone

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.headline)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if phone.isAsking {
                    ProgressView()
                } else {
                    if let problem = phone.problem {
                        Text(problem)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    Button("Try Again") {
                        phone.requestContext()
                    }
                }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
        }
    }
}

// MARK: - Glance

/// Temperatures, where the water flows, and what's heating it.
private struct GlancePage: View {
    let title: String

    @Environment(StatusStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if store.connection == .disconnected {
                    Label("Can’t reach the server", systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                if store.readings.isEmpty {
                    if store.connection == .connecting {
                        ProgressView("Connecting…")
                            .frame(maxWidth: .infinity)
                    } else if store.isConnected {
                        Text("The server hasn’t recorded any status yet.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    temperatures
                    Divider()
                    flowAndHeating
                    FreshnessLine(lastRefresh: store.lastRefresh, isConnected: store.isConnected)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(title)
    }

    private var temperatures: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                ForEach(WaterBody.allCases) { body in
                    WaterTemperature(reading: store.measurement(named: body.temperatureName),
                                     pumpRunning: store.pumpRunning(for: body))
                }
            }
            SmallReading(reading: store.measurement(named: .airTemperature))
        }
    }

    @ViewBuilder
    private var flowAndHeating: some View {
        if let mode = store.waterMode {
            Label {
                Text(mode.title)
            } icon: {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundStyle(Color.accentColor)
            }
            .font(.footnote)
            .accessibilityLabel("Water flow: \(mode.title)")
        }
        ForEach(HeatingDevice.allCases) { device in
            if let control = EquipmentControl.control(named: device.controlName), store.isOn(control) {
                HeatingRow(device: device, tint: control.tint.color, status: store.heating(for: control))
            }
        }
        if let scheduled = store.tasks?.scheduledPreheat, store.tasks?.spaPreheat == false {
            Label {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Spa preheat scheduled")
                    Text(scheduled.readyText())
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "clock.fill")
                    .foregroundStyle(.blue)
            }
            .font(.footnote)
        }
        if let estimate = store.heating?.estimate, estimate.isShown, let summary = estimate.summary() {
            Label {
                Text(summary)
                    .monospacedDigit()
            } icon: {
                Image(systemName: estimate.status == .unreachable ? "thermometer.snowflake" : "clock")
                    .foregroundStyle(Color.accentColor)
            }
            .font(.footnote)
        }
    }
}

/// The pool's or spa's temperature, and whether the pump feeding its sensor runs; while it's off,
/// the reading is from when it last ran.
private struct WaterTemperature: View {
    let reading: DashboardReading
    let pumpRunning: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(reading.title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(reading.value)
                .font(.system(size: 30, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .foregroundStyle(pumpRunning ? .primary : .secondary)
            Label(pumpRunning ? "Pump on" : "Pump off",
                  systemImage: pumpRunning ? "play.circle.fill" : "pause.circle.fill")
                .font(.caption2)
                .foregroundStyle(pumpRunning ? Color.green : Color.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct SmallReading: View {
    let reading: DashboardReading

    var body: some View {
        HStack(spacing: 4) {
            Text(reading.title)
                .foregroundStyle(.secondary)
            Text(reading.value)
                .fontWeight(.semibold)
                .monospacedDigit()
                .foregroundStyle(reading.isDimmed ? .secondary : .primary)
        }
        .font(.footnote)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityElement(children: .combine)
    }
}

/// A heater or heat pump that's switched on, and what it's doing.
private struct HeatingRow: View {
    let device: HeatingDevice
    let tint: Color
    let status: HeatingStatus.Device?

    private var detail: String {
        guard let status else {
            return String(localized: "On")
        }
        // with no pump running, no water reaches the heaters
        guard let body = status.body else {
            return String(localized: "Pump off")
        }
        if status.heating {
            guard let setpoint = status.setpoint else {
                return String(localized: "Heating \(body.title)")
            }
            return String(localized: "Heating \(body.title) to \(setpoint)°")
        }
        if status.callingForHeat {
            return String(localized: "Waiting · \(body.title)")
        }
        return String(localized: "\(body.title) at setpoint")
    }

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 0) {
                Text(device.title)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: device == .heater1 ? "flame.fill" : "heat.waves")
                .foregroundStyle(tint)
        }
        .font(.footnote)
        .accessibilityElement(children: .combine)
    }
}

/// How old the readings on screen are, in words.
private struct FreshnessLine: View {
    let lastRefresh: Date?
    let isConnected: Bool

    var body: some View {
        if let lastRefresh {
            TimelineView(.periodic(from: .now, by: 15)) { context in
                let when = context.date.timeIntervalSince(lastRefresh) < 60
                    ? String(localized: "just now")
                    : lastRefresh.formatted(.relative(presentation: .named))
                Text(isConnected ? "Updated \(when)" : "Last reading \(when)")
                    .font(.caption2)
                    .foregroundStyle(isConnected ? Color.secondary : Color.orange)
            }
        }
    }
}

// MARK: - Tasks

/// Pool, Spa Preheat and Spa Party, for accounts that may change equipment; a preheat scheduled
/// on the iPhone shows as scheduled, with when it will be ready.
private struct TasksPage: View {
    @Environment(StatusStore.self) private var store

    var body: some View {
        List {
            if let errorMessage = store.errorMessage, store.isConnected {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let tasks = store.tasks {
                Section {
                    ForEach(PoolTask.allCases) { task in
                        TaskRow(task: task, tasks: tasks, pending: store.pendingTasks[task],
                                isLocked: !store.auth.canControl) { on in
                            // the store's change outlives this view, so the watch can go back to sleep
                            Task { await store.setTask(task, on: on) }
                        }
                    }
                } header: {
                    accessNote
                }
                .disabled(!store.isConnected)
            } else {
                Text("This server doesn’t offer tasks yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Tasks")
    }

    @ViewBuilder
    private var accessNote: some View {
        if !store.auth.canControl {
            Label("View only. Your account can’t change equipment.", systemImage: "eye")
        }
    }
}

private struct TaskRow: View {
    let task: PoolTask
    let tasks: TaskStatus
    /// The state asked for and not yet confirmed.
    let pending: Bool?
    let isLocked: Bool
    let set: (Bool) -> Void

    private var isOn: Bool { tasks.isOn(task) }
    private var scheduled: TaskStatus.ScheduledPreheat? { task == .spaPreheat && !isOn ? tasks.scheduledPreheat : nil }

    private var tint: Color {
        switch task {
        case .pool: .blue
        case .spaPreheat: .orange
        case .spaParty: .pink
        }
    }

    private var status: String {
        if let pending {
            return pending ? String(localized: "Turning on…") : String(localized: "Turning off…")
        }
        if let scheduled {
            return String(localized: "Scheduled · \(scheduled.readyText())")
        }
        return isOn ? String(localized: "On") : String(localized: "Off")
    }

    var body: some View {
        Toggle(isOn: Binding(get: { pending ?? (isOn || scheduled != nil) }, set: { set($0) })) {
            HStack(spacing: 8) {
                Image(systemName: scheduled != nil ? "clock.fill" : task.systemImage)
                    .foregroundStyle(scheduled != nil ? Color.blue : isOn ? tint : Color.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 0) {
                    Text(task.title)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(status)
                        .font(.caption2)
                        .foregroundStyle(scheduled != nil ? Color.blue : .secondary)
                        .lineLimit(2)
                    if let scheduled, pending == nil {
                        Text(scheduled.startText())
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .tint(scheduled != nil ? .blue : tint)
        .disabled(isLocked || pending != nil)
    }
}

extension Tint {
    var color: Color {
        switch self {
        case .pink: .pink
        case .orange: .orange
        case .blue: .blue
        case .cyan: .cyan
        case .yellow: .yellow
        case .green: .green
        case .mint: .mint
        case .teal: .teal
        case .indigo: .indigo
        }
    }
}

#if DEBUG
#Preview("Operator") {
    WatchStatusView()
        .environment(StatusStore.preview())
}

#Preview("Viewer") {
    WatchStatusView()
        .environment(StatusStore.preview(role: .viewer))
}
#endif
