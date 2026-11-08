import Foundation

/// A reading or switch as the server names it, such as `pool temp` or `aux14`. Names the
/// controller reports are open-ended, so this wraps a string rather than enumerating them.
public nonisolated struct ReadingName: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }
}

/// The controller's own names, which are the same at every installation.
nonisolated extension ReadingName {
    public static let poolTemperature = ReadingName("pool temp")
    public static let spaTemperature = ReadingName("spa temp")
    public static let airTemperature = ReadingName("ambient")
    public static let salt = ReadingName("salt")
    public static let checkSystem = ReadingName("check system")

    public static let filter = ReadingName("filter")
    public static let lights = ReadingName("lights")
    public static let heater = ReadingName("heater1")
    /// Whether the heater is in Auto Control rather than Manual Off.
    public static let heaterMode = ReadingName("heater1 mode")
    public static let superchlorinate = ReadingName("superchlorinate")

    /// The water flow switches; spillover is on only with spa, and spa only with pool.
    public static let pool = ReadingName("pool")
    public static let spa = ReadingName("spa")
    public static let spillover = ReadingName("spillover")
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
    public func format(_ value: Double?) -> String {
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
public nonisolated struct StatusReading: Decodable, Identifiable, Hashable, Sendable {
    public enum Category: String, Decodable, Sendable {
        /// A measurement parsed from the controller display, such as a temperature.
        case info
        /// An on/off switch from the controller status frame.
        case status
        /// A category this app doesn't know, which shouldn't stop the rest from decoding.
        case other

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Category(rawValue: raw) ?? .other
        }
    }

    public let name: ReadingName
    public let category: Category
    public let value: Double
    public let timestamp: Date

    public var id: ReadingName { name }

    public var isOn: Bool { value != 0 }

    public var formattedValue: String { name.format(value) }
}
