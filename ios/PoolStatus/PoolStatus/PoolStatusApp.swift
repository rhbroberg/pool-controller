import SwiftUI

@main
struct PoolStatusApp: App {
    /// Unit tests run inside the app, which would otherwise poll a server while they run.
    private static let isRunningTests = NSClassFromString("XCTestCase") != nil
        || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    @State private var store = StatusStore()

    var body: some Scene {
        WindowGroup {
            if Self.isRunningTests {
                Color.clear
            } else if store.serverAddress.isEmpty {
                ServerSetupView()
                    .environment(store)
            } else {
                StatusView()
                    .environment(store)
            }
        }
    }
}
