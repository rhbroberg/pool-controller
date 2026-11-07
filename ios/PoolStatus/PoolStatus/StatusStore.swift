import Foundation
import Observation
import SwiftUI

/// Equipment the app can switch. Only buttons whose control bits are confirmed by
/// captured presses belong here; pool/spa and the heater are shown as status only.
struct EquipmentControl: Identifiable {
    let name: String
    let systemImage: String
    let tint: Color

    var id: String { name }
    var title: String { StatusReading.displayName(for: name) }

    static let all = [
        EquipmentControl(name: "filter", systemImage: "fan", tint: .blue),
        EquipmentControl(name: "lights", systemImage: "lightbulb", tint: .yellow),
        EquipmentControl(name: "superchlorinate", systemImage: "bubbles.and.sparkles", tint: .teal)
    ]
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
    /// Requested state for controls the controller hasn't confirmed yet.
    private(set) var pending: [String: Bool] = [:]

    private static let measurementOrder = ["pool temp", "spa temp", "ambient", "salt"]

    var isConnected: Bool { connection == .connected }

    var measurements: [StatusReading] {
        readings
            .filter { $0.category == .info }
            .sorted {
                (Self.measurementOrder.firstIndex(of: $0.name) ?? .max) <
                    (Self.measurementOrder.firstIndex(of: $1.name) ?? .max)
            }
    }

    /// Read-only switches shown in the status card.
    var statusSwitches: [StatusReading] {
        ["pool", "spa", "heater1"].compactMap { reading(named: $0) }
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

    func isOn(_ name: String) -> Bool {
        pending[name] ?? reading(named: name)?.isOn ?? false
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
        TokenStore.save(signedIn)
        credentials = signedIn
        markConnected()
    }

    func signOut() {
        TokenStore.delete()
        credentials = nil
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
                if reading(named: control.name)?.isOn == on || !isConnected {
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
