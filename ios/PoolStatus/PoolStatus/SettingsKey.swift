import Foundation

/// Keys for settings kept in `UserDefaults`, whether read with `@AppStorage` or by a store.
enum SettingsKey {
    static let serverAddress = "serverAddress"
    static let poolName = "poolName"
    static let reconnectSeconds = "reconnectSeconds"
    static let networkScanPort = "networkScanPort"
    static let scanTimeoutSeconds = "scanTimeoutSeconds"
    static let showAirTemperature = "showAirTemperature"
    static let historyHelpSeen = "historyHelpSeen"
}
