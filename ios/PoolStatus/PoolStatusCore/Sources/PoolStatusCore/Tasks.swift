import Foundation

/// The everyday jobs offered in place of single switches. Each is on when the switches behind it
/// are, as the server reads them.
public nonisolated enum PoolTask: String, CaseIterable, Identifiable, Sendable {
    /// Spillover water flow with the filter pump running; off stops the filter pump.
    case pool
    /// The spa filter with the heater and heat pump; off stops the spa filter. It can wait to
    /// start until the spa needs the time to be ready by a given time.
    case spaPreheat
    /// A spa preheat with the blower, and the lights after dark; off stops the spa filter,
    /// blower and lights.
    case spaParty

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .pool: String(localized: "Pool", bundle: .module)
        case .spaPreheat: String(localized: "Spa Preheat", bundle: .module)
        case .spaParty: String(localized: "Spa Party", bundle: .module)
        }
    }

    /// What turning it on does, in a few words.
    public var summary: String {
        switch self {
        case .pool: String(localized: "Filter running, water in spillover", bundle: .module)
        case .spaPreheat: String(localized: "Spa filter, heater and heat pump", bundle: .module)
        case .spaParty: String(localized: "Spa preheat with the blower, and lights after dark", bundle: .module)
        }
    }

    public var systemImage: String {
        switch self {
        case .pool: "figure.pool.swim"
        case .spaPreheat: "thermometer.sun"
        case .spaParty: "party.popper"
        }
    }
}

/// `GET /tasks`: whether each task is on, a spa preheat waiting for its time, and whether it's
/// dark at the pool.
public nonisolated struct TaskStatus: Decodable, Sendable, Equatable {
    /// A spa preheat waiting to start so it's ready by `readyAt`.
    public struct ScheduledPreheat: Decodable, Sendable, Equatable {
        public let readyAt: Date
        /// When it will start; the server works it out again every minute.
        public let startAt: Date
        public let leadMinutes: Int
        /// What timed it, as an estimate's basis says: "history", "rule" or "mixed".
        public let leadFrom: String
        public let fromTemperature: Double?
        public let setpoint: Int?
        public let requestedBy: String?

        /// "7:30 PM", or "Sat 7:30 AM" when it isn't today.
        public static func time(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
            var style = Date.FormatStyle(date: .omitted, time: .shortened)
            style.timeZone = calendar.timeZone
            if calendar.isDate(date, inSameDayAs: now) {
                return date.formatted(style)
            }
            var day = Date.FormatStyle().weekday(.abbreviated)
            day.timeZone = calendar.timeZone
            return "\(date.formatted(day)) \(date.formatted(style))"
        }

        /// "Ready by 7:30 PM", for the line under the task.
        public func readyText(now: Date = .now, calendar: Calendar = .current) -> String {
            String(localized: "Ready by \(Self.time(readyAt, now: now, calendar: calendar))", bundle: .module)
        }

        /// "Starts about 6:00 PM", or that it's starting now.
        public func startText(now: Date = .now, calendar: Calendar = .current) -> String {
            startAt <= now
                ? String(localized: "Starting now", bundle: .module)
                : String(localized: "Starts about \(Self.time(startAt, now: now, calendar: calendar))", bundle: .module)
        }
    }

    public let pool: Bool
    public let spaPreheat: Bool
    public let scheduledPreheat: ScheduledPreheat?
    public let spaParty: Bool
    /// Whether it's dark at the pool, so a spa party turns the lights on.
    public let dark: Bool

    public init(pool: Bool, spaPreheat: Bool, scheduledPreheat: ScheduledPreheat?, spaParty: Bool, dark: Bool) {
        self.pool = pool
        self.spaPreheat = spaPreheat
        self.scheduledPreheat = scheduledPreheat
        self.spaParty = spaParty
        self.dark = dark
    }

    public func isOn(_ task: PoolTask) -> Bool {
        switch task {
        case .pool: pool
        case .spaPreheat: spaPreheat
        case .spaParty: spaParty
        }
    }

    private struct Switch: Decodable {
        let on: Bool
    }

    private struct Preheat: Decodable {
        let on: Bool
        let scheduled: ScheduledPreheat?
    }

    private enum CodingKeys: String, CodingKey {
        case pool, spaPreheat, spaParty, dark
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pool = try container.decode(Switch.self, forKey: .pool).on
        let preheat = try container.decode(Preheat.self, forKey: .spaPreheat)
        spaPreheat = preheat.on
        scheduledPreheat = preheat.scheduled
        spaParty = try container.decode(Switch.self, forKey: .spaParty).on
        dark = try container.decodeIfPresent(Bool.self, forKey: .dark) ?? false
    }
}

/// `PUT /tasks/{task}`.
nonisolated struct TaskChange: Encodable, Sendable {
    let on: Bool
    let readyAt: Date?

    private enum CodingKeys: String, CodingKey {
        case on, readyAt
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(on, forKey: .on)
        if let readyAt {
            try container.encode(readyAt.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)), forKey: .readyAt)
        }
    }
}
