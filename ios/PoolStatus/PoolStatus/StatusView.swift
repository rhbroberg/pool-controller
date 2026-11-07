import SwiftUI

struct StatusView: View {
    /// Empty until the first server answers, which sends a new install to `ServerSetupView`.
    static let defaultServerAddress = ""
    static let defaultPoolName = "Pool"
    /// Keeps the page readable on iPad and in landscape.
    static let maximumWidth: CGFloat = 640

    @AppStorage("serverAddress") private var serverAddress = StatusView.defaultServerAddress
    @AppStorage("poolName") private var poolName = StatusView.defaultPoolName
    @AppStorage("reconnectSeconds") private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = StatusStore()
    @State private var showingSettings = false
    /// Bumped to restart polling immediately, as from Retry.
    @State private var pollGeneration = 0
    /// A change waiting for the user to confirm it.
    @State private var confirming: ChangeRequest?

    private struct PollKey: Equatable {
        let serverAddress: String
        let reconnectSeconds: Int
        let generation: Int
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                // sized so the whole dashboard fits on one iPhone screen without scrolling
                VStack(alignment: .leading, spacing: 14) {
                    if store.connection == .disconnected {
                        OfflineBanner(host: ServerAddress.display(serverAddress),
                                      reason: store.connectionFailure,
                                      nextAttempt: store.nextAttempt,
                                      isRetrying: store.isLoading,
                                      retry: { pollGeneration += 1 },
                                      change: { showingSettings = true })
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
                        dashboard
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
                .frame(maxWidth: Self.maximumWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Color(.systemGroupedBackground))
            .safeAreaInset(edge: .top, spacing: 0) {
                if store.needsAttention {
                    CheckSystemBar()
                }
            }
            .animation(.default, value: store.needsAttention)
            .overlay {
                if store.readings.isEmpty && !serverAddress.isEmpty {
                    if store.connection == .connecting {
                        ProgressView("Connecting…")
                    } else if store.isConnected && store.errorMessage == nil {
                        ContentUnavailableView("No Readings", systemImage: "drop",
                                               description: Text("The server hasn’t recorded any status yet."))
                    }
                }
            }
            .navigationTitle(poolName.isEmpty ? Self.defaultPoolName : poolName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if store.connection != .connected {
                        ConnectionIndicator(connection: store.connection)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") {
                        showingSettings = true
                    }
                }
            }
            .refreshable {
                guard !serverAddress.isEmpty else {
                    return
                }
                await store.refresh(from: serverAddress)
            }
            .task(id: PollKey(serverAddress: serverAddress, reconnectSeconds: reconnectSeconds,
                              generation: pollGeneration)) {
                guard !serverAddress.isEmpty else {
                    return
                }
                await store.poll(serverAddress: serverAddress, reconnectSeconds: reconnectSeconds)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    pollGeneration += 1
                }
            }
            .sensoryFeedback(.success, trigger: store.confirmedChanges)
            .confirmationDialog(confirming?.title ?? "",
                                isPresented: Binding(get: { confirming != nil },
                                                     set: { if !$0 { confirming = nil } }),
                                titleVisibility: .visible,
                                presenting: confirming) { request in
                Button(request.action) {
                    perform(request)
                }
                Button("Cancel", role: .cancel) {}
            } message: { request in
                Text(request.message)
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView(serverAddress: $serverAddress, store: store)
            }
            .fullScreenCover(isPresented: Binding(get: { serverAddress.isEmpty }, set: { _ in })) {
                ServerSetupView { address in
                    serverAddress = address
                }
            }
        }
    }

    @ViewBuilder
    private var dashboard: some View {
        TemperatureCard(pool: store.measurement(named: "pool temp"),
                        secondary: ["spa temp", "ambient", "salt"].map(store.measurement(named:)),
                        lastRefresh: store.lastRefresh,
                        isConnected: store.isConnected)

        Group {
            accessNote

            ControlSection(title: EquipmentControl.Group.heating.title) {
                equipmentGrid(.heating)
            }

            ControlSection(title: EquipmentControl.Group.circulation.title) {
                WaterFlowControl(current: store.waterMode,
                                 pending: store.pendingWaterMode,
                                 isLocked: !store.canControl) { mode in
                    confirming = .waterMode(mode)
                }
                equipmentGrid(.circulation)
            }

            ControlSection(title: EquipmentControl.Group.features.title) {
                equipmentGrid(.features)
            }
        }
        .disabled(!store.isConnected)
        .opacity(store.isConnected ? 1 : 0.5)

        PanelControlLink(store: store)

        UpdateFooter(lastChange: store.lastSwitchChange)
    }

    @ViewBuilder
    private var accessNote: some View {
        if store.credentials == nil {
            SignInPrompt(text: "Sign in to change equipment and water flow") {
                showingSettings = true
            }
        } else if !store.canControl {
            Label("View only. Your account can see equipment but not change it.", systemImage: "eye")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func equipmentGrid(_ group: EquipmentControl.Group) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(EquipmentControl.controls(in: group)) { control in
                EquipmentTile(control: control,
                              isOn: store.isOn(control),
                              pending: store.pendingState(control.name),
                              isLocked: !store.canControl) {
                    request(control)
                }
            }
        }
    }

    private func request(_ control: EquipmentControl) {
        if store.credentials == nil {
            showingSettings = true
            return
        }
        guard store.canControl else {
            return
        }
        let turnOn = !store.isOn(control)
        if let confirmation = control.confirmation(turningOn: turnOn) {
            confirming = .control(control, on: turnOn, confirmation)
        } else {
            setControl(control, on: turnOn)
        }
    }

    private func perform(_ request: ChangeRequest) {
        switch request {
        case .control(let control, let on, _):
            setControl(control, on: on)
        case .waterMode(let mode):
            Task { await store.setWaterMode(mode, serverAddress: serverAddress) }
        }
    }

    private func setControl(_ control: EquipmentControl, on: Bool) {
        Task { await store.setControl(control, on: on, serverAddress: serverAddress) }
    }
}

/// A change the user confirms before it's sent.
private enum ChangeRequest {
    case control(EquipmentControl, on: Bool, EquipmentControl.Confirmation)
    case waterMode(WaterMode)

    var title: String {
        switch self {
        case .control(_, _, let confirmation): confirmation.title
        case .waterMode(let mode): "Switch water flow to \(mode.title)?"
        }
    }

    var message: String {
        switch self {
        case .control(_, _, let confirmation): confirmation.message
        case .waterMode(let mode): "\(mode.summary) The valves can take up to a minute to turn."
        }
    }

    var action: String {
        switch self {
        case .control(_, _, let confirmation): confirmation.action
        case .waterMode(let mode): "Switch to \(mode.title)"
        }
    }
}

private extension WaterMode {
    var summary: String {
        switch self {
        case .pool: "Water flows through the pool only."
        case .spa: "Water flows through the spa only."
        case .spillover: "Pool water is pumped through the spa and spills back over into the pool."
        }
    }
}

// MARK: - Temperatures

/// The pool temperature large on the left; spa, air and salt in a column beside it.
private struct TemperatureCard: View {
    let pool: Measurement
    let secondary: [Measurement]
    let lastRefresh: Date?
    let isConnected: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            NavigationLink {
                TemperatureHistoryView(water: .pool)
            } label: {
                hero
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows the temperature history")

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                ForEach(secondary) { measurement in
                    secondaryRow(measurement)
                }
            }
            .frame(maxWidth: 170)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Text(pool.title)
                    .foregroundStyle(Color.accentColor)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                if pool.isDimmed {
                    Label("Pump off", systemImage: "pause.circle.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }
            }
            .font(.subheadline.weight(.semibold))
            Text(pool.value)
                .font(.system(size: 50, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .foregroundStyle(pool.isDimmed ? .secondary : .primary)
            FreshnessLine(lastRefresh: lastRefresh, isConnected: isConnected)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func secondaryRow(_ measurement: Measurement) -> some View {
        switch measurement.name {
        case "spa temp":
            NavigationLink {
                TemperatureHistoryView(water: .spa)
            } label: {
                row(measurement, linked: true)
            }
            .buttonStyle(.plain)
        case "salt":
            NavigationLink {
                SaltHistoryView()
            } label: {
                row(measurement, linked: true)
            }
            .buttonStyle(.plain)
        default:
            row(measurement, linked: false)
        }
    }

    private func row(_ measurement: Measurement, linked: Bool) -> some View {
        HStack(spacing: 4) {
            Text(measurement.title)
                .font(.subheadline.weight(linked ? .medium : .regular))
                .foregroundStyle(linked ? Color.accentColor : Color.secondary)
            if measurement.isDimmed {
                Image(systemName: "pause.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Pump off")
            }
            Spacer(minLength: 6)
            Text(measurement.value)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .foregroundStyle(measurement.isDimmed ? .secondary : .primary)
            if linked {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            } else {
                // keeps the values lined up with the linked rows
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .hidden()
            }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint(linked ? "Shows the history" : "")
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
                    ? "just now"
                    : lastRefresh.formatted(.relative(presentation: .named))
                Text(isConnected ? "Updated \(when)" : "Last reading \(when)")
                    .font(.caption)
                    .foregroundStyle(isConnected ? Color.secondary : Color.orange)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
    }
}

// MARK: - Controls

/// A titled group of controls, with an optional link at the trailing end of the title.
private struct ControlSection<Content: View, Trailing: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.headline)
                Spacer()
                trailing
            }
            .padding(.horizontal, 4)
            VStack(spacing: 8) {
                content
            }
        }
    }
}

extension ControlSection where Trailing == EmptyView {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, content: content, trailing: { EmptyView() })
    }
}

/// Pool, spa or spillover: shows the controller's mode and asks for the one picked.
private struct WaterFlowControl: View {
    let current: WaterMode?
    let pending: WaterMode?
    let isLocked: Bool
    let request: (WaterMode) -> Void

    private var status: String? {
        if let pending {
            return "Switching to \(pending.title)…"
        }
        return current == nil ? "Waiting for the controller" : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundStyle(Color.accentColor)
                Text("Water Flow")
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 6)
                if let status {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                if pending != nil {
                    ProgressView()
                        .controlSize(.small)
                } else if isLocked {
                    Image(systemName: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // no segment is selected until the controller reports a mode, and the highlight
            // moves only when it reaches the one requested
            Picker("Water Flow", selection: Binding(get: { current },
                                                   set: { mode in
                                                       if let mode, mode != current {
                                                           request(mode)
                                                       }
                                                   })) {
                ForEach(WaterMode.allCases) { mode in
                    Text(mode.title).tag(WaterMode?.some(mode))
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(isLocked || pending != nil || current == nil)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityHint("Spillover pumps pool water through the spa so it spills back into the pool.")
    }
}

/// One piece of equipment: filled with its colour while the controller reports it on.
private struct EquipmentTile: View {
    let control: EquipmentControl
    /// The state the controller last reported.
    let isOn: Bool
    /// The state requested and not yet confirmed.
    let pending: Bool?
    /// Shows the state but can't be changed by this account.
    let isLocked: Bool
    let action: () -> Void

    private var stateText: String {
        pending.map(control.pendingText) ?? control.stateText(isOn)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: control.systemImage)
                    .symbolVariant(isOn ? .fill : .none)
                    .font(.title3)
                    .foregroundStyle(isOn ? control.tint : Color.secondary)
                    // icons differ in size; a fixed frame keeps the names lined up
                    .frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 0) {
                    Text(control.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(stateText)
                        .font(.caption.weight(isOn ? .semibold : .regular))
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                Spacer(minLength: 0)
                if pending != nil {
                    ProgressView()
                        .controlSize(.small)
                } else if isLocked {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
            .background(isOn ? control.tint.opacity(0.16) : Color(.secondarySystemGroupedBackground),
                        in: .rect(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(isOn ? control.tint.opacity(0.55) : Color.clear, lineWidth: 1.5)
            }
            .contentShape(.rect)
        }
        .buttonStyle(TileButtonStyle())
        .disabled(pending != nil)
        .animation(.default, value: isOn)
        .sensoryFeedback(.impact(weight: .light), trigger: pending != nil) { _, isPending in isPending }
        .accessibilityLabel(control.title)
        .accessibilityValue(stateText)
        .accessibilityHint(isLocked ? "Locked" : "")
        .accessibilityAddTraits(.isToggle)
    }
}

private struct TileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// The way into the controller's own menus, for everything the app doesn't show itself.
private struct PanelControlLink: View {
    let store: StatusStore

    var body: some View {
        NavigationLink {
            PanelView(store: store)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "dpad.fill")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Color.accentColor, in: .rect(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 0) {
                    Text("Panel Control")
                        .font(.subheadline.weight(.semibold))
                    Text("Every menu and setting on the controller")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Status

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

/// One line: which server can't be reached, with ways to change it or try again.
private struct OfflineBanner: View {
    let host: String
    let reason: String?
    let nextAttempt: Date?
    let isRetrying: Bool
    let retry: () -> Void
    let change: () -> Void

    var body: some View {
        // one line when the whole address fits beside the buttons, otherwise the buttons go
        // underneath, so the address is never cut short
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                message
                Spacer(minLength: 4)
                buttons
            }
            VStack(alignment: .leading, spacing: 10) {
                message
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    buttons
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }

    private var message: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Can’t reach \(host)")
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if isRetrying {
                    Text("Reconnecting…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let nextAttempt, nextAttempt > .now {
                    Text("Retrying in \(Text(timerInterval: Date.now...nextAttempt, countsDown: true))")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(["Can’t reach \(host).", reason, "Retries automatically."].compactMap(\.self).joined(separator: " "))
    }

    @ViewBuilder
    private var buttons: some View {
        Button("Change", action: change)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
        if isRetrying {
            ProgressView()
                .controlSize(.small)
                .frame(minWidth: 52)
        } else {
            Button("Retry", action: retry)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .fixedSize()
        }
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

private struct UpdateFooter: View {
    let lastChange: Date?

    var body: some View {
        if let lastChange {
            Text("Equipment last changed \(lastChange, format: .relative(presentation: .named))")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
        }
    }
}

#Preview {
    StatusView()
}
