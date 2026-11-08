import Foundation
import Observation

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
    /// Setpoints and what the heater and heat pump are doing; nil from a server without them.
    private(set) var heating: HeatingStatus?
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
    private(set) var pending: [ReadingName: Bool] = [:]
    /// A requested water flow mode the controller hasn't reached yet.
    private(set) var pendingWaterMode: WaterMode?
    /// Counts changes the controller has confirmed, for haptic feedback.
    private(set) var confirmedChanges = 0
    /// Whether the saved account's role has been checked with the server since launch.
    private var accountChecked = false

    private static let measurementOrder: [ReadingName] = [.poolTemperature, .spaTemperature, .airTemperature, .salt]

    var isConnected: Bool { connection == .connected }

    var role: AccountRole? { credentials?.role }
    /// Signed in with a role that may change equipment and press panel keys.
    var canControl: Bool { role?.canControl ?? false }
    var isAdmin: Bool { role?.isAdmin ?? false }

    /// The controller's water flow mode: spillover if that switch is on, otherwise spa if it is,
    /// otherwise pool. Unknown until the server has reported the pool switch.
    var waterMode: WaterMode? {
        if reading(named: .spillover)?.isOn == true {
            return .spillover
        }
        if reading(named: .spa)?.isOn == true {
            return .spa
        }
        return reading(named: .pool) == nil ? nil : .pool
    }

    /// Whether the pump feeding `body`'s temperature sensor runs, so its reading is current.
    func pumpRunning(for body: WaterBody) -> Bool {
        reading(named: body.pump)?.isOn == true
    }

    /// Every measurement always has a slot, so the card keeps its shape while readings arrive;
    /// pool and spa are dimmed, as stale readings, while their pumps are off.
    var measurements: [DashboardReading] {
        Self.measurementOrder.map(measurement(named:))
    }

    func measurement(named name: ReadingName) -> DashboardReading {
        let body = WaterBody.allCases.first { $0.temperatureName == name }
        return DashboardReading(name: name,
                                title: name.displayName,
                                value: name.format(reading(named: name)?.value),
                                isDimmed: body.map { !pumpRunning(for: $0) } ?? false)
    }

    var needsAttention: Bool {
        reading(named: .checkSystem)?.isOn ?? false
    }

    var lastSwitchChange: Date? {
        readings.first { $0.category == .status }?.timestamp
    }

    func reading(named name: ReadingName) -> StatusReading? {
        readings.first { $0.name == name }
    }

    /// The state the controller last reported; a requested change shows only once it's confirmed.
    func isOn(_ control: EquipmentControl) -> Bool {
        reading(named: control.stateName)?.isOn ?? false
    }

    /// The state requested for `name` that the controller hasn't confirmed yet.
    func pendingState(_ name: ReadingName) -> Bool? {
        pending[name]
    }

    /// What the heater or heat pump behind `control` is doing; nil for other equipment.
    func heating(for control: EquipmentControl) -> HeatingStatus.Device? {
        HeatingDevice(controlName: control.name).flatMap { heating?.device($0) }
    }

    /// Saves each changed setpoint for `device`, then refreshes so the tiles show the new targets.
    func setSetpoints(_ setpoints: [WaterBody: Int], device: HeatingDevice, serverAddress: String) async throws {
        guard let credentials else {
            throw StatusClientError.unauthorized(message: nil)
        }
        let client = StatusClient(serverAddress: serverAddress)
        do {
            for (body, degrees) in setpoints where heating?.setpoint(device, for: body) != degrees {
                try await client.setSetpoint(degrees, device: device, body: body, token: credentials.token)
            }
        } catch StatusClientError.unauthorized {
            signOut()
            throw StatusClientError.unauthorized(message: "Your sign-in is no longer valid. Sign in again to change setpoints.")
        } catch StatusClientError.server(code: 403, message: _) {
            await refreshAccount(serverAddress: serverAddress)
            throw StatusClientError.server(code: 403, message: "Your account can’t change setpoints.")
        }
        await refresh(from: serverAddress)
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
            let client = StatusClient(serverAddress: serverAddress)
            // heating is extra detail; a server that doesn't offer it still counts as connected
            async let heatingStatus = try? client.fetchHeating()
            readings = try await client.fetchStatus()
            heating = await heatingStatus
            lastRefresh = .now
            errorMessage = nil
            markConnected()
        } catch {
            handle(error)
        }
    }

    func signIn(name: String, password: String, serverAddress: String) async throws {
        let result = try await StatusClient(serverAddress: serverAddress).signIn(name: name, password: password)
        let signedIn = Credentials(name: result.name, token: result.token, role: result.role)
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
        save(Credentials(name: result.name, token: result.token, role: result.role))
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
            verified = try await client.signIn(name: credentials.name, password: current)
        } catch StatusClientError.unauthorized {
            throw PasswordChangeError.wrongCurrentPassword
        }
        let result = try await client.changeCredentials(name: credentials.name, password: password, token: verified.token)
        save(Credentials(name: result.name, token: result.token, role: result.role ?? credentials.role))
    }

    /// Asks the server for the signed-in account's current role, which an admin may have changed.
    func refreshAccount(serverAddress: String) async {
        guard let credentials else {
            return
        }
        do {
            let account = try await StatusClient(serverAddress: serverAddress).fetchAccount(token: credentials.token)
            save(Credentials(name: account.name, token: credentials.token, role: account.role))
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
