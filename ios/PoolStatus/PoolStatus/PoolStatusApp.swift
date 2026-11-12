import PoolStatusCore
import SwiftUI

@main
struct PoolStatusApp: App {
    @State private var store: StatusStore
    @State private var watchLink: WatchLink
    @AppStorage(SettingsKey.poolName) private var poolName = StatusView.defaultPoolName

    init() {
        let store = StatusStore(live: URLSessionLiveTransport())
        _store = State(initialValue: store)
        // the watch app can wake this app in the background, before any view appears, to ask for this
        let poolName = UserDefaults.standard.string(forKey: SettingsKey.poolName) ?? StatusView.defaultPoolName
        _watchLink = State(initialValue: WatchLink(context: Self.watchContext(store: store, poolName: poolName)))
    }

    var body: some Scene {
        WindowGroup {
            // the server first, then a sign-in; nothing from the pool shows before both
            Group {
                if store.serverAddress.isEmpty {
                    ServerSetupView()
                } else if store.auth.credentials == nil {
                    SignInView()
                } else {
                    StatusView()
                }
            }
            .environment(store)
            .onChange(of: Self.watchContext(store: store, poolName: poolName)) { _, context in
                watchLink.send(context)
            }
        }
    }

    private static func watchContext(store: StatusStore, poolName: String) -> WatchContext {
        WatchContext(serverAddress: store.serverAddress, poolName: poolName, credentials: store.auth.credentials)
    }
}
