import PoolStatusCore
import SwiftUI

/// Nest-style thermostat for one body of water: current temperature and heater / heat-pump
/// setpoints. By default both devices share one setpoint; they can be unlinked and set apart.
struct ThermostatView: View {
    let water: WaterBody

    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.thermostatLinkedSetpoints) private var linked = true
    @State private var activeDevice: HeatingDevice = .heater1
    @State private var draft: Int?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var saveTask: Task<Void, Never>?

    private var heating: HeatingStatus? { store.heating }
    private var range: ClosedRange<Int> { heating?.range ?? 65...104 }

    private var reading: DashboardReading {
        store.measurement(named: water.temperatureName)
    }

    private var currentDegrees: Int? {
        store.reading(named: water.temperatureName).map { Int($0.value.rounded()) }
    }

    private var displaySetpoint: Int {
        if let draft { return draft }
        if linked {
            return HeatingDevice.allCases.compactMap { heating?.setpoint($0, for: water) }.max() ?? 80
        }
        return heating?.setpoint(activeDevice, for: water) ?? 80
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                dial
                linkToggle
                if !linked {
                    devicePicker
                }
                summary
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
                if let note {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(20)
            .frame(maxWidth: StatusView.maximumWidth)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("\(water.title) Thermostat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: DashboardRoute.temperatureHistory(water)) {
                    Label("History", systemImage: "thermometer.medium")
                }
            }
        }
        .disabled(isSaving)
    }

    private var dial: some View {
        VStack(spacing: 12) {
            ThermostatDial(
                value: displaySetpoint,
                current: currentDegrees,
                range: range,
                waterLabel: reading.isDimmed ? "\(water.title) \(reading.value)" : "Now \(reading.value)",
                enabled: store.auth.canControl && !isSaving
            ) { next in
                apply(next)
            }
            .frame(maxWidth: 320)
            .aspectRatio(1, contentMode: .fit)
            stepControls
        }
        .padding(.vertical, 8)
        .cardBackground()
    }

    private var stepControls: some View {
        HStack(spacing: 0) {
            stepButton(1, systemImage: "chevron.up", label: "Raise the setpoint")
            Divider()
                .frame(height: 28)
            stepButton(-1, systemImage: "chevron.down", label: "Lower the setpoint")
        }
        .background(.fill.tertiary, in: .capsule)
    }

    private func stepButton(_ delta: Int, systemImage: String, label: String) -> some View {
        Button {
            apply(displaySetpoint + delta)
        } label: {
            Image(systemName: systemImage)
                .font(.title2.weight(.semibold))
                .frame(width: 48, height: 40)
        }
        .buttonStyle(.plain)
        .disabled(!store.auth.canControl || isSaving
                  || (delta > 0 && displaySetpoint >= range.upperBound)
                  || (delta < 0 && displaySetpoint <= range.lowerBound))
        .accessibilityLabel(label)
    }

    private var linkToggle: some View {
        Toggle("Keep heater and heat pump together", isOn: $linked)
            .onChange(of: linked) { _, _ in
                draft = nil
            }
            .disabled(!store.auth.canControl)
    }

    private var devicePicker: some View {
        Picker("Heating device", selection: $activeDevice) {
            ForEach(HeatingDevice.allCases) { device in
                Text(device.title).tag(device)
            }
        }
        .pickerStyle(.segmented)
        .onChange(of: activeDevice) { _, _ in
            draft = nil
        }
    }

    private var summary: some View {
        HStack(spacing: 10) {
            ForEach(HeatingDevice.allCases) { device in
                let value = linked
                    ? displaySetpoint
                    : (device == activeDevice ? displaySetpoint : (heating?.setpoint(device, for: water) ?? 80))
                Button {
                    guard !linked else { return }
                    activeDevice = device
                    draft = nil
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(value)°F")
                            .font(.title2.weight(.semibold))
                            .monospacedDigit()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
                    .overlay {
                        if !linked && device == activeDevice {
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(Color.orange, lineWidth: 2)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(linked)
            }
        }
    }

    private var note: String? {
        var parts: [String] = []
        if heating?.setpointsReachController == false {
            parts.append(String(localized: "The server keeps these setpoints itself for now; they aren’t sent to the controller yet."))
        }
        if !store.auth.canControl {
            parts.append(String(localized: "Your account can see the setpoint but not change it."))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private func apply(_ degrees: Int) {
        guard store.auth.canControl else { return }
        draft = min(max(degrees, range.lowerBound), range.upperBound)
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await commit()
        }
    }

    private func commit() async {
        guard let degrees = draft, store.auth.canControl, !isSaving else { return }
        let targets = linked ? HeatingDevice.allCases : [activeDevice]
        let pending = targets.filter { heating?.setpoint($0, for: water) != degrees }
        guard !pending.isEmpty else {
            draft = nil
            return
        }
        isSaving = true
        errorMessage = nil
        do {
            for device in pending {
                try await store.setSetpoints([water: degrees], device: device)
            }
            draft = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        isSaving = false
    }
}

/// Circular setpoint dial: drag or tap along the arc; the large center value is the setpoint.
private struct ThermostatDial: View {
    let value: Int
    let current: Int?
    let range: ClosedRange<Int>
    let waterLabel: String
    let enabled: Bool
    let onChange: (Int) -> Void

    private let start = Angle.degrees(135)
    private let sweep = Angle.degrees(270)

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let center = CGPoint(x: size / 2, y: size / 2)
            let radius = size * 0.39
            ZStack {
                DialTrack(start: start, sweep: sweep)
                    .stroke(Color(.tertiarySystemFill), style: StrokeStyle(lineWidth: size * 0.065, lineCap: .round))
                DialTrack(start: start, sweep: Angle.degrees(sweep.degrees * progress(for: value)))
                    .stroke(Color.orange, style: StrokeStyle(lineWidth: size * 0.065, lineCap: .round))
                if let current {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 10, height: 10)
                        .position(point(progress: progress(for: current), center: center, radius: radius))
                }
                Circle()
                    .fill(Color(.secondarySystemGroupedBackground))
                    .stroke(Color.orange, lineWidth: 4)
                    .frame(width: size * 0.1, height: size * 0.1)
                    .position(point(progress: progress(for: value), center: center, radius: radius))
                    .shadow(color: .black.opacity(0.15), radius: 2, y: 1)
                VStack(spacing: 4) {
                    Text("\(value)°")
                        .font(.system(size: size * 0.2, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text("Set to")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(waterLabel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            .frame(width: size, height: size)
            .contentShape(.circle)
            .gesture(enabled ? drag(center: center) : nil)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Setpoint")
            .accessibilityValue("\(value) degrees")
            .accessibilityAdjustableAction { direction in
                guard enabled else { return }
                switch direction {
                case .increment: onChange(min(value + 1, range.upperBound))
                case .decrement: onChange(max(value - 1, range.lowerBound))
                @unknown default: break
                }
            }
        }
    }

    private func progress(for degrees: Int) -> Double {
        let span = Double(range.upperBound - range.lowerBound)
        guard span > 0 else { return 0 }
        return min(max(Double(degrees - range.lowerBound) / span, 0), 1)
    }

    private func point(progress: Double, center: CGPoint, radius: CGFloat) -> CGPoint {
        let angle = start.radians + sweep.radians * progress
        return CGPoint(x: center.x + radius * Foundation.cos(angle),
                       y: center.y + radius * Foundation.sin(angle))
    }

    private func drag(center: CGPoint) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { gesture in
                let dx = gesture.location.x - center.x
                let dy = gesture.location.y - center.y
                var delta = atan2(dy, dx) - start.radians
                while delta < 0 { delta += 2 * .pi }
                while delta > 2 * .pi { delta -= 2 * .pi }
                let t = min(max(delta / sweep.radians, 0), 1)
                let degrees = Int((Double(range.lowerBound) + t * Double(range.upperBound - range.lowerBound)).rounded())
                onChange(degrees)
            }
    }
}

private struct DialTrack: Shape {
    var start: Angle
    var sweep: Angle

    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height) * 0.39
        var path = Path()
        path.addArc(center: CGPoint(x: rect.midX, y: rect.midY),
                    radius: radius,
                    startAngle: start,
                    endAngle: Angle(radians: start.radians + sweep.radians),
                    clockwise: false)
        return path
    }
}
