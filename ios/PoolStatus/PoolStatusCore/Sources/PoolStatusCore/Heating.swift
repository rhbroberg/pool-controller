import Foundation

/// The pool and the spa.
public nonisolated enum WaterBody: String, CaseIterable, Identifiable, Decodable, Sendable {
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

/// `GET /heating`: every setpoint, and what each heating device is doing with them.
public nonisolated struct HeatingStatus: Decodable, Sendable {
    public struct Device: Decodable, Sendable {
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

    public var range: ClosedRange<Int> { minimum...maximum }

    public func setpoint(_ device: HeatingDevice, for body: WaterBody) -> Int? {
        setpoints[body.rawValue]?[device.rawValue]
    }

    public func device(_ device: HeatingDevice) -> Device? {
        devices[device.rawValue]
    }
}
