import Foundation

/// An accent colour, named here so models don't depend on SwiftUI.
enum Tint {
    case pink, orange, blue, cyan, yellow, green, mint, teal, indigo
}

/// Equipment the app can switch. Only buttons whose control bits are confirmed by
/// captured presses belong in `all`.
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

    /// How the two states read.
    enum StateLabels {
        case onOff
        /// A key that switches between named modes rather than on and off.
        case custom(on: String, off: String)
    }

    /// Asked before a change that is easy to make by accident and costly to get wrong.
    struct Confirmation {
        let title: String
        let message: String
        let action: String
    }

    /// The button name sent to `PUT /devices/{name}/{state}`.
    let name: ReadingName
    let systemImage: String
    let tint: Tint
    let area: Area
    /// The reading that reports this control's state, when it isn't the status bit of the same name.
    var stateReading: ReadingName?
    var labels = StateLabels.onOff
    var confirmOn: Confirmation?
    var confirmOff: Confirmation?

    var id: ReadingName { name }
    var title: String { name.displayName }
    var stateName: ReadingName { stateReading ?? name }

    func stateText(_ on: Bool) -> String {
        switch labels {
        case .onOff: on ? "On" : "Off"
        case .custom(let onText, let offText): on ? onText : offText
        }
    }

    /// Shown while the controller hasn't yet reported the requested state; short enough for a
    /// half-width tile.
    func pendingText(_ on: Bool) -> String {
        switch labels {
        case .onOff: "Turning \(stateText(on))…"
        case .custom: "To \(stateText(on))…"
        }
    }

    func confirmation(turningOn on: Bool) -> Confirmation? {
        on ? confirmOn : confirmOff
    }

    static func controls(in area: Area) -> [EquipmentControl] {
        all.filter { $0.area == area }
    }

    static func control(named name: ReadingName) -> EquipmentControl? {
        all.first { $0.name == name }
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
    let name: ReadingName
    let title: String
    let value: String
    /// The pump feeding this sensor is off, so the reading is from when it last ran.
    let isDimmed: Bool

    var id: ReadingName { name }
}
