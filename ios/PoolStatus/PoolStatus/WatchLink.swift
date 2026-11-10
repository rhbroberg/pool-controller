import Foundation
import os
import PoolStatusCore
import WatchConnectivity

/// Sends the watch app this app's server, pool name and sign-in, so it needs no setup of its own,
/// and answers the watch app when it asks for them.
final class WatchLink: NSObject, WCSessionDelegate {
    nonisolated private static let logger = Logger(subsystem: "com.rhbroberg.PoolStatus", category: "watch")

    /// Read on WatchConnectivity's queue to answer the watch, which may wake this app in the
    /// background before any view has appeared.
    private let context: OSAllocatedUnfairLock<WatchContext>

    init(context: WatchContext) {
        self.context = OSAllocatedUnfairLock(initialState: context)
        super.init()
        guard WCSession.isSupported() else {
            return
        }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func send(_ context: WatchContext) {
        self.context.withLock { $0 = context }
        push()
    }

    /// The system keeps only the newest context, and hands it to the watch app when it next runs.
    private func push() {
        guard WCSession.isSupported() else {
            return
        }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else {
            return
        }
        do {
            try session.updateApplicationContext(context.withLock { $0 }.dictionary)
        } catch {
            Self.logger.error("Couldn’t update the watch app: \(error.localizedDescription)")
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        if let error {
            Self.logger.error("Couldn’t link to the watch: \(error.localizedDescription)")
        }
        Task { @MainActor in push() }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                             replyHandler: @escaping ([String: Any]) -> Void) {
        guard message[WatchContext.requestKey] != nil else {
            replyHandler([:])
            return
        }
        replyHandler(context.withLock { $0 }.dictionary)
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    /// After switching to another watch, links to that one.
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    /// Sends again once the watch app is installed.
    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in push() }
    }
}
