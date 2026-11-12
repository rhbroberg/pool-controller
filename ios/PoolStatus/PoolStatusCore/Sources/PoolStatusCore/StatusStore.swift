import Foundation
import Observation

/// The pool controller as the server reports it: readings, heating, the connection, and the
/// changes this app asks for.
@Observable
public final class StatusStore {
    public enum Connection {
        case connecting
        case connected
        case disconnected
    }

    /// Waits for a duration; the tests pass one that doesn't.
    public typealias Sleep = (Duration) async throws -> Void

    public static let refreshSeconds = 15
    /// While live updates arrive, polling only catches anything they missed.
    public static let liveRefreshSeconds = 60
    /// While live, how long to wait for the push confirming a change before asking anyway.
    public static let liveConfirmationInterval: Duration = .seconds(5)
    /// How long the live updates may take to open before giving up on them.
    static let liveOpenTimeout: Duration = .seconds(10)
    static let firstLiveRetry: Duration = .seconds(1)
    static let longestLiveRetry: Duration = .seconds(30)
    /// The server fetches the forecast every half hour, so the app needn't ask on every refresh.
    public static let weatherRefreshSeconds = 300
    public static let defaultReconnectSeconds = 30
    /// How often to ask for status while waiting for the controller to report a requested change.
    public static let confirmationInterval: Duration = .milliseconds(500)
    /// How long to wait for the controller to report a switched control.
    public static let confirmationTimeout: Duration = .seconds(15)
    /// How long to wait for the controller to step through to a requested water flow mode;
    /// longer than for a switch, since it may take two presses.
    public static let waterModeTimeout: Duration = .seconds(45)

    private static let measurementOrder: [ReadingName] = [.poolTemperature, .spaTemperature, .airTemperature, .salt]

    /// Empty until the first server answers.
    public var serverAddress: String {
        didSet {
            defaults.set(serverAddress, forKey: SettingsKey.serverAddress)
            auth.client = client
        }
    }
    public let auth: AuthSession

    public private(set) var readings: [StatusReading] = []
    /// Setpoints and what the heater and heat pump are doing; nil from a server without them.
    public private(set) var heating: HeatingStatus?
    /// Today's forecast; nil until it's been asked for, and from a server without weather.
    public private(set) var weather: WeatherReport?
    public private(set) var lastRefresh: Date?
    public private(set) var errorMessage: String?
    public private(set) var connection = Connection.connecting
    /// Why the last attempt to reach the server failed.
    public private(set) var connectionFailure: String?
    /// When the next reconnection attempt is due, while disconnected.
    public private(set) var nextAttempt: Date?
    /// Requested state for controls the controller hasn't confirmed yet.
    public private(set) var pending: [ReadingName: Bool] = [:]
    /// A requested water flow mode the controller hasn't reached yet.
    public private(set) var pendingWaterMode: WaterMode?
    /// Counts changes the controller has confirmed, for haptic feedback.
    public private(set) var confirmedChanges = 0
    /// Refreshes under way; polling and change confirmation can overlap.
    private var refreshesInFlight = 0
    /// Whether the server's live updates are arriving, so changes show as the controller reports them.
    public private(set) var isLive = false

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let sleep: Sleep
    @ObservationIgnored private let live: (any LiveTransport)?
    /// The wait before the next poll, which joining or losing the live updates cuts short.
    @ObservationIgnored private var pollNap: Task<Void, Never>?
    /// Changes waiting for the next push.
    @ObservationIgnored private var pushWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
    /// Numbers each refresh, so one that finishes after a newer one doesn't replace its readings.
    @ObservationIgnored private var refreshesStarted = 0
    @ObservationIgnored private var newestApplied = 0
    /// When the weather was last asked for, whether or not the server had any.
    @ObservationIgnored private var weatherCheckedAt: Date?

    /// Without `live`, the store only polls.
    public init(serverAddress: String? = nil,
         defaults: UserDefaults = .standard,
         session: URLSession = .shared,
         credentials: CredentialStore = KeychainCredentialStore(),
         live: (any LiveTransport)? = nil,
         sleep: @escaping Sleep = { try await Task.sleep(for: $0) }) {
        let address = serverAddress ?? defaults.string(forKey: SettingsKey.serverAddress) ?? ""
        self.serverAddress = address
        self.defaults = defaults
        self.session = session
        self.live = live
        self.sleep = sleep
        auth = AuthSession(client: StatusClient(serverAddress: address, session: session), store: credentials)
    }

    public var client: StatusClient { StatusClient(serverAddress: serverAddress, session: session) }

    public var isConnected: Bool { connection == .connected }
    public var isLoading: Bool { refreshesInFlight > 0 }

    /// The controller's water flow mode: spillover if that switch is on, otherwise spa if it is,
    /// otherwise pool. Unknown until the server has reported the pool switch.
    public var waterMode: WaterMode? {
        if reading(named: .spillover)?.isOn == true {
            return .spillover
        }
        if reading(named: .spa)?.isOn == true {
            return .spa
        }
        return reading(named: .pool) == nil ? nil : .pool
    }

    /// Whether the pump feeding `body`'s temperature sensor runs, so its reading is current.
    public func pumpRunning(for body: WaterBody) -> Bool {
        reading(named: body.pump)?.isOn == true
    }

    /// Every measurement always has a slot, so the card keeps its shape while readings arrive;
    /// pool and spa are dimmed, as stale readings, while their pumps are off.
    public var measurements: [DashboardReading] {
        Self.measurementOrder.map(measurement(named:))
    }

    public func measurement(named name: ReadingName) -> DashboardReading {
        let body = WaterBody.allCases.first { $0.temperatureName == name }
        return DashboardReading(name: name,
                                title: name.displayName,
                                value: name.format(reading(named: name)?.value),
                                isDimmed: body.map { !pumpRunning(for: $0) } ?? false)
    }

    /// Today's forecast as the dashboard shows it; nil until there is one.
    public var weatherSummary: DashboardWeather? {
        weather?.summary
    }

    public var needsAttention: Bool {
        reading(named: .checkSystem)?.isOn ?? false
    }

    public var lastSwitchChange: Date? {
        readings.first { $0.category == .status }?.timestamp
    }

    public func reading(named name: ReadingName) -> StatusReading? {
        readings.first { $0.name == name }
    }

    /// The state the controller last reported; a requested change shows only once it's confirmed.
    public func isOn(_ control: EquipmentControl) -> Bool {
        reading(named: control.stateName)?.isOn ?? false
    }

    /// The state requested for `name` that the controller hasn't confirmed yet.
    public func pendingState(_ name: ReadingName) -> Bool? {
        pending[name]
    }

    /// What the heater or heat pump behind `control` is doing; nil for other equipment.
    public func heating(for control: EquipmentControl) -> HeatingStatus.Device? {
        HeatingDevice(controlName: control.name).flatMap { heating?.device($0) }
    }

    // MARK: Connecting

    /// Keeps `address` once a server there answers.
    public func connect(to address: String) async throws {
        _ = try await StatusClient(serverAddress: address, session: session).fetchStatus()
        serverAddress = address
    }

    /// Listens for live updates, and refreshes every `refreshSeconds` while connected, or
    /// `liveRefreshSeconds` while live updates arrive; after losing the server, retries every
    /// `reconnectSeconds`. Runs until the calling task is cancelled.
    public func poll(reconnectSeconds: Int) async {
        await withDiscardingTaskGroup { group in
            if let live {
                group.addTask {
                    await self.listen(using: live)
                }
            }
            await pollEvery(reconnectSeconds: reconnectSeconds)
            group.cancelAll()
        }
        isLive = false
    }

    private func pollEvery(reconnectSeconds: Int) async {
        while !Task.isCancelled {
            nextAttempt = nil
            await refresh()
            if isConnected && auth.needsAccountCheck {
                await auth.refreshAccount()
            }

            let wait = !isConnected ? reconnectSeconds : isLive ? Self.liveRefreshSeconds : Self.refreshSeconds
            if connection == .disconnected {
                nextAttempt = .now.addingTimeInterval(TimeInterval(wait))
            }
            let sleep = sleep
            let nap = Task<Void, Never> {
                try? await sleep(.seconds(wait))
            }
            pollNap = nap
            await withTaskCancellationHandler {
                await nap.value
            } onCancel: {
                nap.cancel()
            }
            pollNap = nil
        }
    }

    // MARK: Live updates

    /// Keeps the live updates connected, reconnecting with backoff, until cancelled.
    private func listen(using transport: any LiveTransport) async {
        var retry = Self.firstLiveRetry
        while !Task.isCancelled {
            guard let url = try? client.liveURL() else {
                return
            }
            if await follow(transport.open(url)) {
                retry = Self.firstLiveRetry
            }
            setLive(false)
            do {
                try await sleep(retry)
            } catch {
                return
            }
            retry = min(retry * 2, Self.longestLiveRetry)
        }
    }

    /// Applies what `socket` pushes until it closes or goes quiet; true if the server welcomed it.
    private func follow(_ socket: any LiveSocket) async -> Bool {
        defer { socket.close() }
        var joined = false
        var silence = Self.liveOpenTimeout
        do {
            while !Task.isCancelled {
                switch LivePacket(try await socket.receive(timeout: silence)) {
                case .open(let pingInterval, let pingTimeout):
                    // the server pings every pingInterval and gives up after pingTimeout more
                    silence = pingInterval + pingTimeout
                    try await socket.send(LivePacket.join)
                case .ping:
                    try await socket.send(LivePacket.pong)
                case .connect:
                    joined = true
                    setLive(true)
                case .event(let name, let payload):
                    if joined, let update = LiveUpdate(name: name, payload: payload) {
                        apply(update)
                    }
                case .close, .disconnect, .refused:
                    return joined
                case nil:
                    continue
                }
            }
        } catch {
            // closed, quiet or cancelled; the caller decides whether to try again
        }
        return joined
    }

    private func setLive(_ live: Bool) {
        guard live != isLive else {
            return
        }
        isLive = live
        // refresh at once: joining may have missed a change, and losing the live updates means
        // polling more often again, or finding the server is gone
        pollNap?.cancel()
    }

    func apply(_ update: LiveUpdate) {
        // a refresh that asked before this push mustn't put back what it replaced
        refreshesStarted += 1
        newestApplied = refreshesStarted
        switch update {
        case .readings(let pushed):
            var byName = Dictionary(pushed.map { ($0.name, $0) }, uniquingKeysWith: { _, newer in newer })
            var merged = readings.map { byName.removeValue(forKey: $0.name) ?? $0 }
            merged += pushed.filter { byName[$0.name] != nil }
            readings = merged
            lastRefresh = .now
            markConnected()
        case .heating(let pushed):
            heating = pushed
        }
        let waiters = pushWaiters.values
        pushWaiters.removeAll()
        waiters.forEach { $0.resume(returning: true) }
    }

    /// True when a push arrives within `limit`, false otherwise.
    private func nextPush(within limit: Duration) async -> Bool {
        let id = UUID()
        let sleep = sleep
        let timer = Task {
            try? await sleep(limit)
            self.pushWaiters.removeValue(forKey: id)?.resume(returning: false)
        }
        let pushed = await withCheckedContinuation { pushWaiters[id] = $0 }
        timer.cancel()
        return pushed
    }

    /// Replaces every reading with the server's current values. On failure the previous
    /// readings stay on screen, marked stale by `connection` or `errorMessage`.
    public func refresh() async {
        refreshesStarted += 1
        let number = refreshesStarted
        refreshesInFlight += 1
        defer { refreshesInFlight -= 1 }

        let client = client
        do {
            // heating is extra detail; a server that doesn't offer it still counts as connected
            async let heatingStatus = try? client.fetchHeating()
            // so is weather; a failed check keeps the last forecast and, like a successful one,
            // waits before asking again, so a server without weather isn't pestered
            let checkWeather = weatherCheckedAt.map { Date.now.timeIntervalSince($0) >= TimeInterval(Self.weatherRefreshSeconds) } ?? true
            async let weatherReport = checkWeather ? try? client.fetchWeather() : nil
            let fetched = try await client.fetchStatus()
            let fetchedHeating = await heatingStatus
            let fetchedWeather = await weatherReport
            guard number > newestApplied else {
                return
            }
            newestApplied = number
            readings = fetched
            heating = fetchedHeating
            if checkWeather {
                weatherCheckedAt = .now
                weather = fetchedWeather ?? weather
            }
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
    public func setControl(_ control: EquipmentControl, on: Bool) async {
        pending[control.name] = on
        defer { pending[control.name] = nil }

        await requestChange(.changeEquipment, timeout: Self.confirmationTimeout,
                            notConfirmed: String(localized: "The controller hasn’t switched \(control.title) to \(control.stateText(on)) yet.", bundle: .module),
                            send: { client, token in try await client.setDevice(control.name, on: on, token: token) },
                            confirmed: { reading(named: control.stateName)?.isOn == on })
    }

    /// Asks the server for a water flow mode, then waits for the controller to report it.
    public func setWaterMode(_ mode: WaterMode) async {
        guard mode != waterMode else {
            return
        }
        pendingWaterMode = mode
        defer { pendingWaterMode = nil }

        await requestChange(.changeWaterFlow, timeout: Self.waterModeTimeout,
                            notConfirmed: String(localized: "The controller hasn’t switched to \(mode.title) yet.", bundle: .module),
                            send: { client, token in try await client.setWaterMode(mode, token: token) },
                            confirmed: { waterMode == mode })
    }

    /// Saves each changed setpoint for `device`, then refreshes so the tiles show the new targets.
    public func setSetpoints(_ setpoints: [WaterBody: Int], device: HeatingDevice) async throws {
        let changed = setpoints.filter { heating?.setpoint(device, for: $0.key) != $0.value }
        try await auth.authorized(.changeSetpoints) { client, token in
            for (body, degrees) in changed {
                try await client.setSetpoint(degrees, device: device, body: body, token: token)
            }
        }
        await refresh()
    }

    /// Sends a change, then waits until `confirmed` holds, the server stops answering, or
    /// `timeout` passes, when `notConfirmed` is shown. While live, the controller's report
    /// arrives as a push; otherwise it's polled for.
    private func requestChange(_ action: AuthSession.Action, timeout: Duration, notConfirmed: String,
                               send: (StatusClient, String) async throws -> Void,
                               confirmed: () -> Bool) async {
        do {
            try await auth.authorized(action, send)
            var remaining = timeout
            while remaining > .zero {
                if isLive {
                    if confirmed() {
                        confirmedChanges += 1
                        return
                    }
                    let started = ContinuousClock.now
                    // a push missed while the connection changed is caught by asking now and then
                    if await !nextPush(within: min(Self.liveConfirmationInterval, remaining)) {
                        await refresh()
                    }
                    remaining -= max(started.duration(to: .now), .milliseconds(1))
                } else {
                    // the controller usually reports a change well within a second of the request,
                    // so look straight away rather than waiting first
                    await refresh()
                    if !confirmed() && isConnected {
                        try await sleep(Self.confirmationInterval)
                        remaining -= Self.confirmationInterval
                    }
                }
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

    /// The server's identity and build; nil if it can't be reached.
    public func systemInfo() async -> SystemInfo? {
        try? await client.fetchSystemInfo(timeout: StatusClient.defaultTimeout)
    }

    // MARK: Server maintenance (admin)

    /// Erases the server's history and accounts. Every account is gone afterwards, so this
    /// signs out; returns the server's description of the result.
    public func factoryReset() async throws -> String {
        let message = try await auth.authorized(.maintainServer) { client, token in
            try await client.factoryReset(token: token)
        }
        auth.forget()
        readings = []
        return message
    }

    public func restartServer() async throws {
        try await auth.authorized(.maintainServer) { client, token in
            try await client.restartServer(token: token)
        }
    }

    public func serverSettings() async throws -> ServerSettings {
        try await auth.authorized(.configureServer) { client, token in
            try await client.fetchSettings(token: token)
        }
    }

    public func updateServerSettings(_ changes: ServerSettings.Changes) async throws -> ServerSettings {
        let settings = try await auth.authorized(.configureServer) { client, token in
            try await client.updateSettings(changes, token: token)
        }
        if changes.zipCode != nil || changes.timeZone != nil {
            // the server fetches the new forecast straight away; the next refresh picks it up
            weatherCheckedAt = nil
            if settings.location == nil {
                weather = nil
            }
        }
        return settings
    }

    public func maintenanceJobs() async throws -> [MaintenanceJob] {
        try await auth.authorized(.configureServer) { client, token in
            try await client.fetchJobs(token: token)
        }
    }

    /// Runs a maintenance job now; answers with how the run went.
    public func runMaintenanceJob(_ name: String) async throws -> MaintenanceJob {
        try await auth.authorized(.configureServer) { client, token in
            try await client.runJob(name, token: token)
        }
    }

    /// Starts reading stored frames again; answers with the run, which goes on in the server.
    public func startReprocess(_ request: ReprocessRequest) async throws -> ReprocessRun {
        try await auth.authorized(.configureServer) { client, token in
            try await client.startReprocess(request, token: token)
        }
    }

    /// The reprocessing run under way or the last one, or nil.
    public func reprocessRun() async throws -> ReprocessRun? {
        try await auth.authorized(.configureServer) { client, token in
            try await client.fetchReprocess(token: token)
        }
    }

    // MARK: Heating estimates

    /// The model in use and where a scan starts by default.
    public func heatingModel() async throws -> HeatingModelState {
        try await client.fetchHeatingModel()
    }

    public func startHeatingScan(_ request: HeatingScanRequest) async throws -> HeatingScan {
        try await auth.authorized(.configureServer) { client, token in
            try await client.startHeatingScan(request, token: token)
        }
    }

    /// The scan under way or the last one, or nil.
    public func heatingScan() async throws -> HeatingScan? {
        try await auth.authorized(.configureServer) { client, token in
            try await client.fetchHeatingScan(token: token)
        }
    }

    public func heatingWindows() async throws -> HeatingWindows {
        try await auth.authorized(.configureServer) { client, token in
            try await client.fetchHeatingWindows(token: token)
        }
    }

    public func previewHeatingModel(_ request: HeatingModelRequest) async throws -> HeatingModelPreview {
        try await auth.authorized(.configureServer) { client, token in
            try await client.previewHeatingModel(request, token: token)
        }
    }

    /// Keeps a previewed model; every estimate uses it from then on, and the server pushes the
    /// new heating state to the apps.
    public func saveHeatingModel(previewId: String) async throws -> HeatingModelState {
        try await auth.authorized(.configureServer) { client, token in
            try await client.saveHeatingModel(previewId: previewId, token: token)
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
