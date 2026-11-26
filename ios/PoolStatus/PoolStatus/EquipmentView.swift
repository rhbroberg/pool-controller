import PoolStatusCore
import SwiftUI

/// Every switch the app offers, the water flow, and the heaters with their setpoints: what the
/// main page showed before tasks.
struct EquipmentView: View {
    @Environment(StatusStore.self) private var store
    /// A change waiting for the user to confirm it.
    @State private var confirming: ChangeRequest?
    /// The heater or heat pump whose setpoints are open.
    @State private var setpointDevice: HeatingDevice?
    @State private var showingEstimate = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let errorMessage = store.errorMessage, store.isConnected {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .cardBackground()
                }
                if !store.auth.canControl {
                    AccessNote()
                }

                Group {
                    ControlSection(title: EquipmentControl.Area.heating.title) {
                        equipmentGrid(.heating)
                    } trailing: {
                        if let estimate = store.heating?.estimate, estimate.isShown {
                            HeatingEstimateButton(estimate: estimate) {
                                showingEstimate = true
                            }
                        }
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
                        DashboardLink(route: .saltHistory, systemImage: "circle.hexagongrid.fill", title: String(localized: "Salt"),
                                      subtitle: String(localized: "The chlorinator’s salt over time"),
                                      value: store.measurement(named: .salt).value)
                    }
                }
                .disabled(!store.isConnected)
                .opacity(store.isConnected ? 1 : 0.5)

                UpdateFooter(lastChange: store.lastSwitchChange)
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .frame(maxWidth: StatusView.maximumWidth)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Equipment")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.refresh()
        }
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
        .sheet(item: $setpointDevice) { device in
            SetpointView(device: device)
        }
        .sheet(isPresented: $showingEstimate) {
            HeatingEstimateView()
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

/// A change the user confirms before it's sent.
fileprivate enum ChangeRequest {
    case control(EquipmentControl, on: Bool, EquipmentControl.Confirmation)
    case waterMode(WaterMode)

    var title: String {
        switch self {
        case .control(_, _, let confirmation): confirmation.title
        case .waterMode(let mode): String(localized: "Switch water flow to \(mode.title)?")
        }
    }

    var message: String {
        switch self {
        case .control(_, _, let confirmation): confirmation.message
        case .waterMode(let mode): String(localized: "\(mode.summary) The valves can take up to a minute to turn.")
        }
    }

    var action: String {
        switch self {
        case .control(_, _, let confirmation): confirmation.action
        case .waterMode(let mode): String(localized: "Switch to \(mode.title)")
        }
    }
}

fileprivate extension WaterMode {
    var summary: String {
        switch self {
        case .pool: String(localized: "Water flows through the pool only.")
        case .spa: String(localized: "Water flows through the spa only.")
        case .spillover: String(localized: "Pool water is pumped through the spa and spills back over into the pool.")
        }
    }
}

/// Pool, spa or spillover: shows the controller's mode and asks for the one picked.
fileprivate struct WaterFlowControl: View {
    let current: WaterMode?
    let pending: WaterMode?
    let isLocked: Bool
    let request: (WaterMode) -> Void

    private var status: String? {
        if let pending {
            return String(localized: "Switching to \(pending.title)…")
        }
        return current == nil ? String(localized: "Waiting for the controller") : nil
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
fileprivate struct EquipmentTile: View {
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
            return String(localized: "\(control.stateText(true)) · pump off")
        }
        if heating.heating {
            return body == .pool ? String(localized: "Heating pool") : String(localized: "Heating spa")
        }
        if heating.callingForHeat {
            return body == .pool ? String(localized: "Waiting · pool") : String(localized: "Waiting · spa")
        }
        if heating.temperature == nil {
            return "\(control.stateText(true)) · \(body.title.lowercased())"
        }
        return body == .pool ? String(localized: "Pool at setpoint") : String(localized: "Spa at setpoint")
    }

    /// The setpoint being driven toward, while enabled and water is flowing to the heaters.
    private var targetSetpoint: Int? {
        isOn && pending == nil ? heating?.setpoint : nil
    }

    private var accessibilityState: String {
        var parts = [stateText]
        if let targetSetpoint, let body = heating?.body {
            parts.append(body == .pool ? String(localized: "pool setpoint \(targetSetpoint) degrees")
                                       : String(localized: "spa setpoint \(targetSetpoint) degrees"))
        }
        if isLocked {
            parts.append(String(localized: "locked"))
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

fileprivate struct TileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
