import SwiftUI

@main
struct PoolStatusApp: App {
    /// Unit tests run inside the app, which would otherwise poll a server while they run.
    private static let isRunningTests = NSClassFromString("XCTestCase") != nil
        || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    var body: some Scene {
        WindowGroup {
            if Self.isRunningTests {
                Color.clear
            } else {
                StatusView()
            }
        }
    }
}
