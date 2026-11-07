import Foundation
import Observation
import SwiftUI

/// Equipment the app can switch. Only buttons whose control bits are confirmed by
/// captured presses belong here.
struct EquipmentControl: Identifiable {
    /// The button name sent to `PUT /devices/{name}/{state}`.
    let name: String
    let systemImage: String
    let tint: Color
    /// The reading that reports this control's state, when it isn't the status bit of the same name.
    var stateReading: String?
    var onText = "On"

    var id: String { name }
    var title: String { StatusReading.displayName(for: name) }
    var stateName: String { stateReading ?? name }

    static let all = [
        EquipmentControl(name: "filter", systemImage: "fan", tint: .blue),
        // aux14 is labelled Spa Filter on this panel; it brings valve3 and aux1 with it
        EquipmentControl(name: "aux14", systemImage: "bathtub", tint: .cyan),
        EquipmentControl(name: "lights", systemImage: "lightbulb", tint: .yellow),
        // aux3 and aux5 are labelled Yard Lights and Blower on this panel
        EquipmentControl(name: "aux3", systemImage: "lamp.floor", tint: .yellow),
        EquipmentControl(name: "aux5", systemImage: "wind", tint: .mint),
        EquipmentControl(name: "superchlorinate", systemImage: "bubbles.and.sparkles", tint: .teal),
        // the heater key switches between Manual Off and Auto Control on the panel display
        EquipmentControl(name: "heater1", systemImage: "flame", tint: .orange,
                         stateReading: "heater1 mode", onText: "Auto")
    ]
}

/// One value on the status card's measurement line.
struct Measurement: Identifiable {
    let name: String
    let title: String
    let value: String
    let isDimmed: Bool

    var id: String { name }
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

    private static let measurementOrder = ["pool temp", "spa temp", "ambient", "salt"]

    var isConnected: Bool { connection == .connected }

    /// The spa filter runs on aux14 at this installation.
    var spaFilterOn: Bool {
        reading(named: "aux14")?.isOn ?? false
    }

    /// Pool and spa temperatures always have a slot; the spa's is dimmed, as a stale
    /// reading, while the spa filter is off.
    var measurements: [Measurement] {
        Self.measurementOrder.compactMap { name in
            let reading = reading(named: name)
            guard reading != nil || name == "pool temp" || name == "spa temp" else {
                return nil
            }
            return Measurement(name: name,
                               title: StatusReading.displayName(for: name),
                               value: reading?.formattedValue ?? "--°F",
                               isDimmed: name == "spa temp" && !spaFilterOn)
        }
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

    func isOn(_ control: EquipmentControl) -> Bool {
        pending[control.name] ?? reading(named: control.stateName)?.isOn ?? false
    }

    func isPending(_ name: String) -> Bool {
        pending[name] != nil
    }

    /// Refreshes while connected; after losing the server, retries every `reconnectSeconds`.
    /// Runs until the calling task is cancelled.
    func poll(serverAddress: String, reconnectSeconds: Int) async {
        while !Task.isCancelled {
            nextAttempt = nil
            await refresh(from: serverAddress)

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
        let signedIn = Credentials(email: result.email, token: result.token)
        markConnected()
        if result.mustChangeCredentials == true {
            commissioning = signedIn
            return
        }
        TokenStore.save(signedIn)
        credentials = signedIn
    }

    /// Renames the default admin account and sets its password, then signs in as the new account.
    func commission(name: String, password: String, serverAddress: String) async throws {
        guard let commissioning else {
            return
        }
        let result = try await StatusClient(serverAddress: serverAddress)
            .changeCredentials(name: name, password: password, token: commissioning.token)
        let signedIn = Credentials(email: result.email, token: result.token)
        TokenStore.save(signedIn)
        credentials = signedIn
        self.commissioning = nil
    }

    func cancelCommissioning() {
        commissioning = nil
    }

    func signOut() {
        TokenStore.delete()
        credentials = nil
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
                if reading(named: control.stateName)?.isOn == on || !isConnected {
                    return
                }
            }
            errorMessage = "The controller hasn’t confirmed \(control.title) \(on ? "on" : "off") yet."
        } catch StatusClientError.unauthorized {
            signOut()
            errorMessage = "Your sign-in is no longer valid. Sign in again to control equipment."
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
