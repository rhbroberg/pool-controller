import Foundation
import Testing
@testable import PoolStatusCore

/// A live updates connection the test drives: what the app sends is recorded, what the server
/// sends is pushed.
nonisolated final class FakeLiveSocket: LiveSocket, @unchecked Sendable {
    let url: URL
    private let messages: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation
    private let iterator: Shared<AsyncStream<String>.Iterator>
    private let sentMessages = Shared([String]())
    private let timeouts = Shared([Duration]())
    private let isClosed = Shared(false)

    init(url: URL) {
        self.url = url
        (messages, continuation) = AsyncStream.makeStream(of: String.self)
        iterator = Shared(messages.makeAsyncIterator())
    }

    var sent: [String] { sentMessages.value }
    var closed: Bool { isClosed.value }
    var receiveTimeouts: [Duration] { timeouts.value }

    func push(_ text: String) {
        continuation.yield(text)
    }

    func hangUp() {
        continuation.finish()
    }

    func send(_ text: String) async throws {
        sentMessages.modify { $0.append(text) }
    }

    func receive(timeout: Duration) async throws -> String {
        timeouts.modify { $0.append(timeout) }
        // only the store's listener receives, one message at a time
        var next = iterator.value
        let text = await next.next()
        iterator.value = next
        guard let text else {
            throw LiveError.silent
        }
        return text
    }

    func close() {
        isClosed.value = true
        continuation.finish()
    }
}

nonisolated final class FakeLiveTransport: LiveTransport, @unchecked Sendable {
    private let opened = Shared([FakeLiveSocket]())

    var sockets: [FakeLiveSocket] { opened.value }

    func open(_ url: URL) -> any LiveSocket {
        let socket = FakeLiveSocket(url: url)
        opened.modify { $0.append(socket) }
        return socket
    }
}

/// Waits, briefly, for `condition` to hold while the store's tasks run.
private func until(_ what: Comment, _ condition: () -> Bool) async throws {
    for _ in 0..<400 where !condition() {
        try await Task.sleep(for: .milliseconds(5))
    }
    #expect(condition(), what)
}

private enum Packet {
    static let open = #"0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#
    static let welcome = #"40{"sid":"def"}"#

    static func readings(_ entries: [(name: String, category: String, value: Double)]) -> String {
        #"42["readings",{"readings":\#(Fixture.status(entries))}]"#
    }
}

@Suite("Live update packets")
struct LivePacketTests {
    @Test("reads the session opening, pings, joining, events and refusals")
    func packets() throws {
        #expect(LivePacket(Packet.open) == .open(pingInterval: .seconds(25), pingTimeout: .seconds(20)))
        #expect(LivePacket("2") == .ping)
        #expect(LivePacket("1") == .close)
        #expect(LivePacket(Packet.welcome) == .connect)
        #expect(LivePacket("41") == .disconnect)
        #expect(LivePacket(#"44{"message":"not authorized"}"#) == .refused("not authorized"))

        guard case .event(let name, let payload) = LivePacket(#"4212["heating",{"minimum":65}]"#) else {
            Issue.record("an event with an acknowledgement id")
            return
        }
        #expect(name == "heating")
        let body = try #require(try JSONSerialization.jsonObject(with: payload) as? [String: Int])
        #expect(body == ["minimum": 65])
    }

    @Test("ignores what it doesn't understand", arguments: ["", "6", "42not json", #"42{"a":1}"#, #"42/admin,["x"]"#, "0garbage"])
    func junk(_ text: String) {
        #expect(LivePacket(text) == nil)
    }

    @Test("reads pushed readings, skipping any it can't, and pushed heating")
    func updates() throws {
        let payload = Data(#"{"readings":[{"name":"filter","category":"status","value":1,"timestamp":"\#(Fixture.time)"},{"name":"broken"},{"name":"pool temp","category":"info","value":81,"timestamp":"\#(Fixture.time)"}]}"#.utf8)
        guard case .readings(let readings) = LiveUpdate(name: "readings", payload: payload) else {
            Issue.record("readings")
            return
        }
        #expect(readings.map(\.name) == [.filter, .poolTemperature])
        #expect(readings.first?.isOn == true)

        guard case .heating(let heating) = LiveUpdate(name: "heating", payload: Data(Fixture.heating().utf8)) else {
            Issue.record("heating")
            return
        }
        #expect(heating.target == .pool)
        #expect(LiveUpdate(name: "weather", payload: Data("{}".utf8)) == nil)
        #expect(LiveUpdate(name: "readings", payload: Data(#""text""#.utf8)) == nil)
    }

    @Test("reaches the live updates where the API is, securely when it is")
    func url() throws {
        #expect(try StatusClient(serverAddress: "pool.local:3000").liveURL().absoluteString
                == "ws://pool.local:3000/socket.io/?EIO=4&transport=websocket")
        #expect(try StatusClient(serverAddress: "https://pool.example.com/").liveURL().absoluteString
                == "wss://pool.example.com/socket.io/?EIO=4&transport=websocket")
        #expect(throws: StatusClientError.self) {
            try StatusClient(serverAddress: "").liveURL()
        }
    }
}

@Suite("Status with live updates")
struct LiveStatusTests {
    /// Polls wait until cancelled; anything shorter, such as a retry, doesn't wait.
    private static func sleep(recording waits: Shared<[Duration]>) -> StatusStore.Sleep {
        { duration in
            waits.modify { $0.append(duration) }
            if duration >= .seconds(StatusStore.refreshSeconds) || duration == StatusStore.liveConfirmationInterval {
                try await Task.sleep(for: .seconds(3600))
            }
            try Task.checkCancellation()
        }
    }

    private static func server(lightsOn: Shared<Bool> = Shared(false)) -> StubServer {
        StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): return .ok(Fixture.login("operator"))
            case ("PUT", "devices/lights/true"): return .ok("{}")
            case ("GET", "status"):
                return .ok(Fixture.status(Fixture.switches(lightsOn.value ? ["lights"] : [], off: lightsOn.value ? [] : ["lights"])
                                          + [("pool temp", "info", 81)]))
            default: return .status(404)
            }
        }
    }

    @Test("joins the live updates, applies what they push, and polls less often meanwhile")
    func joins() async throws {
        let server = Self.server()
        let transport = FakeLiveTransport()
        let waits = Shared([Duration]())
        let store = server.makeStore(live: transport, sleep: Self.sleep(recording: waits))
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }

        try await until("the live updates are opened") { transport.sockets.count == 1 }
        let socket = transport.sockets[0]
        #expect(socket.url.absoluteString == "ws://\(server.address)/socket.io/?EIO=4&transport=websocket")
        try await until("the first poll waits the usual time") { waits.value == [.seconds(StatusStore.refreshSeconds)] }

        socket.push(Packet.open)
        socket.push(Packet.welcome)
        try await until("it joins") { store.isLive }
        #expect(socket.sent == [LivePacket.join])
        try await until("joining refreshes at once, then waits longer") {
            waits.value.last == .seconds(StatusStore.liveRefreshSeconds)
        }
        #expect(server.requests.filter { $0 == "GET status" }.count == 2)
        #expect(socket.receiveTimeouts.last == .seconds(45), "a ping interval and timeout of silence")

        socket.push("2")
        try await until("it answers the server's ping") { socket.sent == [LivePacket.join, LivePacket.pong] }

        let lights = try #require(EquipmentControl.control(named: .lights))
        socket.push(Packet.readings(Fixture.switches(["lights"])))
        try await until("the push shows") { store.isOn(lights) }
        #expect(store.reading(named: .poolTemperature)?.value == 81, "readings the push doesn't carry stay")

        socket.push(#"42["heating",\#(Fixture.heating(target: "spa"))]"#)
        try await until("pushed heating shows") { store.heating?.target == .spa }
    }

    @Test("polls as usual again after losing the live updates, and reconnects")
    func reconnects() async throws {
        let server = Self.server()
        let transport = FakeLiveTransport()
        let waits = Shared([Duration]())
        let store = server.makeStore(live: transport, sleep: Self.sleep(recording: waits))
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }

        try await until("the live updates are opened") { transport.sockets.count == 1 }
        transport.sockets[0].push(Packet.open)
        transport.sockets[0].push(Packet.welcome)
        try await until("it joins") { store.isLive }

        transport.sockets[0].hangUp()
        try await until("it notices") { !store.isLive }
        try await until("it polls as often as without live updates") {
            waits.value.last == .seconds(StatusStore.refreshSeconds)
        }
        try await until("it tries again") { transport.sockets.count == 2 }
        #expect(waits.value.contains(StatusStore.firstLiveRetry))

        transport.sockets[1].push(#"44{"message":"no"}"#)
        try await until("a refusal ends that try") { transport.sockets[1].closed }
        try await until("and it tries again, after longer") { transport.sockets.count == 3 }
        #expect(waits.value.contains(StatusStore.firstLiveRetry * 2))
    }

    @Test("confirms a change from the push rather than by polling")
    func confirmsFromPush() async throws {
        let server = Self.server()
        let transport = FakeLiveTransport()
        let waits = Shared([Duration]())
        let store = server.makeStore(live: transport, sleep: Self.sleep(recording: waits))
        try await store.auth.signIn(name: "operator", password: "operator-password")
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }

        try await until("the live updates are opened") { transport.sockets.count == 1 }
        let socket = transport.sockets[0]
        socket.push(Packet.open)
        socket.push(Packet.welcome)
        try await until("it joins and catches up") {
            store.isLive && waits.value.last == .seconds(StatusStore.liveRefreshSeconds)
        }
        let polled = server.requests.filter { $0 == "GET status" }.count

        let lights = try #require(EquipmentControl.control(named: .lights))
        let change = Task { await store.setControl(lights, on: true) }
        try await until("the change is sent") { server.requests.contains("PUT devices/lights/true") }
        #expect(store.pendingState(.lights) == true)
        socket.push(Packet.readings(Fixture.switches(["lights"])))
        await change.value

        #expect(store.confirmedChanges == 1)
        #expect(store.errorMessage == nil)
        #expect(store.pendingState(.lights) == nil)
        #expect(server.requests.filter { $0 == "GET status" }.count == polled, "no polling needed")
    }

    @Test("applies no events until the server welcomes it")
    func notBeforeJoining() async throws {
        let server = Self.server()
        let transport = FakeLiveTransport()
        let waits = Shared([Duration]())
        let store = server.makeStore(live: transport, sleep: Self.sleep(recording: waits))
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }

        try await until("the live updates are opened") { transport.sockets.count == 1 }
        try await until("the first poll is in") { store.reading(named: .lights) != nil }
        let socket = transport.sockets[0]
        socket.push(Packet.open)
        socket.push(Packet.readings(Fixture.switches(["lights"])))
        socket.push(Packet.welcome)
        try await until("it joins") { store.isLive }
        let lights = try #require(EquipmentControl.control(named: .lights))
        #expect(!store.isOn(lights), "the early push isn't applied")
    }

    @Test("reconnects when the server closes or leaves", arguments: ["1", "41"])
    func serverLeaves(_ packet: String) async throws {
        let server = Self.server()
        let transport = FakeLiveTransport()
        let store = server.makeStore(live: transport, sleep: Self.sleep(recording: Shared([])))
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }

        try await until("the live updates are opened") { transport.sockets.count == 1 }
        transport.sockets[0].push(Packet.open)
        transport.sockets[0].push(Packet.welcome)
        try await until("it joins") { store.isLive }
        transport.sockets[0].push(packet)
        try await until("it hangs up") { transport.sockets[0].closed && !store.isLive }
        try await until("and tries again") { transport.sockets.count == 2 }
    }

    @Test("waits longer after each failed try, up to a limit")
    func backoff() async throws {
        let server = Self.server()
        let transport = FakeLiveTransport()
        let retries = Shared([Duration]())
        let polls: Set<Duration> = [.seconds(StatusStore.refreshSeconds), .seconds(StatusStore.liveRefreshSeconds)]
        // polls wait; retries are only recorded
        let store = server.makeStore(live: transport, sleep: { duration in
            if polls.contains(duration) {
                try await Task.sleep(for: .seconds(3600))
            }
            retries.modify { $0.append(duration) }
            try Task.checkCancellation()
        })
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }

        for count in 1...8 {
            try await until("try \(count)") { transport.sockets.count == count }
            transport.sockets[count - 1].hangUp()
        }
        try await until("the ninth try") { transport.sockets.count == 9 }
        #expect(retries.value == [1, 2, 4, 8, 16, 30, 30, 30].map { Duration.seconds($0) })
    }

    @Test("closes the live updates when polling stops")
    func stops() async throws {
        let server = Self.server()
        let transport = FakeLiveTransport()
        let store = server.makeStore(live: transport, sleep: Self.sleep(recording: Shared([])))
        let polling = Task { await store.poll(reconnectSeconds: 30) }

        try await until("the live updates are opened") { transport.sockets.count == 1 }
        transport.sockets[0].push(Packet.open)
        transport.sockets[0].push(Packet.welcome)
        try await until("it joins") { store.isLive }
        polling.cancel()
        await polling.value
        #expect(transport.sockets[0].closed)
        #expect(!store.isLive)
        #expect(transport.sockets.count == 1, "it doesn't try again")
    }

    @Test("still asks the server when the push confirming a change doesn't come")
    func confirmsWithoutPush() async throws {
        let lightsOn = Shared(false)
        let server = StubServer { method, path, _ in
            switch (method, path) {
            case ("POST", "users/login"): return .ok(Fixture.login("operator"))
            case ("PUT", "devices/lights/true"):
                lightsOn.value = true
                return .ok("{}")
            case ("GET", "status"):
                return .ok(Fixture.status(Fixture.switches(lightsOn.value ? ["lights"] : [], off: lightsOn.value ? [] : ["lights"])))
            default: return .status(404)
            }
        }
        let transport = FakeLiveTransport()
        // polls wait; waiting for a push doesn't, as if it never came
        let store = server.makeStore(live: transport, sleep: { duration in
            if duration >= .seconds(StatusStore.refreshSeconds) {
                try await Task.sleep(for: .seconds(3600))
            }
            try Task.checkCancellation()
        })
        try await store.auth.signIn(name: "operator", password: "operator-password")
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }

        try await until("the live updates are opened") { transport.sockets.count == 1 }
        transport.sockets[0].push(Packet.open)
        transport.sockets[0].push(Packet.welcome)
        try await until("it joins") { store.isLive }
        let polled = server.requests.filter { $0 == "GET status" }.count

        let lights = try #require(EquipmentControl.control(named: .lights))
        await store.setControl(lights, on: true)
        #expect(store.confirmedChanges == 1)
        #expect(store.errorMessage == nil)
        #expect(server.requests.filter { $0 == "GET status" }.count > polled, "it asked")
    }

    @Test("a push replaces what a refresh that asked before it brings back")
    func pushWins() async throws {
        let held = Shared(false)
        let status = Fixture.status(Fixture.switches([], off: ["lights"]))
        let server = StubServer { _, path, _ in
            while held.value {
                usleep(1000)
            }
            return path == "status" ? .ok(status) : .status(404)
        }
        let store = server.makeStore()
        await store.refresh()
        let lights = try #require(EquipmentControl.control(named: .lights))
        #expect(!store.isOn(lights))

        held.value = true
        let refreshing = Task { await store.refresh() }
        try await until("the refresh asks") { store.isLoading }
        let payload = Data(#"{"readings":\#(Fixture.status(Fixture.switches(["lights"])))}"#.utf8)
        store.apply(try #require(LiveUpdate(name: "readings", payload: payload)))
        held.value = false
        await refreshing.value
        #expect(store.isOn(lights), "the refresh's older answer is dropped")
        #expect(store.connection == .connected)
    }

    /// Against a real pool server, such as `POOL_LIVE_SERVER=localhost:3000 swift test`.
    @Test("joins a real server's live updates over URLSession",
          .enabled(if: ProcessInfo.processInfo.environment["POOL_LIVE_SERVER"] != nil))
    func realServer() async throws {
        let address = try #require(ProcessInfo.processInfo.environment["POOL_LIVE_SERVER"])
        let store = StatusStore(serverAddress: address, defaults: UserDefaults(suiteName: "PoolStatusTests")!,
                                credentials: InMemoryCredentialStore(), live: URLSessionLiveTransport())
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        defer { polling.cancel() }
        for _ in 0..<200 where !store.isLive {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(store.isLive)
        #expect(store.isConnected)
    }

    @Test("without live updates, polls as before")
    func withoutLive() async throws {
        let server = Self.server()
        let waits = Shared([Duration]())
        let store = server.makeStore(sleep: Self.sleep(recording: waits))
        let polling = Task { await store.poll(reconnectSeconds: 30) }
        try await until("it polls") { waits.value == [.seconds(StatusStore.refreshSeconds)] }
        #expect(!store.isLive)
        polling.cancel()
        await polling.value
    }
}
