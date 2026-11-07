import SwiftUI

struct StatusView: View {
    static let defaultServerAddress = "http://localhost:8080"
    static let defaultPoolName = "Pool"

    @AppStorage("serverAddress") private var serverAddress = StatusView.defaultServerAddress
    @AppStorage("poolName") private var poolName = StatusView.defaultPoolName
    @AppStorage("reconnectSeconds") private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = StatusStore()
    @State private var showingSettings = false
    /// Bumped to restart polling immediately, as from Retry Now.
    @State private var pollGeneration = 0

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    private struct PollKey: Equatable {
        let serverAddress: String
        let reconnectSeconds: Int
        let generation: Int
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if store.connection == .disconnected {
                        DisconnectedBanner(reason: store.connectionFailure,
                                           lastRefresh: store.lastRefresh,
                                           nextAttempt: store.nextAttempt,
                                           isRetrying: store.isLoading) {
                            pollGeneration += 1
                        }
                    }

                    if let errorMessage = store.errorMessage, store.isConnected {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
                    }

                    if !store.readings.isEmpty {
                        StatusCard(measurements: store.measurements)
                            .opacity(store.isConnected ? 1 : 0.5)

                        WaterFlowControl(current: store.waterMode,
                                         pending: store.pendingWaterMode,
                                         isEnabled: store.isConnected && store.canControl) { mode in
                            Task { await store.setWaterMode(mode, serverAddress: serverAddress) }
                        }
                        .opacity(store.isConnected ? 1 : 0.5)

                        HStack(spacing: 12) {
                            NavigationLink {
                                PanelView(store: store)
                            } label: {
                                PageButton(title: "Panel Control", systemImage: "dpad")
                            }
                            NavigationLink {
                                EventLogView()
                            } label: {
                                PageButton(title: "Event Log", systemImage: "list.bullet.rectangle")
                            }
                        }
                        .buttonStyle(.plain)

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Equipment")
                                .font(.title3.weight(.semibold))

                            LazyVGrid(columns: columns, spacing: 12) {
                                ForEach(EquipmentControl.all) { control in
                                    ControlTile(control: control,
                                                isOn: store.isOn(control),
                                                isPending: store.isPending(control.name),
                                                isLocked: store.credentials == nil) {
                                        toggle(control)
                                    }
                                }
                            }
                            .disabled(!store.isConnected || !store.canControl)
                            .opacity(store.isConnected ? 1 : 0.5)

                            if store.credentials == nil {
                                SignInPrompt(text: "Sign in to turn equipment on and off") {
                                    showingSettings = true
                                }
                            } else if !store.canControl {
                                Label("View only. Your account can see equipment but not change it.", systemImage: "eye")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        UpdateFooter(lastChange: store.lastSwitchChange, lastRefresh: store.lastRefresh)
                    }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .safeAreaInset(edge: .top, spacing: 0) {
                if store.needsAttention {
                    CheckSystemBar()
                }
            }
            .animation(.default, value: store.needsAttention)
            .overlay {
                if store.readings.isEmpty {
                    if store.connection == .connecting {
                        ProgressView("Connecting…")
                    } else if store.isConnected && store.errorMessage == nil {
                        ContentUnavailableView("No Readings", systemImage: "drop",
                                               description: Text("The server hasn’t recorded any status yet."))
                    }
                }
            }
            .navigationTitle(poolName.isEmpty ? Self.defaultPoolName : poolName)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConnectionIndicator(connection: store.connection)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") {
                        showingSettings = true
                    }
                }
            }
            .refreshable {
                await store.refresh(from: serverAddress)
            }
            .task(id: PollKey(serverAddress: serverAddress, reconnectSeconds: reconnectSeconds,
                              generation: pollGeneration)) {
                await store.poll(serverAddress: serverAddress, reconnectSeconds: reconnectSeconds)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    pollGeneration += 1
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView(serverAddress: $serverAddress, store: store)
            }
        }
    }

    private func toggle(_ control: EquipmentControl) {
        guard store.canControl else {
            return
        }
        let turnOn = !store.isOn(control)
        Task { await store.setControl(control, on: turnOn, serverAddress: serverAddress) }
    }
}

/// Pool, spa or spillover: shows the controller's mode and steps it to the one picked.
private struct WaterFlowControl: View {
    let current: WaterMode?
    let pending: WaterMode?
    let isEnabled: Bool
    let select: (WaterMode) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Water Flow", systemImage: "arrow.triangle.branch")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let pending {
                    ProgressView()
                        .controlSize(.small)
                    Text("Switching to \(pending.title)…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if current == nil {
                    Text("Waiting for the controller")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Picker("Water Flow", selection: Binding(get: { pending ?? current ?? .pool },
                                                   set: { select($0) })) {
                ForEach(WaterMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .disabled(!isEnabled || pending != nil || current == nil)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .contain)
    }
}

/// A button on the main page that opens another page.
private struct PageButton: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(Color.accentColor)
            Text(title)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
        .contentShape(.rect)
    }
}

private struct ConnectionIndicator: View {
    let connection: StatusStore.Connection

    private var title: String {
        switch connection {
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .disconnected: "Offline"
        }
    }

    private var color: Color {
        switch connection {
        case .connecting: .gray
        case .connected: .green
        case .disconnected: .red
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(title)
                .font(.subheadline)
                .fixedSize()
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Server \(title)")
    }
}

private struct DisconnectedBanner: View {
    let reason: String?
    let lastRefresh: Date?
    let nextAttempt: Date?
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Can’t reach the server", systemImage: "wifi.exclamationmark")
                .font(.headline)
                .foregroundStyle(.red)

            if let reason {
                Text(reason)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let lastRefresh {
                Text("Showing readings from \(lastRefresh, format: .dateTime.hour().minute().second())")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            HStack {
                if isRetrying {
                    ProgressView()
                    Text("Reconnecting…")
                } else if let nextAttempt, nextAttempt > .now {
                    Text("Retrying in \(Text(timerInterval: Date.now...nextAttempt, countsDown: true))")
                        .monospacedDigit()
                }
                Spacer()
                Button("Retry Now", action: retry)
                    .buttonStyle(.bordered)
                    .disabled(isRetrying)
            }
            .font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }
}

private struct CheckSystemBar: View {
    private static let amber = Color(red: 1.0, green: 0.75, blue: 0.0)

    var body: some View {
        Label("Check System", systemImage: "exclamationmark.triangle.fill")
            .font(.headline)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Self.amber, ignoresSafeAreaEdges: [])
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityLabel("Check system: the controller reports a fault")
    }
}

private struct StatusCard: View {
    let measurements: [Measurement]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(measurements.enumerated()), id: \.element.id) { index, measurement in
                if index > 0 {
                    Divider()
                }
                if let water = Self.historyWater[measurement.name] {
                    NavigationLink {
                        TemperatureHistoryView(water: water)
                    } label: {
                        cell(measurement, showsHistory: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows the temperature history")
                } else {
                    cell(measurement, showsHistory: false)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }

    /// Measurements that open a temperature history when tapped.
    private static let historyWater: [String: WaterBody] = ["pool temp": .pool, "spa temp": .spa]

    private func cell(_ measurement: Measurement, showsHistory: Bool) -> some View {
        VStack(spacing: 2) {
            Text(measurement.value)
                .font(.title2.monospacedDigit())
                .fontWeight(.semibold)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            HStack(spacing: 2) {
                Text(measurement.title)
                if showsHistory {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .contentShape(.rect)
        .foregroundStyle(measurement.isDimmed ? .tertiary : .primary)
        .accessibilityElement(children: .combine)
        .accessibilityHint(measurement.isDimmed ? "Its pump is off, so this reading may be old" : "")
    }
}

private struct ControlTile: View {
    let control: EquipmentControl
    let isOn: Bool
    let isPending: Bool
    /// Shows the state but can't be changed until the user signs in.
    let isLocked: Bool
    let action: () -> Void

    private var stateText: String {
        if isPending {
            return isOn ? "Turning \(control.onText)…" : "Turning Off…"
        }
        return isOn ? control.onText : "Off"
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: control.systemImage)
                    .symbolVariant(isOn ? .fill : .none)
                    .font(.title3)
                    .foregroundStyle(isOn ? control.tint : Color.secondary)
                    // icons differ in size; a fixed frame keeps the names lined up
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(control.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Text(stateText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if isPending {
                    ProgressView()
                        .controlSize(.small)
                } else if isLocked {
                    Image(systemName: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isOn ? Color(.secondarySystemGroupedBackground) : Color(.tertiarySystemFill),
                        in: .rect(cornerRadius: 18))
            .shadow(color: .black.opacity(isOn ? 0.08 : 0), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .disabled(isPending)
        .animation(.default, value: isOn)
        .sensoryFeedback(.selection, trigger: isOn)
        .accessibilityLabel(control.title)
        .accessibilityValue(stateText)
        .accessibilityHint(isLocked ? "Sign in to change" : "")
        .accessibilityAddTraits(.isToggle)
    }
}

private struct UpdateFooter: View {
    let lastChange: Date?
    let lastRefresh: Date?

    var body: some View {
        VStack(spacing: 4) {
            if let lastChange {
                Text("Last change \(lastChange, format: .relative(presentation: .named))")
            }
            if let lastRefresh {
                Text("Updated \(lastRefresh, format: .dateTime.hour().minute().second())")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    StatusView()
}
