import Foundation

/// An accent colour, named here so models don't depend on SwiftUI.
public enum Tint {
    case pink, orange, blue, cyan, yellow, green, mint, teal, indigo
}

/// Equipment the app can switch. Only buttons whose control bits are confirmed by
/// captured presses belong in `all`.
public struct EquipmentControl: Identifiable {
    /// Where a control sits on the main page.
    public enum Area: CaseIterable {
        case heating, circulation, features

        public var title: String {
            switch self {
            case .heating: String(localized: "Heating", bundle: .module)
            case .circulation: String(localized: "Circulation", bundle: .module)
            case .features: String(localized: "Lights & Features", bundle: .module)
            }
        }
    }

    /// How the two states read.
    public enum StateLabels {
        case onOff
        /// A key that switches between named modes rather than on and off.
        case custom(on: String, off: String)
    }

    /// Asked before a change that is easy to make by accident and costly to get wrong.
    public struct Confirmation {
        public let title: String
        public let message: String
        public let action: String
    }

    /// The button name sent to `PUT /devices/{name}/{state}`.
    public let name: ReadingName
    public let systemImage: String
    public let tint: Tint
    public let area: Area
    /// The reading that reports this control's state, when it isn't the status bit of the same name.
    public var stateReading: ReadingName?
    public var labels = StateLabels.onOff
    public var confirmOn: Confirmation?
    public var confirmOff: Confirmation?

    public var id: ReadingName { name }
    public var title: String { name.displayName }
    public var stateName: ReadingName { stateReading ?? name }

    public func stateText(_ on: Bool) -> String {
        switch labels {
        case .onOff: on ? String(localized: "On", bundle: .module) : String(localized: "Off", bundle: .module)
        case .custom(let onText, let offText): on ? onText : offText
        }
    }

    /// Shown while the controller hasn't yet reported the requested state; short enough for a
    /// half-width tile.
    public func pendingText(_ on: Bool) -> String {
        switch labels {
        case .onOff: on ? String(localized: "Turning On…", bundle: .module) : String(localized: "Turning Off…", bundle: .module)
        case .custom: String(localized: "To \(stateText(on))…", bundle: .module, comment: "A mode the controller is switching to")
        }
    }

    public func confirmation(turningOn on: Bool) -> Confirmation? {
        on ? confirmOn : confirmOff
    }

    public static func controls(in area: Area) -> [EquipmentControl] {
        all.filter { $0.area == area }
    }

    public static func control(named name: ReadingName) -> EquipmentControl? {
        all.first { $0.name == name }
    }
}

/// Where the water flows. The controller's spillover key steps through these in order.
public nonisolated enum WaterMode: String, CaseIterable, Identifiable, Sendable {
    case pool, spa, spillover

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .pool: String(localized: "Pool", bundle: .module)
        case .spa: String(localized: "Spa", bundle: .module)
        case .spillover: String(localized: "Spillover", bundle: .module)
        }
    }
}

/// One value on the temperature card.
public struct DashboardReading: Identifiable {
    public let name: ReadingName
    public let title: String
    public let value: String
    /// The pump feeding this sensor is off, so the reading is from when it last ran.
    public let isDimmed: Bool

    public var id: ReadingName { name }
}
