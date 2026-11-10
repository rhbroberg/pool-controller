import PoolStatusCore
import SwiftUI

@main
struct PoolStatusWatchApp: App {
    /// Polls without live updates: watchOS keeps WebSockets for apps that stream audio.
    @State private var store: StatusStore
    @State private var phone: PhoneLink
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let store = StatusStore()
        _store = State(initialValue: store)
        _phone = State(initialValue: PhoneLink(store: store))
    }

    var body: some Scene {
        WindowGroup {
            WatchStatusView()
                .environment(store)
                .environment(phone)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                phone.requestContext()
            }
        }
    }
}
