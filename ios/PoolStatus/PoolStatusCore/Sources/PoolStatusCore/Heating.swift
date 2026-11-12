import Foundation

/// The pool and the spa.
public nonisolated enum WaterBody: String, CaseIterable, Identifiable, Codable, Sendable {
    case pool, spa

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .pool: String(localized: "Pool", bundle: .module)
        case .spa: String(localized: "Spa", bundle: .module)
        }
    }

    public var temperatureName: ReadingName {
        switch self {
        case .pool: .poolTemperature
        case .spa: .spaTemperature
        }
    }
}

/// The heater and heat pump. They're in series, so both heat whichever body the water flows to,
/// each toward its own setpoint for that body.
public nonisolated enum HeatingDevice: String, CaseIterable, Identifiable, Sendable {
    case heater1, heatpump

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .heater1: String(localized: "Heater", bundle: .module)
        case .heatpump: String(localized: "Heat Pump", bundle: .module)
        }
    }

    public init?(controlName: ReadingName) {
        guard let device = Self.allCases.first(where: { $0.controlName == controlName }) else {
            return nil
        }
        self = device
    }
}

/// How long until the water reaches its setpoint, from `GET /heating` while the pump runs and a
/// heat source is calling for heat; learned from history, as `HeatingModel` says.
public nonisolated struct HeatingEstimate: Decodable, Sendable, Equatable {
    public enum Status: String, Decodable, Sendable {
        /// `minutes` and `readyAt` say when.
        case ready
        /// The air is too cold for the sources to reach the setpoint; `reachesAtMost` is as far as they go.
        case unreachable
        /// From an older server: the pump has only just started, and it says nothing more until
        /// the water settles. Newer servers estimate anyway and set `isSettling`.
        case settling
        /// No model has been saved for this body of water.
        case noModel
        /// The water or air temperature isn't known.
        case noReading
        /// The model has nothing for a source that is on.
        case insufficientData
    }

    /// How the server is set to have every app show it.
    public enum Display: String, Decodable, Sendable, CaseIterable, Identifiable {
        /// The time left, such as "1 h 20 min".
        case remaining
        /// The time of day, such as "3:45 PM".
        case readyAt

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .remaining: String(localized: "Time Remaining", bundle: .module)
            case .readyAt: String(localized: "Time Ready", bundle: .module)
            }
        }
    }

    /// The water's change now, in °F per hour, and what makes it up.
    public struct Rate: Decodable, Sendable, Equatable {
        public let net: Double
        /// Nil when the model doesn't know how fast the heater heats.
        public let heater: Double?
        public let heatPump: Double?
        public let solar: Double
        /// Negative: what's lost to the air.
        public let loss: Double
    }

    /// The model it was worked out from.
    public struct Model: Decodable, Sendable, Equatable {
        public let calculatedAt: Date
        public let windows: Int
        public let rSquared: Double?
        public let rmse: Double?
        public let airRange: [Double]?
        public let notes: [String]
    }

    public let status: Status
    public let body: WaterBody
    public let temperature: Double?
    /// The highest setpoint among the sources calling for heat.
    public let setpoint: Int
    public let airTemperature: Double?
    public let minutes: Int?
    public let readyAt: Date?
    public let reachesAtMost: Double?
    /// Nil from an older server, which says `.settling` instead.
    private let settling: Bool?
    /// The server's names of the sources calling for heat.
    public let sources: [String]
    public let rate: Rate?
    public let model: Model?
    public let display: Display
    /// The zone `readyAt` is shown in.
    public let timeZone: String

    /// The pump has only just started, so the water sensor may still show the water that sat in
    /// the pipes and the estimate may change once it settles.
    public var isSettling: Bool { status == .settling || settling == true }

    /// Whether the dashboard has something to say; the other statuses are explained in the details.
    public var isShown: Bool {
        switch status {
        case .ready, .unreachable, .settling: true
        case .noModel, .noReading, .insufficientData: false
        }
    }

    /// "1 h 20 min", for a count of minutes.
    public static func duration(minutes: Int) -> String {
        if minutes < 1 {
            return String(localized: "under a minute", bundle: .module)
        }
        let days = minutes / (24 * 60)
        let hours = (minutes % (24 * 60)) / 60
        let rest = minutes % 60
        if days > 0 {
            return String(localized: "\(days) d \(hours) h", bundle: .module)
        }
        if hours > 0 {
            return rest == 0 ? String(localized: "\(hours) h", bundle: .module) : String(localized: "\(hours) h \(rest) min", bundle: .module)
        }
        return String(localized: "\(rest) min", bundle: .module)
    }

    /// The time of day it will be ready in the server's time zone, with the day when it isn't today.
    public func readyText(now: Date = .now) -> String? {
        guard let readyAt else {
            return nil
        }
        let zone = TimeZone(identifier: timeZone) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let time = readyAt.formatted(Date.FormatStyle(timeZone: zone).hour().minute())
        if calendar.isDate(readyAt, inSameDayAs: now) {
            return time
        }
        let day = readyAt.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated))
        return "\(day) \(time)"
    }

    /// The line for the dashboard, in the style the server is set to, or nil when there's nothing to say.
    public func summary(now: Date = .now) -> String? {
        let water = body.title
        switch status {
        case .ready:
            guard let minutes else {
                return nil
            }
            switch (display, isSettling) {
            case (.remaining, false):
                return String(localized: "\(water) ready in \(Self.duration(minutes: minutes))", bundle: .module)
            case (.remaining, true):
                return String(localized: "\(water) ready in about \(Self.duration(minutes: minutes)), settling…", bundle: .module)
            case (.readyAt, false):
                return readyText(now: now).map { String(localized: "\(water) ready about \($0)", bundle: .module) }
            case (.readyAt, true):
                return readyText(now: now).map { String(localized: "\(water) ready about \($0), settling…", bundle: .module) }
            }
        case .unreachable:
            return isSettling
                ? String(localized: "\(water) may not reach \(setpoint)°, settling…", bundle: .module)
                : String(localized: "\(water) won’t reach \(setpoint)° in this weather", bundle: .module)
        case .settling:
            return String(localized: "\(water): estimating…", bundle: .module)
        case .noModel, .noReading, .insufficientData:
            return nil
        }
    }

    /// How the time was worked out, or why there's none, for the details.
    public var explanation: String {
        guard isSettling, status != .settling else {
            return reason
        }
        let settlingNote = String(localized: "The pump has just started, so the water sensor may still show the water that sat in the pipes; this may change once it settles.", bundle: .module)
        return "\(reason) \(settlingNote)"
    }

    private var reason: String {
        switch status {
        case .ready:
            String(localized: "Worked out from how this \(body.title.lowercased()) has warmed in the past.", bundle: .module)
        case .unreachable:
            if let reachesAtMost {
                String(localized: "With the air at this temperature the heat sources can only bring the water to about \(Int(reachesAtMost.rounded()))°.", bundle: .module)
            } else {
                String(localized: "The heat sources can’t bring the water to the setpoint in this weather.", bundle: .module)
            }
        case .settling:
            String(localized: "The pump has just started, and the water sensor still shows the water that sat in the pipes. An estimate follows within 15 minutes.", bundle: .module)
        case .noModel:
            String(localized: "The server hasn’t learned how this body of water warms yet. An admin can do that in Server Maintenance › Heating Estimates.", bundle: .module)
        case .noReading:
            String(localized: "The water or air temperature isn’t known yet.", bundle: .module)
        case .insufficientData:
            String(localized: "History doesn’t show how fast the heat source that is on warms this water.", bundle: .module)
        }
    }
}

/// `GET /heating`: every setpoint, and what each heating device is doing with them.
public nonisolated struct HeatingStatus: Decodable, Sendable, Equatable {
    public struct Device: Decodable, Sendable, Equatable {
        /// Switched on (the heater in Auto); nil until the controller reports it.
        public let enabled: Bool?
        /// Producing heat. An enabled device stops once its water reaches the setpoint and
        /// starts again when the water cools below it.
        public let heating: Bool
        public let callingForHeat: Bool
        /// The body it's driving toward; nil while no pump runs, since no water reaches it.
        public let body: WaterBody?
        public let setpoint: Int?
        public let temperature: Double?
    }

    public let target: WaterBody?
    public let minimum: Int
    public let maximum: Int
    /// False while the server keeps the setpoints itself instead of the controller's.
    public let setpointsReachController: Bool
    /// Keyed by the server's body and device names; read through `setpoint(_:for:)`.
    private let setpoints: [String: [String: Int]]
    private let devices: [String: Device]
    /// How long until the water is warm, while a heat source is calling for heat; nil otherwise,
    /// and from a server too old to estimate.
    public let estimate: HeatingEstimate?

    private enum CodingKeys: String, CodingKey {
        case target, minimum, maximum, setpointsReachController, setpoints, devices, estimate
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        target = try container.decodeIfPresent(WaterBody.self, forKey: .target)
        minimum = try container.decode(Int.self, forKey: .minimum)
        maximum = try container.decode(Int.self, forKey: .maximum)
        setpointsReachController = try container.decode(Bool.self, forKey: .setpointsReachController)
        setpoints = try container.decode([String: [String: Int]].self, forKey: .setpoints)
        devices = try container.decode([String: Device].self, forKey: .devices)
        // an estimate this app can't read must not hide the setpoints
        estimate = (try? container.decodeIfPresent(HeatingEstimate.self, forKey: .estimate)) ?? nil
    }

    public var range: ClosedRange<Int> { minimum...maximum }

    public func setpoint(_ device: HeatingDevice, for body: WaterBody) -> Int? {
        setpoints[body.rawValue]?[device.rawValue]
    }

    public func device(_ device: HeatingDevice) -> Device? {
        devices[device.rawValue]
    }

    /// The water temperature the heating devices see for `body`, while water flows to it.
    public func temperature(of body: WaterBody) -> Double? {
        HeatingDevice.allCases.lazy.compactMap { self.device($0) }.first { $0.body == body && $0.temperature != nil }?.temperature
    }
}
