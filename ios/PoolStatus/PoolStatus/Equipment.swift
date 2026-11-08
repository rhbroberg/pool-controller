import Foundation

/// An accent colour, named here so models don't depend on SwiftUI.
enum Tint {
    case pink, orange, blue, cyan, yellow, green, mint, teal, indigo
}

/// Equipment the app can switch. Only buttons whose control bits are confirmed by
/// captured presses belong here.
struct EquipmentControl: Identifiable {
    /// Where a control sits on the main page.
    enum Area: CaseIterable {
        case heating, circulation, features

        var title: String {
            switch self {
            case .heating: "Heating"
            case .circulation: "Circulation"
            case .features: "Lights & Features"
            }
        }
    }

    /// Asked before a change that is easy to make by accident and costly to get wrong.
    struct Confirmation {
        let title: String
        let message: String
        let action: String
    }

    /// The button name sent to `PUT /devices/{name}/{state}`.
    let name: String
    let systemImage: String
    let tint: Tint
    let area: Area
    /// The reading that reports this control's state, when it isn't the status bit of the same name.
    var stateReading: String?
    var onText = "On"
    var offText = "Off"
    var confirmOn: Confirmation?
    var confirmOff: Confirmation?

    var id: String { name }
    var title: String { StatusReading.displayName(for: name) }
    var stateName: String { stateReading ?? name }

    func stateText(_ on: Bool) -> String {
        on ? onText : offText
    }

    /// Shown while the controller hasn't yet reported the requested state; short enough for a
    /// half-width tile.
    func pendingText(_ on: Bool) -> String {
        onText == "On" ? "Turning \(stateText(on))…" : "To \(stateText(on))…"
    }

    func confirmation(turningOn on: Bool) -> Confirmation? {
        on ? confirmOn : confirmOff
    }

    static let all = [
        // valve4 runs the heat pump at this installation
        EquipmentControl(name: "valve4", systemImage: "heat.waves", tint: .pink, area: .heating),
        // the heater key switches between Manual Off and Auto Control on the panel display
        EquipmentControl(name: "heater1", systemImage: "flame", tint: .orange, area: .heating,
                         stateReading: "heater1 mode", onText: "Auto", offText: "Manual Off"),
        EquipmentControl(name: "filter", systemImage: "fan", tint: .blue, area: .circulation),
        // aux14 is labelled Spa Filter on this panel; it brings valve3 and aux1 with it
        EquipmentControl(name: "aux14", systemImage: "bathtub", tint: .cyan, area: .circulation),
        EquipmentControl(name: "lights", systemImage: "lightbulb", tint: .yellow, area: .features),
        // aux3 and aux5 are labelled Yard Lights and Blower on this panel
        EquipmentControl(name: "aux3", systemImage: "lamp.floor", tint: .green, area: .features),
        EquipmentControl(name: "aux5", systemImage: "wind", tint: .mint, area: .features),
        EquipmentControl(name: "superchlorinate", systemImage: "bubbles.and.sparkles", tint: .teal, area: .features,
                         confirmOn: Confirmation(
                            title: "Start super chlorinating?",
                            message: "The chlorinator runs at full output until the controller ends the cycle or you turn it off.",
                            action: "Super Chlorinate"))
    ]

    static func controls(in area: Area) -> [EquipmentControl] {
        all.filter { $0.area == area }
    }
}

/// Where the water flows. The controller's spillover key steps through these in order.
enum WaterMode: String, CaseIterable, Identifiable {
    case pool, spa, spillover

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

/// One value on the temperature card.
struct DashboardReading: Identifiable {
    let name: String
    let title: String
    let value: String
    /// The pump feeding this sensor is off, so the reading is from when it last ran.
    let isDimmed: Bool

    var id: String { name }
}
