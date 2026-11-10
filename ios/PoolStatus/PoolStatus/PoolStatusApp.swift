import PoolStatusCore
import SwiftUI

@main
struct PoolStatusApp: App {
    @State private var store = StatusStore(live: URLSessionLiveTransport())

    var body: some Scene {
        WindowGroup {
            if store.serverAddress.isEmpty {
                ServerSetupView()
                    .environment(store)
            } else {
                StatusView()
                    .environment(store)
            }
        }
    }
}
