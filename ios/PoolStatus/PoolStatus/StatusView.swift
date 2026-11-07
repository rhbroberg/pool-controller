import SwiftUI

struct StatusView: View {
    static let defaultServerAddress = "http://localhost:8080"

    @AppStorage("serverAddress") private var serverAddress = StatusView.defaultServerAddress
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
                VStack(alignment: .leading, spacing: 24) {
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
                        StatusCard(measurements: store.measurements, switches: store.statusSwitches)
                            .opacity(store.isConnected ? 1 : 0.5)

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Equipment")
                                .font(.title3.weight(.semibold))

                            LazyVGrid(columns: columns, spacing: 12) {
                                ForEach(EquipmentControl.all) { control in
                                    ControlTile(control: control,
                                                isOn: store.isOn(control.name),
                                                isPending: store.isPending(control.name)) {
                                        toggle(control)
                                    }
                                }
                            }
                            .disabled(!store.isConnected)
                            .opacity(store.isConnected ? 1 : 0.5)

                            if store.credentials == nil && store.isConnected {
                                Button("Sign in to turn equipment on and off") {
                                    showingSettings = true
                                }
                                .font(.footnote)
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
            .navigationTitle("Pool")
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
        guard store.credentials != nil else {
            showingSettings = true
            return
        }
        let turnOn = !store.isOn(control.name)
        Task { await store.setControl(control, on: turnOn, serverAddress: serverAddress) }
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
    let measurements: [StatusReading]
    let switches: [StatusReading]

    var body: some View {
        VStack(spacing: 16) {
            if !measurements.isEmpty {
                HStack(spacing: 0) {
                    ForEach(Array(measurements.enumerated()), id: \.element.id) { index, reading in
                        if index > 0 {
                            Divider()
                        }
                        VStack(spacing: 2) {
                            Text(reading.formattedValue)
                                .font(.title2.monospacedDigit())
                                .fontWeight(.semibold)
                                .lineLimit(1)
                                .minimumScaleFactor(0.6)
                            Text(reading.displayName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .accessibilityElement(children: .combine)
                    }
                }
            }

            if !switches.isEmpty {
                HStack(spacing: 8) {
                    ForEach(switches) { reading in
                        StatusChip(reading: reading)
                    }
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }
}

private struct StatusChip: View {
    let reading: StatusReading

    private var systemImage: String {
        switch reading.name {
        case "pool": "figure.pool.swim"
        case "spa": "bathtub"
        case "heater1": "flame"
        default: "circle"
        }
    }

    var body: some View {
        Label(reading.displayName, systemImage: systemImage)
            .font(.subheadline.weight(.medium))
            .symbolVariant(reading.isOn ? .fill : .none)
            .foregroundStyle(reading.isOn ? Color.white : Color.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(reading.isOn ? Color.accentColor : Color(.tertiarySystemFill), in: .capsule)
            .accessibilityLabel("\(reading.displayName) \(reading.isOn ? "on" : "off")")
    }
}

private struct ControlTile: View {
    let control: EquipmentControl
    let isOn: Bool
    let isPending: Bool
    let action: () -> Void

    private var stateText: String {
        if isPending {
            return isOn ? "Turning On…" : "Turning Off…"
        }
        return isOn ? "On" : "Off"
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Image(systemName: control.systemImage)
                        .symbolVariant(isOn ? .fill : .none)
                        .font(.title2)
                        .foregroundStyle(isOn ? control.tint : Color.secondary)
                    Spacer()
                    if isPending {
                        ProgressView()
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(control.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(stateText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
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
