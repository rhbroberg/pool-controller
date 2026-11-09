import Foundation

/// The kinds of weather the dashboard shows, as the server sorts its forecast's weather codes.
public nonisolated enum WeatherCondition: String, CaseIterable, Sendable {
    case sunny
    case partlyCloudy = "partly-cloudy"
    case cloudy, fog, rain, snow, storm

    public var title: String {
        switch self {
        case .sunny: String(localized: "Sunny", bundle: .module)
        case .partlyCloudy: String(localized: "Partly Cloudy", bundle: .module)
        case .cloudy: String(localized: "Cloudy", bundle: .module)
        case .fog: String(localized: "Fog", bundle: .module)
        case .rain: String(localized: "Rain", bundle: .module)
        case .snow: String(localized: "Snow", bundle: .module)
        case .storm: String(localized: "Storms", bundle: .module)
        }
    }

    public var symbolName: String {
        switch self {
        case .sunny: "sun.max.fill"
        case .partlyCloudy: "cloud.sun.fill"
        case .cloudy: "cloud.fill"
        case .fog: "cloud.fog.fill"
        case .rain: "cloud.rain.fill"
        case .snow: "cloud.snow.fill"
        case .storm: "cloud.bolt.rain.fill"
        }
    }
}

/// `GET /weather`: today's forecast at the pool's zip code, as the server last fetched it.
public nonisolated struct WeatherReport: Decodable, Sendable, Equatable {
    public struct Place: Decodable, Sendable, Equatable {
        public let zipCode: String
        public let placeName: String
    }

    public struct Day: Decodable, Sendable, Equatable {
        /// YYYY-MM-DD in the server's time zone.
        public let date: String
        /// °F.
        public let high: Double?
        public let low: Double?
        /// The day's highest chance of rain, in percent.
        public let precipitationProbability: Double?
        public let sunrise: Date?
        public let sunset: Date?
        /// The server's name for the condition; one this app doesn't know reads as nil.
        private let condition: String?

        public var weatherCondition: WeatherCondition? {
            condition.flatMap(WeatherCondition.init(rawValue:))
        }
    }

    /// Whether an admin has set a zip code.
    public let configured: Bool
    public let location: Place?
    /// Nil until the server's first fetch for the zip code has finished.
    public let today: Day?
    public let fetchedAt: Date?
    /// The forecast is more than a few hours old.
    public let stale: Bool

    /// What the dashboard shows; nil while there's nothing to show, as before a zip code is set.
    public var summary: DashboardWeather? {
        guard configured, let today else {
            return nil
        }
        let condition = today.weatherCondition
        let rain = today.precipitationProbability.flatMap { $0 >= 30 ? Int($0.rounded()) : nil }
        return DashboardWeather(title: condition?.title ?? String(localized: "Today", bundle: .module),
                                symbolName: condition?.symbolName ?? "cloud.fill",
                                condition: condition,
                                high: Self.degrees(today.high),
                                low: Self.degrees(today.low),
                                place: location?.placeName,
                                rainChance: rain,
                                isStale: stale)
    }

    private static func degrees(_ value: Double?) -> String {
        value.map { "\(Int($0.rounded()))°" } ?? "--°"
    }
}

/// Today's forecast as the dashboard shows it.
public nonisolated struct DashboardWeather: Sendable, Equatable {
    public let title: String
    public let symbolName: String
    public let condition: WeatherCondition?
    public let high: String
    public let low: String
    public let place: String?
    /// The chance of rain in percent, when it's worth mentioning.
    public let rainChance: Int?
    public let isStale: Bool

    public var highLow: String { "\(high) / \(low)" }
}
