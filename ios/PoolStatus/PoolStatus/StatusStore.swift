import Foundation
import Observation
import SwiftUI

/// Equipment the app can switch. Only buttons whose control bits are confirmed by
/// captured presses belong here.
struct EquipmentControl: Identifiable {
    /// Where a control sits on the main page.
    enum Group: CaseIterable {
        case heating, circulation, features

        var title: String {
            switch self {
            case .heating: "Heating"
            case .circulation: "Circulation"
            case .features: "Lights & Features"
            }
        }
    }

    /// Asked before a change that is easy to make by accident and costly to get wrong.
    struct Confirmation {
        let title: String
        let message: String
        let action: String
    }

    /// The button name sent to `PUT /devices/{name}/{state}`.
    let name: String
    let systemImage: String
    let tint: Color
    let group: Group
    /// The reading that reports this control's state, when it isn't the status bit of the same name.
    var stateReading: String?
    var onText = "On"
    var offText = "Off"
    var confirmOn: Confirmation?
    var confirmOff: Confirmation?

    var id: String { name }
    var title: String { StatusReading.displayName(for: name) }
    var stateName: String { stateReading ?? name }

    func stateText(_ on: Bool) -> String {
        on ? onText : offText
    }

    /// Shown while the controller hasn't yet reported the requested state; short enough for a
    /// half-width tile.
    func pendingText(_ on: Bool) -> String {
        onText == "On" ? "Turning \(stateText(on))…" : "To \(stateText(on))…"
    }

    func confirmation(turningOn on: Bool) -> Confirmation? {
        on ? confirmOn : confirmOff
    }

    static let all = [
        // the heater key switches between Manual Off and Auto Control on the panel display
        EquipmentControl(name: "heater1", systemImage: "flame", tint: .orange, group: .heating,
                         stateReading: "heater1 mode", onText: "Auto", offText: "Manual Off"),
        // valve4 runs the heat pump at this installation
        EquipmentControl(name: "valve4", systemImage: "heat.waves", tint: .pink, group: .heating),
        EquipmentControl(name: "filter", systemImage: "fan", tint: .blue, group: .circulation,
                         confirmOff: Confirmation(
                            title: "Turn off the filter?",
                            message: "The pump stops. Water stops circulating, and the pool temperature reading pauses until it runs again.",
                            action: "Turn Off Filter")),
        // aux14 is labelled Spa Filter on this panel; it brings valve3 and aux1 with it
        EquipmentControl(name: "aux14", systemImage: "bathtub", tint: .cyan, group: .circulation),
        EquipmentControl(name: "lights", systemImage: "lightbulb", tint: .yellow, group: .features),
        // aux3 and aux5 are labelled Yard Lights and Blower on this panel
        EquipmentControl(name: "aux3", systemImage: "lamp.floor", tint: .green, group: .features),
        EquipmentControl(name: "aux5", systemImage: "wind", tint: .mint, group: .features),
        EquipmentControl(name: "superchlorinate", systemImage: "bubbles.and.sparkles", tint: .teal, group: .features,
                         confirmOn: Confirmation(
                            title: "Start super chlorinating?",
                            message: "The chlorinator runs at full output until the controller ends the cycle or you turn it off.",
                            action: "Super Chlorinate"))
    ]

    static func controls(in group: Group) -> [EquipmentControl] {
        all.filter { $0.group == group }
    }
}

/// Where the water flows. The controller's spillover key steps through these in order.
enum WaterMode: String, CaseIterable, Identifiable {
    case pool, spa, spillover

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

/// One value on the temperature card.
struct Measurement: Identifiable {
    let name: String
    let title: String
    let value: String
    /// The pump feeding this sensor is off, so the reading is from when it last ran.
    let isDimmed: Bool

    var id: String { name }
}

enum PasswordChangeError: LocalizedError {
    case wrongCurrentPassword

    var errorDescription: String? {
        "Your current password isn’t correct."
    }
}

@Observable
final class StatusStore {
    enum Connection {
        case connecting
        case connected
        case disconnected
    }

    static let refreshSeconds = 15
    static let defaultReconnectSeconds = 30
    /// How long to keep polling for the controller to report a requested change.
    static let confirmationTimeout: Duration = .seconds(15)

    private(set) var readings: [StatusReading] = []
    private(set) var lastRefresh: Date?
    private(set) var errorMessage: String?
    private(set) var isLoading = false
    private(set) var connection = Connection.connecting
    /// Why the last attempt to reach the server failed.
    private(set) var connectionFailure: String?
    /// When the next reconnection attempt is due, while disconnected.
    private(set) var nextAttempt: Date?
    private(set) var credentials = TokenStore.load()
    /// The default admin account, signed in but not yet renamed. Its token only works for
    /// commissioning, so it isn't saved.
    private(set) var commissioning: Credentials?
    /// Requested state for controls the controller hasn't confirmed yet.
    private(set) var pending: [String: Bool] = [:]
    /// A requested water flow mode the controller hasn't reached yet.
    private(set) var pendingWaterMode: WaterMode?
    /// Counts changes the controller has confirmed, for haptic feedback.
    private(set) var confirmedChanges = 0
    /// Whether the saved account's role has been checked with the server since launch.
    private var accountChecked = false

    private static let measurementOrder = ["pool temp", "spa temp", "ambient", "salt"]

    var isConnected: Bool { connection == .connected }

    var role: AccountRole? { credentials?.role }
    /// Signed in with a role that may change equipment and press panel keys.
    var canControl: Bool { role?.canControl ?? false }
    var isAdmin: Bool { role?.isAdmin ?? false }

    /// The controller's water flow mode: spillover if that switch is on, otherwise spa if it is,
    /// otherwise pool. Unknown until the server has reported the pool switch.
    var waterMode: WaterMode? {
        if reading(named: "spillover")?.isOn == true {
            return .spillover
        }
        if reading(named: "spa")?.isOn == true {
            return .spa
        }
        return reading(named: "pool") == nil ? nil : .pool
    }

    /// Whether the pump feeding a temperature sensor runs: each sensor sits just downstream of
    /// its pump, so its reading is current only then. The pool's is the filter pump; the spa's is
    /// the spa filter (aux14 at this installation), whatever the water flow mode.
    func pumpRunning(for temperatureName: String) -> Bool {
        reading(named: Self.pumpForTemperature[temperatureName] ?? "")?.isOn == true
    }

    static let pumpForTemperature = ["pool temp": "filter", "spa temp": "aux14"]

    /// Every measurement always has a slot, so the card keeps its shape while readings arrive;
    /// pool and spa are dimmed, as stale readings, while their pumps are off.
    var measurements: [Measurement] {
        Self.measurementOrder.map(measurement(named:))
    }

    func measurement(named name: String) -> Measurement {
        let reading = reading(named: name)
        return Measurement(name: name,
                           title: StatusReading.displayName(for: name),
                           value: reading?.formattedValue ?? (name == "salt" ? "-- ppm" : "--°F"),
                           isDimmed: Self.pumpForTemperature[name] != nil && !pumpRunning(for: name))
    }

    var needsAttention: Bool {
        reading(named: "check system")?.isOn ?? false
    }

    var lastSwitchChange: Date? {
        readings.first { $0.category == .status }?.timestamp
    }

    func reading(named name: String) -> StatusReading? {
        readings.first { $0.name == name }
    }

    /// The state the controller last reported; a requested change shows only once it's confirmed.
    func isOn(_ control: EquipmentControl) -> Bool {
        reading(named: control.stateName)?.isOn ?? false
    }

    /// The state requested for `name` that the controller hasn't confirmed yet.
    func pendingState(_ name: String) -> Bool? {
        pending[name]
    }

    /// Refreshes while connected; after losing the server, retries every `reconnectSeconds`.
    /// Runs until the calling task is cancelled.
    func poll(serverAddress: String, reconnectSeconds: Int) async {
        while !Task.isCancelled {
            nextAttempt = nil
            await refresh(from: serverAddress)
            if isConnected && credentials != nil && !accountChecked {
                await refreshAccount(serverAddress: serverAddress)
            }

            let wait = isConnected ? Self.refreshSeconds : reconnectSeconds
            if connection == .disconnected {
                nextAttempt = .now.addingTimeInterval(TimeInterval(wait))
            }
            try? await Task.sleep(for: .seconds(wait))
        }
    }

    /// Replaces every reading with the server's current values. On failure the previous
    /// readings stay on screen, marked stale by `connection` or `errorMessage`.
    func refresh(from serverAddress: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            readings = try await StatusClient(serverAddress: serverAddress).fetchStatus()
            lastRefresh = .now
            errorMessage = nil
            markConnected()
        } catch {
            handle(error)
        }
    }

    func signIn(email: String, password: String, serverAddress: String) async throws {
        let result = try await StatusClient(serverAddress: serverAddress).signIn(email: email, password: password)
        let signedIn = Credentials(email: result.email, token: result.token, role: result.role)
        markConnected()
        if result.mustChangeCredentials == true {
            commissioning = signedIn
            return
        }
        save(signedIn)
    }

    /// Renames the default admin account and sets its password, then signs in as the new account.
    func commission(name: String, password: String, serverAddress: String) async throws {
        guard let commissioning else {
            return
        }
        let result = try await StatusClient(serverAddress: serverAddress)
            .changeCredentials(name: name, password: password, token: commissioning.token)
        save(Credentials(email: result.email, token: result.token, role: result.role))
        self.commissioning = nil
    }

    func cancelCommissioning() {
        commissioning = nil
    }

    /// Sets a new password for the signed-in account once `current` proves who is asking. The
    /// server signs the account out everywhere else, so this keeps the new token it returns.
    func changePassword(current: String, new password: String, serverAddress: String) async throws {
        guard let credentials else {
            throw StatusClientError.unauthorized(message: nil)
        }
        let client = StatusClient(serverAddress: serverAddress)
        let verified: SignInResult
        do {
            verified = try await client.signIn(email: credentials.email, password: current)
        } catch StatusClientError.unauthorized {
            throw PasswordChangeError.wrongCurrentPassword
        }
        let result = try await client.changeCredentials(name: credentials.email, password: password, token: verified.token)
        save(Credentials(email: result.email, token: result.token, role: result.role ?? credentials.role))
    }

    /// Asks the server for the signed-in account's current role, which an admin may have changed.
    func refreshAccount(serverAddress: String) async {
        guard let credentials else {
            return
        }
        do {
            let account = try await StatusClient(serverAddress: serverAddress).fetchAccount(token: credentials.token)
            save(Credentials(email: account.email, token: credentials.token, role: account.role))
        } catch StatusClientError.unauthorized {
            signOut()
        } catch {
            return
        }
    }

    /// Forgets the sign-in; with a server address, also ends the session on the server.
    func signOut(serverAddress: String? = nil) {
        if let token = credentials?.token, let serverAddress {
            Task { try? await StatusClient(serverAddress: serverAddress).signOut(token: token) }
        }
        TokenStore.delete()
        credentials = nil
        accountChecked = false
    }

    private func save(_ signedIn: Credentials) {
        TokenStore.save(signedIn)
        credentials = signedIn
        accountChecked = signedIn.role != nil
    }

    /// Erases the server's history and accounts. Every account is gone afterwards, so this
    /// signs out; returns the server's description of the result.
    func factoryReset(serverAddress: String) async throws -> String {
        guard let credentials else {
            throw StatusClientError.unauthorized(message: nil)
        }
        let message = try await StatusClient(serverAddress: serverAddress).factoryReset(token: credentials.token)
        signOut()
        readings = []
        return message
    }

    func restartServer(serverAddress: String) async throws {
        guard let credentials else {
            throw StatusClientError.unauthorized(message: nil)
        }
        try await StatusClient(serverAddress: serverAddress).restartServer(token: credentials.token)
    }

    /// Requests the change, then polls status until the controller reports it or the
    /// confirmation timeout passes.
    func setControl(_ control: EquipmentControl, on: Bool, serverAddress: String) async {
        guard let credentials else {
            errorMessage = StatusClientError.unauthorized(message: nil).errorDescription
            return
        }

        pending[control.name] = on
        defer { pending[control.name] = nil }

        do {
            try await StatusClient(serverAddress: serverAddress)
                .setDevice(control.name, on: on, token: credentials.token)

            let deadline = ContinuousClock.now + Self.confirmationTimeout
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .seconds(1))
                await refresh(from: serverAddress)
                if reading(named: control.stateName)?.isOn == on {
                    confirmedChanges += 1
                    return
                }
                if !isConnected {
                    return
                }
            }
            errorMessage = "The controller hasn’t switched \(control.title) to \(control.stateText(on)) yet."
        } catch StatusClientError.unauthorized {
            signOut()
            errorMessage = "Your sign-in is no longer valid. Sign in again to control equipment."
        } catch StatusClientError.server(code: 403, message: _) {
            // an admin may have changed this account's role
            await refreshAccount(serverAddress: serverAddress)
            errorMessage = "Your account can’t change equipment."
        } catch {
            handle(error)
        }
    }

    /// How long to wait for the controller to step through to a requested water flow mode;
    /// longer than for a switch, since it may take two presses.
    static let waterModeTimeout: Duration = .seconds(45)

    /// Asks the server for a water flow mode, then polls until the controller reports it.
    func setWaterMode(_ mode: WaterMode, serverAddress: String) async {
        guard let credentials, mode != waterMode else {
            return
        }
        pendingWaterMode = mode
        defer { pendingWaterMode = nil }

        do {
            try await StatusClient(serverAddress: serverAddress).setWaterMode(mode, token: credentials.token)
            let deadline = ContinuousClock.now + Self.waterModeTimeout
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .seconds(1))
                await refresh(from: serverAddress)
                if waterMode == mode {
                    confirmedChanges += 1
                    return
                }
                if !isConnected {
                    return
                }
            }
            errorMessage = "The controller hasn’t switched to \(mode.title) yet."
        } catch StatusClientError.unauthorized {
            signOut()
            errorMessage = "Your sign-in is no longer valid. Sign in again to change the water flow."
        } catch StatusClientError.server(code: 403, message: _) {
            await refreshAccount(serverAddress: serverAddress)
            errorMessage = "Your account can’t change the water flow."
        } catch {
            handle(error)
        }
    }

    private func markConnected() {
        connection = .connected
        connectionFailure = nil
    }

    private func handle(_ error: Error) {
        if error is CancellationError {
            return
        }
        if let urlError = error as? URLError {
            if urlError.code == .cancelled {
                return
            }
            connection = .disconnected
            connectionFailure = urlError.localizedDescription
            return
        }
        switch error as? StatusClientError {
        case .invalidAddress, .badResponse:
            connection = .disconnected
            connectionFailure = error.localizedDescription
        default:
            // the server answered, so the connection is fine even though the request failed
            markConnected()
            errorMessage = error.localizedDescription
        }
    }
}
