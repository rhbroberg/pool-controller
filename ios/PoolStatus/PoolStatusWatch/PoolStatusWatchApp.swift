import PoolStatusCore
import SwiftUI

@main
struct PoolStatusWatchApp: App {
    /// Polls without live updates: watchOS keeps WebSockets for apps that stream audio.
    @State private var store: StatusStore
    @State private var phone: PhoneLink
    @State private var notifier = SetpointNotifier()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let store = StatusStore()
        _store = State(initialValue: store)
        _phone = State(initialValue: PhoneLink(store: store))
    }

    private var isSignedIn: Bool { store.auth.credentials != nil }

    var body: some Scene {
        WindowGroup {
            WatchStatusView()
                .environment(store)
                .environment(phone)
                .onChange(of: store.heating) { _, heating in
                    notifier.update(heating: heating, signedIn: isSignedIn)
                }
                .onChange(of: isSignedIn) { _, signedIn in
                    notifier.update(heating: store.heating, signedIn: signedIn)
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                phone.requestContext()
            }
        }
        .backgroundTask(.appRefresh(SetpointNotifier.refreshTask)) {
            await refreshReminder()
        }
    }

    /// Asks the server again while a reminder is waiting, so it follows the estimate.
    private func refreshReminder() async {
        guard isSignedIn, !store.serverAddress.isEmpty else {
            return
        }
        await store.refresh()
        notifier.update(heating: store.heating, signedIn: isSignedIn)
        await notifier.settle()
    }
}
