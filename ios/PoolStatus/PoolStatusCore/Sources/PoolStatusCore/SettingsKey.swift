import Foundation

/// Keys for settings kept in `UserDefaults`, whether read with `@AppStorage` or by a store.
public enum SettingsKey {
    /// The one server, on the watch and on iPhones from before sites.
    public static let serverAddress = "serverAddress"
    /// The one pool's name, on the watch and on iPhones from before sites.
    public static let poolName = "poolName"
    public static let sites = "sites"
    public static let activeSite = "activeSite"
    /// Set once the server and sign-in from before sites have become the first site.
    public static let sitesMigrated = "sitesMigrated"
    public static let reconnectSeconds = "reconnectSeconds"
    public static let networkScanPort = "networkScanPort"
    public static let scanTimeoutSeconds = "scanTimeoutSeconds"
    public static let showAirTemperature = "showAirTemperature"
    public static let showHeater = "showHeater"
    public static let showHeatPump = "showHeatPump"
    /// Thermostat keeps the heater and heat-pump setpoints for a body the same when true.
    public static let thermostatLinkedSetpoints = "thermostatLinkedSetpoints"
    public static let historyHelpSeen = "historyHelpSeen"
    /// Last zoom and pan of each history graph, so coming back opens where you left it.
    public static let poolTemperatureHistory = "poolTemperatureHistoryViewport"
    public static let spaTemperatureHistory = "spaTemperatureHistoryViewport"
    public static let saltHistory = "saltHistoryViewport"
}
