import Foundation

/// A stretch of history, as the heating model's endpoints give it.
public nonisolated struct HeatingRange: Decodable, Sendable, Equatable {
    public let from: Date
    public let to: Date

    public init(from: Date, to: Date) {
        self.from = from
        self.to = to
    }
}

/// What the server learned about one body of water: how fast the heater and heat pump warm it, how
/// it loses heat to the air, and how the sun helps. Rates are °F per hour.
public nonisolated struct HeatingBodyModel: Decodable, Sendable, Equatable {
    public struct HeatPump: Decodable, Sendable, Equatable {
        /// °F per hour with the air at `referenceAirTemperature`.
        public let base: Double
        /// More (or less) °F per hour for each °F the air is warmer than that.
        public let slope: Double
        public let referenceAirTemperature: Double
        /// The air below which it adds nothing; nil when its output doesn't depend on the air.
        public let minimumAirTemperature: Double?
    }

    /// How many windows of each kind the fit used.
    public struct WindowCounts: Decodable, Sendable, Equatable {
        public let heater: Int
        public let heatpump: Int
        public let both: Int
        public let cooling: Int
        public let total: Int
    }

    /// False when there weren't enough windows to tell; `reason` says what was missing.
    public let available: Bool
    public let reason: String?
    /// Nil when the windows don't tell how fast the heater heats.
    public let heater: Double?
    public let heatPump: HeatPump?
    /// The share of the water's warmth over the air lost each hour.
    public let loss: Double?
    /// What full sun adds.
    public let solar: Double?
    public let windows: WindowCounts?
    public let outliers: Int?
    /// How much of the variation the model explains, 0 to 1.
    public let rSquared: Double?
    /// The typical miss, in °F per hour.
    public let rmse: Double?
    public let airRange: [Double]?
    public let waterRange: [Double]?
    public let notes: [String]?

    /// A rating for the fit, for the details.
    public var quality: String? {
        guard available, let rSquared else {
            return nil
        }
        switch rSquared {
        case 0.7...: return String(localized: "Good fit", bundle: .module)
        case 0.4...: return String(localized: "Fair fit", bundle: .module)
        default: return String(localized: "Loose fit", bundle: .module)
        }
    }
}

/// The model in use, which every estimate comes from.
public nonisolated struct HeatingModel: Decodable, Sendable, Equatable, Identifiable {
    public struct Bodies: Decodable, Sendable, Equatable {
        public let pool: HeatingBodyModel?
        public let spa: HeatingBodyModel?

        public subscript(water: WaterBody) -> HeatingBodyModel? {
            switch water {
            case .pool: pool
            case .spa: spa
            }
        }
    }

    public let id: String
    public let createdAt: Date
    public let createdBy: String?
    /// The history its windows were found in.
    public let range: HeatingRange
    public let timeZone: String?
    public let bodies: Bodies
}

/// `GET /heating/model`.
public nonisolated struct HeatingModelState: Decodable, Sendable, Equatable {
    /// Nil until an admin saves one.
    public let model: HeatingModel?
    /// The range to look for windows in at first: all history before the simulator's.
    public let defaultRange: HeatingRange
}

/// What a window had running.
public nonisolated enum HeatingWindowKind: String, Decodable, Encodable, Sendable, CaseIterable, Identifiable {
    case heater, heatpump, both, cooling

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .heater: String(localized: "Heater", bundle: .module)
        case .heatpump: String(localized: "Heat Pump", bundle: .module)
        case .both: String(localized: "Heater and Heat Pump", bundle: .module)
        case .cooling: String(localized: "Cooling", bundle: .module)
        }
    }

    public var detail: String {
        switch self {
        case .heater: String(localized: "Only the heater was heating.", bundle: .module)
        case .heatpump: String(localized: "Only the heat pump was heating.", bundle: .module)
        case .both: String(localized: "Both were heating.", bundle: .module)
        case .cooling: String(localized: "The pump ran and nothing heated; shows how fast the water loses heat.", bundle: .module)
        }
    }
}

/// `POST /heating/model/scan`: where to look for windows.
public nonisolated struct HeatingScanRequest: Encodable, Sendable, Equatable {
    public var from: Date
    public var to: Date

    public init(from: Date, to: Date) {
        self.from = from
        self.to = to
    }

    private enum CodingKeys: String, CodingKey {
        case from, to
    }

    public func encode(to encoder: Encoder) throws {
        let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(iso.format(from), forKey: .from)
        try container.encode(iso.format(to), forKey: .to)
    }
}

/// `GET /heating/model/scan`: a look through history for windows, under way or finished.
public nonisolated struct HeatingScan: Decodable, Sendable, Equatable {
    public enum State: String, Decodable, Sendable {
        /// Waiting for a maintenance job to finish.
        case waiting, running, finished, failed
    }

    public struct Summary: Decodable, Sendable, Equatable {
        public struct Count: Decodable, Sendable, Equatable {
            public let windows: Int
            public let suitable: Int
            public let hours: Double
        }

        public struct Reason: Decodable, Sendable, Equatable, Identifiable {
            public let reason: String
            public let count: Int
            public var id: String { reason }
        }

        public let windows: Int
        public let suitable: Int
        /// For each body of water (by the server's name), for each kind of window.
        public let bodies: [String: [String: Count]]
        public let reasons: [Reason]

        public func count(_ water: WaterBody, _ kind: HeatingWindowKind) -> Count? {
            bodies[water.rawValue]?[kind.rawValue]
        }
    }

    public let id: String
    public let state: State
    public let from: Date
    public let to: Date
    public let through: Date?
    public let scanned: Int
    /// Stretches with no events from the controller, which say nothing about the water.
    public let gaps: Int
    public let summary: Summary?
    public let error: String?

    public var isActive: Bool { state == .waiting || state == .running }
}

/// One stretch with the same heat sources running, and how the water changed in it.
public nonisolated struct HeatingWindow: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let body: WaterBody
    public let sources: HeatingWindowKind
    public let start: Date
    public let end: Date
    public let hours: Double
    public let startTemperature: Double?
    public let endTemperature: Double?
    public let waterTemperature: Double?
    public let airTemperature: Double?
    /// °F per hour the water changed.
    public let slope: Double?
    public let suitable: Bool
    /// Why it isn't suitable.
    public let reason: String?
}

/// `GET /heating/model/scan/windows`.
public nonisolated struct HeatingWindows: Decodable, Sendable, Equatable {
    public let scanId: String
    public let windows: [HeatingWindow]
}

/// `POST /heating/model/preview`: which windows to fit.
public nonisolated struct HeatingModelRequest: Encodable, Sendable, Equatable {
    public var scanId: String
    public var excludeWindowIds: [String]
    public var includeSources: [HeatingWindowKind]

    public init(scanId: String, excludeWindowIds: [String] = [], includeSources: [HeatingWindowKind] = HeatingWindowKind.allCases) {
        self.scanId = scanId
        self.excludeWindowIds = excludeWindowIds
        self.includeSources = includeSources
    }
}

/// A model calculated from the windows, held by the server until saved.
public nonisolated struct HeatingModelPreview: Decodable, Sendable, Equatable {
    /// What the model says warming would take, for a few air temperatures.
    public struct Sample: Decodable, Sendable, Equatable, Identifiable {
        public let body: WaterBody
        public let sources: HeatingWindowKind
        public let from: Double
        public let to: Double
        public let airTemperature: Double
        public let status: String
        public let minutes: Int?

        public var id: String { "\(body.rawValue):\(sources.rawValue):\(Int(airTemperature))" }
    }

    public let previewId: String
    public let scanId: String
    public let range: HeatingRange
    public let windowsUsed: Int
    public let excludedWindows: Int
    public let bodies: HeatingModel.Bodies
    /// The model in use, to compare with.
    public let current: HeatingModel?
    public let samples: [Sample]

    /// Whether any body of water has enough windows to save.
    public var canSave: Bool {
        bodies.pool?.available == true || bodies.spa?.available == true
    }
}

/// `PUT /heating/model`.
public nonisolated struct HeatingModelSave: Encodable, Sendable, Equatable {
    public let previewId: String
}
