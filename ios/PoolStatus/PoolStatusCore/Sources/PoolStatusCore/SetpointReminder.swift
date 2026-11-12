import Foundation

/// The notification that the water should be warm: timed from the heating estimate, moved as the
/// estimate changes, sent at once if the water gets there early, and withdrawn when the heating
/// stops short of the setpoint. There's at most one at a time.
public nonisolated struct SetpointReminder: Codable, Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        /// Replace any waiting reminder with this one.
        case schedule(SetpointReminder)
        /// The water is there already: say so now, and drop the waiting reminder.
        case deliverNow(SetpointReminder)
        /// Drop the waiting reminder.
        case cancel
        /// Leave things as they are.
        case keep
    }

    /// A time that moves by less than this isn't worth rescheduling for.
    static let tolerance: TimeInterval = 60

    public let body: WaterBody
    public let setpoint: Int
    public let date: Date

    public init(body: WaterBody, setpoint: Int, date: Date) {
        self.body = body
        self.setpoint = setpoint
        self.date = date
    }

    public var title: String {
        String(localized: "\(body.title) is warm", bundle: .module)
    }

    /// Shown at the time the estimate gave.
    public var expectedMessage: String {
        switch body {
        case .pool: String(localized: "The pool should be at \(setpoint)° now.", bundle: .module)
        case .spa: String(localized: "The spa should be at \(setpoint)° now.", bundle: .module)
        }
    }

    /// Shown when the water is seen to get there.
    public var reachedMessage: String {
        switch body {
        case .pool: String(localized: "The pool reached \(setpoint)°.", bundle: .module)
        case .spa: String(localized: "The spa reached \(setpoint)°.", bundle: .module)
        }
    }

    /// What to do about the reminder `pending`, now that `heating` is what the server says; nil
    /// `heating` is a server that didn't answer, which changes nothing.
    public static func next(after pending: SetpointReminder?, heating: HeatingStatus?, now: Date = .now) -> Action {
        guard let heating else {
            return .keep
        }
        if let estimate = heating.estimate {
            switch estimate.status {
            case .ready:
                guard let minutes = estimate.minutes else {
                    return .keep
                }
                if minutes > 0 {
                    let date = estimate.readyAt ?? now.addingTimeInterval(TimeInterval(minutes * 60))
                    let reminder = SetpointReminder(body: estimate.body, setpoint: estimate.setpoint, date: date)
                    if let pending, pending.body == reminder.body, pending.setpoint == reminder.setpoint,
                       abs(pending.date.timeIntervalSince(reminder.date)) < tolerance {
                        return .keep
                    }
                    return .schedule(reminder)
                }
            case .unreachable, .noModel:
                return pending == nil ? .keep : .cancel
            case .settling, .noReading, .insufficientData:
                // can't tell for now; the next answer may
                return .keep
            }
        }
        guard let pending else {
            return .keep
        }
        // the sources stop calling for heat once the water is at the setpoint, and the estimate goes
        if pending.date > now, heating.target == pending.body,
           let temperature = heating.temperature(of: pending.body), temperature >= Double(pending.setpoint) {
            return .deliverNow(pending)
        }
        // stopped short, as when the pump or heat source went off or the setpoint came down; or
        // the reminder has already been shown
        return .cancel
    }
}
