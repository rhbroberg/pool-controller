import Foundation

/// The heater and heat pump. They're in series, so both heat whichever body the water flows to,
/// each toward its own setpoint for that body.
enum HeatingDevice: String, CaseIterable, Identifiable {
    case heater1, heatpump

    var id: String { rawValue }
    var title: String { self == .heater1 ? "Heater" : "Heat Pump" }

    /// The equipment control that enables it.
    var controlName: String { self == .heater1 ? "heater1" : "valve4" }

    init?(controlName: String) {
        guard let device = Self.allCases.first(where: { $0.controlName == controlName }) else {
            return nil
        }
        self = device
    }
}

extension WaterBody: Decodable, CaseIterable {
    static var allCases: [WaterBody] { [.pool, .spa] }
}

/// `GET /heating`: every setpoint, and what each heating device is doing with them.
struct HeatingStatus: Decodable {
    struct Device: Decodable {
        /// Switched on (the heater in Auto); nil until the controller reports it.
        let enabled: Bool?
        /// Producing heat. An enabled device stops once its water reaches the setpoint and
        /// starts again when the water cools below it.
        let heating: Bool
        let callingForHeat: Bool
        /// The body it's driving toward; nil while no pump runs, since no water reaches it.
        let body: WaterBody?
        let setpoint: Int?
        let temperature: Double?
    }

    let target: WaterBody?
    let minimum: Int
    let maximum: Int
    /// False while the server keeps the setpoints itself instead of the controller's.
    let setpointsReachController: Bool
    let setpoints: [String: [String: Int]]
    let devices: [String: Device]

    var range: ClosedRange<Int> { minimum...maximum }

    func setpoint(_ device: HeatingDevice, for body: WaterBody) -> Int? {
        setpoints[body.rawValue]?[device.rawValue]
    }

    func device(_ device: HeatingDevice) -> Device? {
        devices[device.rawValue]
    }
}
