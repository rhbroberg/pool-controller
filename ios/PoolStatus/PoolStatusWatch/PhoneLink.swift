import Foundation
import Observation
import os
import PoolStatusCore
import WatchConnectivity

/// Takes the server, pool name and sign-in from the iPhone app whenever it sends them, and asks
/// for them when the watch app opens, so nothing is set up on the watch itself.
@Observable
final class PhoneLink: NSObject, WCSessionDelegate {
    nonisolated private static let logger = Logger(subsystem: "com.rhbroberg.PoolStatus.watchkitapp", category: "phone")

    /// Why the last attempt to get the server from the iPhone didn't, for the setup screen.
    private(set) var problem: String?
    private(set) var isAsking = false

    @ObservationIgnored private let store: StatusStore

    init(store: StatusStore) {
        self.store = store
        super.init()
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Asks the iPhone app for the newest context; the system wakes it in the background to answer.
    func requestContext() {
        let session = WCSession.default
        guard session.activationState == .activated else {
            report(String(localized: "Still linking to your iPhone."))
            return
        }
        guard session.isCompanionAppInstalled else {
            report(String(localized: "Pool Status isn’t installed on your iPhone."))
            return
        }
        guard session.isReachable else {
            report(String(localized: "Can’t reach your iPhone. Keep it nearby and unlocked."))
            return
        }
        isAsking = true
        problem = nil
        ask(session)
    }

    /// Nonisolated so its handlers are too: WatchConnectivity calls them on a queue of its own.
    nonisolated private func ask(_ session: WCSession) {
        session.sendMessage([WatchContext.requestKey: true]) { reply in
            let context = WatchContext(reply)
            Task { @MainActor in
                self.isAsking = false
                if let context {
                    self.apply(context)
                } else {
                    self.report(String(localized: "Your iPhone hasn’t connected to a server yet."))
                }
            }
        } errorHandler: { error in
            let message = error.localizedDescription
            Task { @MainActor in
                self.isAsking = false
                self.report(message)
            }
        }
    }

    private func report(_ problem: String) {
        Self.logger.error("Couldn’t get the server from the iPhone: \(problem)")
        self.problem = problem
    }

    private func apply(_ context: WatchContext) {
        problem = nil
        UserDefaults.standard.set(context.poolName, forKey: SettingsKey.poolName)
        if store.serverAddress != context.serverAddress {
            store.serverAddress = context.serverAddress
        }
        store.auth.adopt(context.credentials)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        // the newest context the iPhone sent while this app wasn't running
        let context = WatchContext(session.receivedApplicationContext)
        let failure = error?.localizedDescription
        Task { @MainActor in
            if let context {
                apply(context)
            }
            if let failure {
                report(failure)
            } else {
                requestContext()
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let context = WatchContext(applicationContext) else {
            return
        }
        Task { @MainActor in apply(context) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in requestContext() }
    }
}
