import Foundation

/// How this installation's controller is wired. The controller numbers its auxiliary outputs
/// and valves; the panel's labels say what each one runs here. Everything specific to this
/// pool belongs in this file.
extension ReadingName {
    /// Labelled Spa Filter; it brings valve3 and aux1 with it.
    static let spaFilter = ReadingName("aux14")
    /// Runs the heat pump.
    static let heatPump = ReadingName("valve4")
    static let yardLights = ReadingName("aux3")
    static let blower = ReadingName("aux5")

    /// The name the panel shows.
    var displayName: String {
        switch self {
        case .poolTemperature: String(localized: "Pool")
        case .spaTemperature: String(localized: "Spa")
        case .airTemperature: String(localized: "Air")
        case .filter: String(localized: "Filter")
        case .lights: String(localized: "Lights")
        case .heater: String(localized: "Heater")
        case .superchlorinate: String(localized: "Super Chlorinate")
        case .spaFilter: String(localized: "Spa Filter")
        case .yardLights: String(localized: "Yard Lights")
        case .blower: String(localized: "Blower")
        case .heatPump: String(localized: "Heat Pump")
        default: rawValue.capitalized
        }
    }
}

extension WaterBody {
    /// The pump just upstream of this body's temperature sensor, so the sensor reads the water
    /// only while it runs: the filter for the pool, and the spa filter for the spa, whatever
    /// the water flow mode.
    var pump: ReadingName {
        switch self {
        case .pool: .filter
        case .spa: .spaFilter
        }
    }
}

extension HeatingDevice {
    /// The equipment control that enables it.
    var controlName: ReadingName {
        switch self {
        case .heater1: .heater
        case .heatpump: .heatPump
        }
    }
}

extension EquipmentControl {
    static let all = [
        EquipmentControl(name: .heatPump, systemImage: "heat.waves", tint: .pink, area: .heating),
        // the heater key switches between Manual Off and Auto Control on the panel display
        EquipmentControl(name: .heater, systemImage: "flame", tint: .orange, area: .heating,
                         stateReading: .heaterMode,
                         labels: .custom(on: String(localized: "Auto"), off: String(localized: "Manual Off"))),
        EquipmentControl(name: .filter, systemImage: "fan", tint: .blue, area: .circulation),
        EquipmentControl(name: .spaFilter, systemImage: "bathtub", tint: .cyan, area: .circulation),
        EquipmentControl(name: .lights, systemImage: "lightbulb", tint: .yellow, area: .features),
        EquipmentControl(name: .yardLights, systemImage: "lamp.floor", tint: .green, area: .features),
        EquipmentControl(name: .blower, systemImage: "wind", tint: .mint, area: .features),
        EquipmentControl(name: .superchlorinate, systemImage: "bubbles.and.sparkles", tint: .teal, area: .features,
                         confirmOn: Confirmation(
                            title: String(localized: "Start super chlorinating?"),
                            message: String(localized: "The chlorinator runs at full output until the controller ends the cycle or you turn it off."),
                            action: String(localized: "Super Chlorinate")))
    ]
}
