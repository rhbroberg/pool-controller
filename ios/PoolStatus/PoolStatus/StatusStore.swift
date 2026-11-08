import Foundation
import Observation

/// The pool controller as the server reports it: readings, heating, the connection, and the
/// changes this app asks for.
@Observable
final class StatusStore {
    enum Connection {
        case connecting
        case connected
        case disconnected
    }

    /// Waits for a duration; the tests pass one that doesn't.
    typealias Sleep = (Duration) async throws -> Void

    static let refreshSeconds = 15
    static let defaultReconnectSeconds = 30
    /// How often to ask for status while waiting for the controller to report a requested change.
    static let confirmationInterval: Duration = .seconds(1)
    /// How long to wait for the controller to report a switched control.
    static let confirmationTimeout: Duration = .seconds(15)
    /// How long to wait for the controller to step through to a requested water flow mode;
    /// longer than for a switch, since it may take two presses.
    static let waterModeTimeout: Duration = .seconds(45)

    private static let measurementOrder: [ReadingName] = [.poolTemperature, .spaTemperature, .airTemperature, .salt]

    /// Empty until the first server answers.
    var serverAddress: String {
        didSet {
            defaults.set(serverAddress, forKey: SettingsKey.serverAddress)
            auth.client = client
        }
    }
    let auth: AuthSession

    private(set) var readings: [StatusReading] = []
    /// Setpoints and what the heater and heat pump are doing; nil from a server without them.
    private(set) var heating: HeatingStatus?
    private(set) var lastRefresh: Date?
    private(set) var errorMessage: String?
    private(set) var connection = Connection.connecting
    /// Why the last attempt to reach the server failed.
    private(set) var connectionFailure: String?
    /// When the next reconnection attempt is due, while disconnected.
    private(set) var nextAttempt: Date?
    /// Requested state for controls the controller hasn't confirmed yet.
    private(set) var pending: [ReadingName: Bool] = [:]
    /// A requested water flow mode the controller hasn't reached yet.
    private(set) var pendingWaterMode: WaterMode?
    /// Counts changes the controller has confirmed, for haptic feedback.
    private(set) var confirmedChanges = 0
    /// Refreshes under way; polling and change confirmation can overlap.
    private var refreshesInFlight = 0

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let sleep: Sleep
    /// Numbers each refresh, so one that finishes after a newer one doesn't replace its readings.
    @ObservationIgnored private var refreshesStarted = 0
    @ObservationIgnored private var newestApplied = 0

    init(serverAddress: String? = nil,
         defaults: UserDefaults = .standard,
         session: URLSession = .shared,
         credentials: CredentialStore = KeychainCredentialStore(),
         sleep: @escaping Sleep = { try await Task.sleep(for: $0) }) {
        let address = serverAddress ?? defaults.string(forKey: SettingsKey.serverAddress) ?? ""
        self.serverAddress = address
        self.defaults = defaults
        self.session = session
        self.sleep = sleep
        auth = AuthSession(client: StatusClient(serverAddress: address, session: session), store: credentials)
    }

    var client: StatusClient { StatusClient(serverAddress: serverAddress, session: session) }

    var isConnected: Bool { connection == .connected }
    var isLoading: Bool { refreshesInFlight > 0 }

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

    // MARK: Connecting

    /// Keeps `address` once a server there answers.
    func connect(to address: String) async throws {
        _ = try await StatusClient(serverAddress: address, session: session).fetchStatus()
        serverAddress = address
    }

    /// Refreshes while connected; after losing the server, retries every `reconnectSeconds`.
    /// Runs until the calling task is cancelled.
    func poll(reconnectSeconds: Int) async {
        while !Task.isCancelled {
            nextAttempt = nil
            await refresh()
            if isConnected && auth.needsAccountCheck {
                await auth.refreshAccount()
            }

            let wait = isConnected ? Self.refreshSeconds : reconnectSeconds
            if connection == .disconnected {
                nextAttempt = .now.addingTimeInterval(TimeInterval(wait))
            }
            try? await sleep(.seconds(wait))
        }
    }

    /// Replaces every reading with the server's current values. On failure the previous
    /// readings stay on screen, marked stale by `connection` or `errorMessage`.
    func refresh() async {
        refreshesStarted += 1
        let number = refreshesStarted
        refreshesInFlight += 1
        defer { refreshesInFlight -= 1 }

        let client = client
        do {
            // heating is extra detail; a server that doesn't offer it still counts as connected
            async let heatingStatus = try? client.fetchHeating()
            let fetched = try await client.fetchStatus()
            let fetchedHeating = await heatingStatus
            guard number > newestApplied else {
                return
            }
            newestApplied = number
            readings = fetched
            heating = fetchedHeating
            lastRefresh = .now
            errorMessage = nil
            markConnected()
        } catch {
            guard number > newestApplied else {
                return
            }
            newestApplied = number
            handle(error)
        }
    }

    // MARK: Changes

    /// Requests the change, then waits for the controller to report it.
    func setControl(_ control: EquipmentControl, on: Bool) async {
        pending[control.name] = on
        defer { pending[control.name] = nil }

        await requestChange(.changeEquipment, timeout: Self.confirmationTimeout,
                            notConfirmed: "The controller hasn’t switched \(control.title) to \(control.stateText(on)) yet.",
                            send: { client, token in try await client.setDevice(control.name, on: on, token: token) },
                            confirmed: { reading(named: control.stateName)?.isOn == on })
    }

    /// Asks the server for a water flow mode, then waits for the controller to report it.
    func setWaterMode(_ mode: WaterMode) async {
        guard mode != waterMode else {
            return
        }
        pendingWaterMode = mode
        defer { pendingWaterMode = nil }

        await requestChange(.changeWaterFlow, timeout: Self.waterModeTimeout,
                            notConfirmed: "The controller hasn’t switched to \(mode.title) yet.",
                            send: { client, token in try await client.setWaterMode(mode, token: token) },
                            confirmed: { waterMode == mode })
    }

    /// Saves each changed setpoint for `device`, then refreshes so the tiles show the new targets.
    func setSetpoints(_ setpoints: [WaterBody: Int], device: HeatingDevice) async throws {
        let changed = setpoints.filter { heating?.setpoint(device, for: $0.key) != $0.value }
        try await auth.authorized(.changeSetpoints) { client, token in
            for (body, degrees) in changed {
                try await client.setSetpoint(degrees, device: device, body: body, token: token)
            }
        }
        await refresh()
    }

    /// Sends a change, then polls status until `confirmed` holds, the server stops answering, or
    /// `timeout` passes, when `notConfirmed` is shown.
    private func requestChange(_ action: AuthSession.Action, timeout: Duration, notConfirmed: String,
                               send: (StatusClient, String) async throws -> Void,
                               confirmed: () -> Bool) async {
        do {
            try await auth.authorized(action, send)
            let attempts = Int((timeout / Self.confirmationInterval).rounded(.up))
            for _ in 0..<attempts {
                try await sleep(Self.confirmationInterval)
                await refresh()
                if confirmed() {
                    confirmedChanges += 1
                    return
                }
                if !isConnected {
                    return
                }
            }
            errorMessage = notConfirmed
        } catch let error as AuthError {
            errorMessage = error.localizedDescription
        } catch {
            handle(error)
        }
    }

    // MARK: Server maintenance (admin)

    /// Erases the server's history and accounts. Every account is gone afterwards, so this
    /// signs out; returns the server's description of the result.
    func factoryReset() async throws -> String {
        let message = try await auth.authorized(.maintainServer) { client, token in
            try await client.factoryReset(token: token)
        }
        auth.forget()
        readings = []
        return message
    }

    func restartServer() async throws {
        try await auth.authorized(.maintainServer) { client, token in
            try await client.restartServer(token: token)
        }
    }

    // MARK: Errors

    private func markConnected() {
        connection = .connected
        connectionFailure = nil
    }

    private func handle(_ error: Error) {
        if error.isCancellation {
            return
        }
        if let urlError = error as? URLError {
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
