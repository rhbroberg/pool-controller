import Foundation

/// Keys for settings kept in `UserDefaults`, whether read with `@AppStorage` or by a store.
public enum SettingsKey {
    public static let serverAddress = "serverAddress"
    public static let poolName = "poolName"
    public static let reconnectSeconds = "reconnectSeconds"
    public static let networkScanPort = "networkScanPort"
    public static let scanTimeoutSeconds = "scanTimeoutSeconds"
    public static let showAirTemperature = "showAirTemperature"
    public static let historyHelpSeen = "historyHelpSeen"
}
