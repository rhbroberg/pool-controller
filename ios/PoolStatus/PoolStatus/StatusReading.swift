import Foundation

/// One entry from `GET /status`: the newest recorded value of a reading.
struct StatusReading: Decodable, Identifiable, Hashable {
    enum Category: String, Decodable {
        /// A measurement parsed from the controller display, such as a temperature.
        case info
        /// An on/off switch from the controller status frame.
        case status
    }

    let name: String
    let category: Category
    let value: Double
    let timestamp: Date

    var id: String { name }

    var isOn: Bool { value != 0 }

    var displayName: String { Self.displayName(for: name) }

    var formattedValue: String {
        switch name {
        case "pool temp", "spa temp", "ambient": "\(Int(value))°F"
        case "salt": "\(Int(value)) ppm"
        default: value.formatted()
        }
    }

    static func displayName(for name: String) -> String {
        switch name {
        case "pool temp": "Pool"
        case "spa temp": "Spa"
        case "ambient": "Air"
        case "heater1": "Heater"
        case "superchlorinate": "Super Chlorinate"
        case "aux14": "Spa Filter"
        case "aux3": "Yard Lights"
        case "aux5": "Blower"
        case "valve4": "Heat Pump"
        default: name.capitalized
        }
    }
}
