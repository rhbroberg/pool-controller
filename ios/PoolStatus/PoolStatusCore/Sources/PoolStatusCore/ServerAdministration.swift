import Foundation

/// `GET /system/settings`: the time zone history days follow and how long raw history is kept.
public nonisolated struct ServerSettings: Decodable, Sendable, Equatable {
    public enum TimeZoneSource: String, Decodable, Sendable {
        /// Set by an admin.
        case configured
        /// Found on the server's host.
        case system
        /// UTC, since neither was available.
        case `default`
    }

    /// What to change; anything left nil stays as it is.
    public struct Changes: Encodable, Sendable {
        public enum TimeZoneChoice: Sendable, Equatable {
            case named(String)
            /// Follow the host's time zone again.
            case host
        }

        public var timeZone: TimeZoneChoice?
        public var rawRetentionDays: Int?

        public init(timeZone: TimeZoneChoice? = nil, rawRetentionDays: Int? = nil) {
            self.timeZone = timeZone
            self.rawRetentionDays = rawRetentionDays
        }

        private enum CodingKeys: String, CodingKey {
            case timeZone, rawRetentionDays
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch timeZone {
            case .named(let name): try container.encode(name, forKey: .timeZone)
            // the server takes null as "the host's zone"
            case .host: try container.encodeNil(forKey: .timeZone)
            case nil: break
            }
            try container.encodeIfPresent(rawRetentionDays, forKey: .rawRetentionDays)
        }
    }

    public let timeZone: String
    public let timeZoneSource: TimeZoneSource
    public let detectedTimeZone: String?
    public let rawRetentionDays: Int
    public let minimumRetentionDays: Int
    public let maximumRetentionDays: Int
}

/// `GET /system/jobs`: one of the server's maintenance jobs and how its last run went.
public nonisolated struct MaintenanceJob: Decodable, Sendable, Identifiable, Equatable {
    public let name: String
    public let description: String
    public let intervalSeconds: Int
    /// False when the server only runs it when asked.
    public let scheduled: Bool
    public let running: Bool
    public let nextRunAt: Date?
    public let lastStartedAt: Date?
    public let lastFinishedAt: Date?
    public let lastDurationMs: Int?
    public let lastResult: String?
    public let lastError: String?
    public let lastSummary: String?
    public let runs: Int
    /// Only after a run: the job has more to do, as while catching up, and runs again shortly.
    public let more: Bool?

    public var id: String { name }

    public var title: String {
        switch name {
        case "rollups": String(localized: "History Summaries", bundle: .module)
        case "retention": String(localized: "Old History Cleanup", bundle: .module)
        default: name.capitalized
        }
    }

    public var failed: Bool { lastResult == "failed" }
}

/// `GET /history/availability`: the days with water temperature or salt readings.
public nonisolated struct HistoryAvailability: Decodable, Sendable {
    public struct Day: Decodable, Sendable {
        /// YYYY-MM-DD in the server's time zone.
        public let date: String
        public let readings: Int
    }

    public let timeZone: String
    /// The first day with readings, YYYY-MM-DD.
    public let earliest: String?
    public let days: [Day]
}

nonisolated extension ReadingName {
    /// 1 while `source` (the heater or heat pump) was warming `water`; the server works it out
    /// from the circulation switches.
    public static func heating(_ water: WaterBody, by source: ReadingName) -> ReadingName {
        ReadingName("heating:\(water.rawValue):\(source.rawValue)")
    }
}
