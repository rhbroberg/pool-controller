import SwiftUI

struct StatusView: View {
    static let defaultPoolName = "Pool"
    /// Keeps the page readable on iPad and in landscape.
    static let maximumWidth: CGFloat = 640

    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.poolName) private var poolName = StatusView.defaultPoolName
    @AppStorage(SettingsKey.reconnectSeconds) private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingSettings = false
    /// Bumped to restart polling immediately, as from Retry.
    @State private var pollGeneration = 0
    /// A change waiting for the user to confirm it.
    @State private var confirming: ChangeRequest?
    /// The heater or heat pump whose setpoints are open.
    @State private var setpointDevice: HeatingDevice?

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
                        OfflineBanner(host: ServerAddress.display(store.serverAddress),
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
                            .cardBackground()
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
                await store.refresh()
            }
            .task(id: PollKey(serverAddress: store.serverAddress, reconnectSeconds: reconnectSeconds,
                              generation: pollGeneration)) {
                await store.poll(reconnectSeconds: reconnectSeconds)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    pollGeneration += 1
                }
            }
            .sensoryFeedback(.success, trigger: store.confirmedChanges)
            .confirmationDialog(confirming?.title ?? "",
                                isPresented: Binding(isPresent: $confirming),
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
                SettingsView()
            }
            .sheet(item: $setpointDevice) { device in
                SetpointView(device: device)
            }
            .navigationDestination(for: DashboardRoute.self) { route in
                switch route {
                case .temperatureHistory(let water): TemperatureHistoryView(water: water)
                case .saltHistory: SaltHistoryView()
                case .panel: PanelView()
                }
            }
        }
    }

    @ViewBuilder
    private var dashboard: some View {
        TemperatureCard(pool: store.measurement(named: .poolTemperature),
                        secondary: [.spaTemperature, .airTemperature, .salt].map(store.measurement(named:)),
                        lastRefresh: store.lastRefresh,
                        isConnected: store.isConnected)

        Group {
            accessNote

            ControlSection(title: EquipmentControl.Area.heating.title) {
                equipmentGrid(.heating)
            }

            ControlSection(title: EquipmentControl.Area.circulation.title) {
                WaterFlowControl(current: store.waterMode,
                                 pending: store.pendingWaterMode,
                                 isLocked: !store.auth.canControl) { mode in
                    confirming = .waterMode(mode)
                }
                equipmentGrid(.circulation)
            }

            ControlSection(title: EquipmentControl.Area.features.title) {
                equipmentGrid(.features)
            }
        }
        .disabled(!store.isConnected)
        .opacity(store.isConnected ? 1 : 0.5)

        PanelControlLink()

        UpdateFooter(lastChange: store.lastSwitchChange)
    }

    @ViewBuilder
    private var accessNote: some View {
        if store.auth.credentials == nil {
            SignInPrompt(text: "Sign in to change equipment and water flow") {
                showingSettings = true
            }
        } else if !store.auth.canControl {
            Label("View only. Your account can see equipment but not change it.", systemImage: "eye")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func equipmentGrid(_ area: EquipmentControl.Area) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(EquipmentControl.controls(in: area)) { control in
                let device = HeatingDevice(controlName: control.name)
                EquipmentTile(control: control,
                              isOn: store.isOn(control),
                              pending: store.pendingState(control.name),
                              heating: store.heating(for: control),
                              isLocked: !store.auth.canControl,
                              action: { request(control) },
                              showSetpoints: device != nil && store.heating != nil ? { setpointDevice = device } : nil)
            }
        }
    }

    private func request(_ control: EquipmentControl) {
        if store.auth.credentials == nil {
            showingSettings = true
            return
        }
        guard store.auth.canControl else {
            return
        }
        let turnOn = !store.isOn(control)
        if let confirmation = control.confirmation(turningOn: turnOn) {
            confirming = .control(control, on: turnOn, confirmation)
        } else {
            setControl(control, on: turnOn)
        }
    }

    // the store's changes outlive this view's tasks: confirming one keeps polling after the
    // user moves on to another page
    private func perform(_ request: ChangeRequest) {
        switch request {
        case .control(let control, let on, _):
            setControl(control, on: on)
        case .waterMode(let mode):
            Task { await store.setWaterMode(mode) }
        }
    }

    private func setControl(_ control: EquipmentControl, on: Bool) {
        Task { await store.setControl(control, on: on) }
    }
}

/// The pages the dashboard links to.
private enum DashboardRoute: Hashable {
    case temperatureHistory(WaterBody)
    case saltHistory
    case panel
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
    let pool: DashboardReading
    let secondary: [DashboardReading]
    let lastRefresh: Date?
    let isConnected: Bool

    @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 50

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            NavigationLink(value: DashboardRoute.temperatureHistory(.pool)) {
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
        .cardBackground()
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
                .font(.system(size: heroSize, weight: .semibold, design: .rounded))
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
    private func secondaryRow(_ measurement: DashboardReading) -> some View {
        switch measurement.name {
        case .spaTemperature:
            NavigationLink(value: DashboardRoute.temperatureHistory(.spa)) {
                row(measurement, linked: true)
            }
            .buttonStyle(.plain)
        case .salt:
            NavigationLink(value: DashboardRoute.saltHistory) {
                row(measurement, linked: true)
            }
            .buttonStyle(.plain)
        default:
            row(measurement, linked: false)
        }
    }

    private func row(_ measurement: DashboardReading, linked: Bool) -> some View {
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
        .cardBackground(cornerRadius: Card.tileCornerRadius)
        .accessibilityElement(children: .contain)
        .accessibilityHint("Spillover pumps pool water through the spa so it spills back into the pool.")
    }
}

/// One piece of equipment: outlined in its colour while the controller reports it on, and filled
/// while it's running. For the heater and heat pump those differ: on is enabled, running is
/// producing heat, and a thermometer opens their setpoints.
private struct EquipmentTile: View {
    let control: EquipmentControl
    /// The state the controller last reported.
    let isOn: Bool
    /// The state requested and not yet confirmed.
    let pending: Bool?
    /// What the heater or heat pump is doing, for those two.
    let heating: HeatingStatus.Device?
    /// Shows the state but can't be changed by this account.
    let isLocked: Bool
    let action: () -> Void
    /// Opens the setpoints, for the heater and heat pump.
    let showSetpoints: (() -> Void)?

    // icons differ in size; a fixed frame keeps the names lined up
    @ScaledMetric(relativeTo: .title3) private var iconSize: CGFloat = 26
    @ScaledMetric(relativeTo: .subheadline) private var tileHeight: CGFloat = 50
    @ScaledMetric(relativeTo: .caption2) private var setpointSize: CGFloat = 36
    @ScaledMetric(relativeTo: .caption2) private var setpointTapWidth: CGFloat = 44

    private var isRunning: Bool {
        heating.map { isOn && $0.heating } ?? isOn
    }

    private var stateText: String {
        if let pending {
            return control.pendingText(pending)
        }
        guard isOn, let heating else {
            return control.stateText(isOn)
        }
        // with no pump running, no water reaches the heaters
        guard let body = heating.body else {
            return "\(control.stateText(true)) · pump off"
        }
        let water = body.title.lowercased()
        if heating.heating {
            return "Heating \(water)"
        }
        if heating.callingForHeat {
            return "Waiting · \(water)"
        }
        if heating.temperature == nil {
            return "\(control.stateText(true)) · \(water)"
        }
        return "\(body.title) at setpoint"
    }

    /// The setpoint being driven toward, while enabled and water is flowing to the heaters.
    private var targetSetpoint: Int? {
        isOn && pending == nil ? heating?.setpoint : nil
    }

    private var accessibilityState: String {
        var parts = [stateText]
        if let targetSetpoint, let body = heating?.body {
            parts.append("\(body.title.lowercased()) setpoint \(targetSetpoint) degrees")
        }
        if isLocked {
            parts.append("locked")
        }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 10) {
                    Image(systemName: control.systemImage)
                        .symbolVariant(isRunning ? .fill : .none)
                        .font(.title3)
                        .foregroundStyle(isOn ? control.tint.color : Color.secondary)
                        .frame(width: iconSize, height: iconSize)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(control.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Text(stateText)
                            .font(.caption.weight(isOn ? .semibold : .regular))
                            .foregroundStyle(.secondary)
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
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
                .padding(.leading, 10)
                .padding(.trailing, showSetpoints == nil ? 10 : 2)
                .frame(maxWidth: .infinity, minHeight: tileHeight, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(TileButtonStyle())
            .disabled(pending != nil)
            .sensoryFeedback(.impact(weight: .light), trigger: pending != nil) { _, isPending in isPending }
            .accessibilityLabel(control.title)
            .accessibilityValue(accessibilityState)
            .accessibilityAddTraits(.isToggle)

            if let showSetpoints {
                Button(action: showSetpoints) {
                    VStack(spacing: 0) {
                        Image(systemName: "thermometer.medium")
                            .font(targetSetpoint == nil ? .subheadline.weight(.semibold) : .caption2.weight(.semibold))
                        if let targetSetpoint {
                            Text("\(targetSetpoint)°")
                                .font(.caption2.weight(.bold))
                                .monospacedDigit()
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .foregroundStyle(isOn ? control.tint.color : Color.secondary)
                    .frame(width: setpointSize, height: setpointSize)
                    .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 10))
                    .frame(width: setpointTapWidth, height: tileHeight)
                    .contentShape(.rect)
                }
                .buttonStyle(TileButtonStyle())
                .accessibilityLabel("\(control.title) Setpoints")
            }
        }
        .background(isRunning ? control.tint.color.opacity(0.16) : Color(.secondarySystemGroupedBackground),
                    in: .rect(cornerRadius: Card.tileCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: Card.tileCornerRadius)
                .strokeBorder(isOn ? control.tint.color.opacity(0.55) : Color.clear, lineWidth: 1.5)
        }
        .animation(.default, value: isOn)
        .animation(.default, value: isRunning)
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
    @ScaledMetric(relativeTo: .title3) private var iconSize: CGFloat = 36

    var body: some View {
        NavigationLink(value: DashboardRoute.panel) {
            HStack(spacing: 12) {
                Image(systemName: "dpad.fill")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: iconSize, height: iconSize)
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
            .cardBackground(cornerRadius: Card.tileCornerRadius)
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
        .cardBackground()
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

#if DEBUG
#Preview {
    StatusView()
        .environment(StatusStore.preview())
}
#endif
