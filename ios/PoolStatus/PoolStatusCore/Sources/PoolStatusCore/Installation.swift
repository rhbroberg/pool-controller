import Foundation

/// How this installation's controller is wired. The controller numbers its auxiliary outputs
/// and valves; the panel's labels say what each one runs here. Everything specific to this
/// pool belongs in this file.
nonisolated extension ReadingName {
    /// Labelled Spa Filter; it brings valve3 and aux1 with it.
    public static let spaFilter = ReadingName("aux14")
    /// Runs the heat pump.
    public static let heatPump = ReadingName("valve4")
    public static let yardLights = ReadingName("aux3")
    public static let blower = ReadingName("aux5")

    /// The name the panel shows.
    public var displayName: String {
        switch self {
        case .poolTemperature: String(localized: "Pool", bundle: .module)
        case .spaTemperature: String(localized: "Spa", bundle: .module)
        case .airTemperature: String(localized: "Air", bundle: .module)
        case .filter: String(localized: "Filter", bundle: .module)
        case .lights: String(localized: "Lights", bundle: .module)
        case .heater: String(localized: "Heater", bundle: .module)
        case .superchlorinate: String(localized: "Super Chlorinate", bundle: .module)
        case .spaFilter: String(localized: "Spa Filter", bundle: .module)
        case .yardLights: String(localized: "Yard Lights", bundle: .module)
        case .blower: String(localized: "Blower", bundle: .module)
        case .heatPump: String(localized: "Heat Pump", bundle: .module)
        default: rawValue.capitalized
        }
    }
}

nonisolated extension WaterBody {
    /// The pump just upstream of this body's temperature sensor, so the sensor reads the water
    /// only while it runs: the filter for the pool, and the spa filter for the spa, whatever
    /// the water flow mode.
    public var pump: ReadingName {
        switch self {
        case .pool: .filter
        case .spa: .spaFilter
        }
    }
}

nonisolated extension HeatingDevice {
    /// The equipment control that enables it.
    public var controlName: ReadingName {
        switch self {
        case .heater1: .heater
        case .heatpump: .heatPump
        }
    }
}

extension EquipmentControl {
    public static let all = [
        EquipmentControl(name: .heatPump, systemImage: "heat.waves", tint: .pink, area: .heating),
        // the heater key switches between Manual Off and Auto Control on the panel display
        EquipmentControl(name: .heater, systemImage: "flame", tint: .orange, area: .heating,
                         stateReading: .heaterMode,
                         labels: .custom(on: String(localized: "Auto", bundle: .module), off: String(localized: "Manual Off", bundle: .module))),
        EquipmentControl(name: .filter, systemImage: "fan", tint: .blue, area: .circulation),
        EquipmentControl(name: .spaFilter, systemImage: "bathtub", tint: .cyan, area: .circulation),
        EquipmentControl(name: .lights, systemImage: "lightbulb", tint: .yellow, area: .features),
        EquipmentControl(name: .yardLights, systemImage: "lamp.floor", tint: .green, area: .features),
        EquipmentControl(name: .blower, systemImage: "wind", tint: .mint, area: .features),
        EquipmentControl(name: .superchlorinate, systemImage: "bubbles.and.sparkles", tint: .teal, area: .features,
                         confirmOn: Confirmation(
                            title: String(localized: "Start super chlorinating?", bundle: .module),
                            message: String(localized: "The chlorinator runs at full output until the controller ends the cycle or you turn it off.", bundle: .module),
                            action: String(localized: "Super Chlorinate", bundle: .module)))
    ]

    /// The few controls the watch offers: everyday switches that are safe to flip from the
    /// wrist, so nothing that asks for confirmation.
    public static var watch: [EquipmentControl] {
        [.filter, .spaFilter, .blower, .heatPump, .heater, .lights, .yardLights].compactMap { control(named: $0) }
    }
}
