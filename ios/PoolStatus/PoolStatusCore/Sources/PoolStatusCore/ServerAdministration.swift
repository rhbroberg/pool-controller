import Foundation

/// `GET /system/settings`: the time zone history days follow, how long raw history is kept and
/// where the pool is, for weather.
public nonisolated struct ServerSettings: Decodable, Sendable, Equatable {
    /// The place the server found for the zip code an admin gave.
    public struct Location: Decodable, Sendable, Equatable {
        public let zipCode: String
        /// The town and state, such as "Orlando, FL".
        public let placeName: String
        public let latitude: Double
        public let longitude: Double
    }

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

        public enum ZipCodeChoice: Sendable, Equatable {
            case code(String)
            /// Stop fetching weather.
            case clear
        }

        public var timeZone: TimeZoneChoice?
        public var rawRetentionDays: Int?
        public var zipCode: ZipCodeChoice?
        public var heatingEstimateDisplay: HeatingEstimate.Display?

        public init(timeZone: TimeZoneChoice? = nil, rawRetentionDays: Int? = nil, zipCode: ZipCodeChoice? = nil,
                    heatingEstimateDisplay: HeatingEstimate.Display? = nil) {
            self.timeZone = timeZone
            self.rawRetentionDays = rawRetentionDays
            self.zipCode = zipCode
            self.heatingEstimateDisplay = heatingEstimateDisplay
        }

        private enum CodingKeys: String, CodingKey {
            case timeZone, rawRetentionDays, zipCode, heatingEstimateDisplay
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
            switch zipCode {
            case .code(let code): try container.encode(code, forKey: .zipCode)
            case .clear: try container.encodeNil(forKey: .zipCode)
            case nil: break
            }
            try container.encodeIfPresent(heatingEstimateDisplay?.rawValue, forKey: .heatingEstimateDisplay)
        }
    }

    /// Five digits, optionally with the ZIP+4 extension.
    public static func isZipCode(_ text: String) -> Bool {
        text.wholeMatch(of: /\d{5}(-\d{4})?/) != nil
    }

    public let timeZone: String
    public let timeZoneSource: TimeZoneSource
    public let detectedTimeZone: String?
    public let rawRetentionDays: Int
    public let minimumRetentionDays: Int
    public let maximumRetentionDays: Int
    /// Nil until an admin gives a zip code, and from a server without weather.
    public let location: Location?
    /// How every app shows when heating will be done; nil from a server too old to estimate.
    public let heatingEstimateDisplay: HeatingEstimate.Display?
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
        case "weather": String(localized: "Weather Forecast", bundle: .module)
        default: name.capitalized
        }
    }

    public var failed: Bool { lastResult == "failed" }
}

/// `POST /system/reprocess`: which stored controller frames to read again.
public nonisolated struct ReprocessRequest: Encodable, Sendable, Equatable {
    public var from: Date
    public var to: Date
    /// The server's event types to rewrite; every kind when empty.
    public var eventTypes: [String]
    /// Count what would change without changing anything.
    public var dryRun: Bool

    public init(from: Date, to: Date, eventTypes: [String] = [], dryRun: Bool = false) {
        self.from = from
        self.to = to
        self.eventTypes = eventTypes
        self.dryRun = dryRun
    }

    private enum CodingKeys: String, CodingKey {
        case from, to, eventTypes, dryRun
    }

    public func encode(to encoder: Encoder) throws {
        let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(iso.format(from), forKey: .from)
        try container.encode(iso.format(to), forKey: .to)
        if !eventTypes.isEmpty {
            try container.encode(eventTypes, forKey: .eventTypes)
        }
        try container.encode(dryRun, forKey: .dryRun)
    }
}

/// `GET /system/reprocess`: a run reading stored frames again, under way or finished.
public nonisolated struct ReprocessRun: Decodable, Sendable, Equatable {
    public enum State: String, Decodable, Sendable {
        /// Waiting for a maintenance job to finish.
        case waiting, running, finished, failed
    }

    /// How many events went from one kind to another, or were removed.
    public struct Transition: Decodable, Sendable, Equatable, Identifiable {
        public let from: String
        /// The new kind, or `removed`.
        public let to: String
        public let count: Int
        public var id: String { "\(from)>\(to)" }
    }

    public let state: State
    public let from: Date
    public let to: Date
    public let eventTypes: [String]
    public let dryRun: Bool
    public let startedAt: Date?
    public let finishedAt: Date?
    /// How far through the range the run has got.
    public let through: Date?
    public let scanned: Int
    /// Events of the chosen kinds read again.
    public let examined: Int
    public let unchanged: Int
    public let updated: Int
    public let removed: Int
    public let unreadable: Int
    public let transitions: [Transition]
    public let error: String?

    public var isActive: Bool { state == .waiting || state == .running }

    /// What the app calls one of the server's event types.
    public static func title(ofType type: String) -> String {
        switch type {
        case "info": String(localized: "Readings", bundle: .module)
        case "status": String(localized: "Equipment", bundle: .module)
        case "control": String(localized: "Panel keys", bundle: .module)
        case "failed": String(localized: "Failed frames", bundle: .module)
        case "unrecognized": String(localized: "Unrecognized frames", bundle: .module)
        case "removed": String(localized: "Removed", bundle: .module)
        default: type
        }
    }
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
