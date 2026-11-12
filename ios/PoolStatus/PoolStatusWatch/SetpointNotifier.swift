import Foundation
import os
import PoolStatusCore
import UserNotifications
import WatchKit

/// Tells the wearer when the water should be warm, with a notification timed from the heating
/// estimate. While one is waiting the app asks watchOS to wake it now and then, so the time
/// follows the estimate and the reminder is withdrawn if the heating stops.
@MainActor
final class SetpointNotifier: NSObject, UNUserNotificationCenterDelegate {
    /// The background refresh that keeps a waiting reminder current.
    static let refreshTask = "setpointReminder"
    /// How long to ask watchOS to wait between those refreshes; it may wait longer.
    private static let refreshInterval: TimeInterval = 15 * 60
    private static let identifier = "setpointReached"
    private static let pendingKey = "setpointReminder"
    nonisolated private static let logger = Logger(subsystem: "com.rhbroberg.PoolStatus.watchkitapp", category: "notify")

    private let center = UNUserNotificationCenter.current()
    private let defaults: UserDefaults
    /// The reminder scheduled with the system and not yet shown or withdrawn.
    private var pending: SetpointReminder? {
        didSet {
            defaults.set(pending.flatMap { try? JSONEncoder().encode($0) }, forKey: Self.pendingKey)
        }
    }
    /// Updates run one after another, so a slow permission prompt can't let a later one overtake.
    private var updating: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        pending = defaults.data(forKey: Self.pendingKey).flatMap { try? JSONDecoder().decode(SetpointReminder.self, from: $0) }
        super.init()
        center.delegate = self
    }

    /// Follows what the server now says; signed out, nothing is reminded.
    func update(heating: HeatingStatus?, signedIn: Bool) {
        let previous = updating
        updating = Task {
            await previous?.value
            await apply(signedIn ? SetpointReminder.next(after: pending, heating: heating) : (pending == nil ? .keep : .cancel))
        }
    }

    /// Waits for the updates asked for so far, as a background refresh must before it ends.
    func settle() async {
        await updating?.value
    }

    private func apply(_ action: SetpointReminder.Action) async {
        switch action {
        case .keep:
            break
        case .schedule(let reminder):
            guard await isAllowed() else {
                return
            }
            let wait = max(1, reminder.date.timeIntervalSinceNow)
            await post(reminder.title, reminder.expectedMessage,
                       trigger: UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false))
            pending = reminder
        case .deliverNow(let reminder):
            await post(reminder.title, reminder.reachedMessage, trigger: nil)
            pending = nil
        case .cancel:
            center.removePendingNotificationRequests(withIdentifiers: [Self.identifier])
            pending = nil
        }
        if let pending, pending.date > .now {
            scheduleRefresh()
        }
    }

    /// Replaces whatever reminder is waiting; a nil trigger shows it at once.
    private func post(_ title: String, _ body: String, trigger: UNNotificationTrigger?) async {
        center.removePendingNotificationRequests(withIdentifiers: [Self.identifier])
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        do {
            try await center.add(UNNotificationRequest(identifier: Self.identifier, content: content, trigger: trigger))
        } catch {
            Self.logger.error("Couldn’t schedule the setpoint reminder: \(error.localizedDescription)")
        }
    }

    /// Asks once; a wearer who said no isn't asked again.
    private func isAllowed() async -> Bool {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        default:
            return false
        }
    }

    private func scheduleRefresh() {
        let date = Date.now.addingTimeInterval(Self.refreshInterval)
        WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: date, userInfo: Self.refreshTask as NSString) { error in
            if let error {
                Self.logger.error("Couldn’t schedule a refresh for the setpoint reminder: \(error.localizedDescription)")
            }
        }
    }

    /// Shows the reminder even while the app is open.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
