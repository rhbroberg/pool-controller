import Foundation

/// A reading or switch as the server names it, such as `pool temp` or `aux14`. Names the
/// controller reports are open-ended, so this wraps a string rather than enumerating them.
nonisolated struct ReadingName: RawRepresentable, Hashable, Codable, Sendable {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    init(_ rawValue: String) {
        self.rawValue = rawValue
    }
}

/// The controller's own names, which are the same at every installation.
nonisolated extension ReadingName {
    static let poolTemperature = ReadingName("pool temp")
    static let spaTemperature = ReadingName("spa temp")
    static let airTemperature = ReadingName("ambient")
    static let salt = ReadingName("salt")
    static let checkSystem = ReadingName("check system")

    static let filter = ReadingName("filter")
    static let lights = ReadingName("lights")
    static let heater = ReadingName("heater1")
    /// Whether the heater is in Auto Control rather than Manual Off.
    static let heaterMode = ReadingName("heater1 mode")
    static let superchlorinate = ReadingName("superchlorinate")

    /// The water flow switches; spillover is on only with spa, and spa only with pool.
    static let pool = ReadingName("pool")
    static let spa = ReadingName("spa")
    static let spillover = ReadingName("spillover")
}

nonisolated extension ReadingName {
    private enum Unit {
        case fahrenheit, partsPerMillion, none
    }

    private var unit: Unit {
        switch self {
        case .poolTemperature, .spaTemperature, .airTemperature: .fahrenheit
        case .salt: .partsPerMillion
        default: .none
        }
    }

    /// The value with its unit, or a placeholder with the unit while there is no value yet.
    func format(_ value: Double?) -> String {
        switch unit {
        case .fahrenheit:
            guard let value else {
                return "--°F"
            }
            // the controller reports Fahrenheit and takes setpoints in it, so it isn't converted
            return Measurement(value: value, unit: UnitTemperature.fahrenheit)
                .formatted(.measurement(width: .abbreviated, usage: .asProvided,
                                        numberFormatStyle: .number.precision(.fractionLength(0))))
        case .partsPerMillion:
            guard let value else {
                return "-- ppm"
            }
            return "\(value.formatted(.number.precision(.fractionLength(0)).grouping(.never))) ppm"
        case .none:
            return value?.formatted() ?? "--"
        }
    }
}

/// One entry from `GET /status`: the newest recorded value of a reading.
nonisolated struct StatusReading: Decodable, Identifiable, Hashable, Sendable {
    enum Category: String, Decodable {
        /// A measurement parsed from the controller display, such as a temperature.
        case info
        /// An on/off switch from the controller status frame.
        case status
        /// A category this app doesn't know, which shouldn't stop the rest from decoding.
        case other

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Category(rawValue: raw) ?? .other
        }
    }

    let name: ReadingName
    let category: Category
    let value: Double
    let timestamp: Date

    var id: ReadingName { name }

    var isOn: Bool { value != 0 }

    var formattedValue: String { name.format(value) }
}
