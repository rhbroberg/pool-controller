import Foundation
import Testing
@testable import PoolStatus

@Suite("Networks and addresses")
struct NetworkAndAddressTests {
    @Test("parses a network and lists its usable addresses")
    func parsesNetwork() throws {
        let network = try #require(IPv4Network("192.168.1.77/24"))
        #expect(network.description == "192.168.1.0/24")
        #expect(network.hostCount == 254)
        #expect(network.hosts.first == "192.168.1.1")
        #expect(network.hosts.last == "192.168.1.254")
    }

    @Test("keeps both addresses of /31 and /32 networks")
    func smallNetworks() throws {
        #expect(try #require(IPv4Network("10.0.0.4/31")).hosts == ["10.0.0.4", "10.0.0.5"])
        #expect(try #require(IPv4Network("10.0.0.4/32")).hosts == ["10.0.0.4"])
    }

    @Test("rejects malformed networks", arguments: ["192.168.1.0", "300.1.1.1/24", "1.2.3/24", "1.2.3.4/33", "", "a.b.c.d/8"])
    func rejectsMalformed(_ text: String) {
        #expect(IPv4Network(text) == nil)
    }

    @Test("parses and formats addresses")
    func addresses() {
        #expect(IPv4Network.parse("10.1.2.3") == 0x0A01_0203)
        #expect(IPv4Network.format(0xC0A8_0114) == "192.168.1.20")
        #expect(IPv4Network.parse("10.1.2") == nil)
    }

    @Test("picks the Wi-Fi or wired network, narrowed when it's too large to scan")
    func deviceNetwork() throws {
        func interface(_ name: String, _ address: String, _ prefix: Int) throws -> IPv4Network.Interface {
            IPv4Network.Interface(name: name, address: try #require(IPv4Network.parse(address)), prefix: prefix)
        }
        let chosen = IPv4Network.choose(from: [
            try interface("pdp_ip0", "10.20.30.40", 30),
            try interface("en1", "192.168.2.5", 24),
            try interface("en0", "172.16.5.9", 16)
        ])
        #expect(chosen?.description == "172.16.5.0/24", "en0 first, and a /16 is too large to scan")
        #expect(IPv4Network.choose(from: [try interface("en0", "169.254.1.1", 16)]) == nil, "no address assigned")
        #expect(IPv4Network.choose(from: [try interface("utun0", "10.8.0.2", 24)]) == nil, "a VPN doesn't reach the pool")
    }

    @Test("shows addresses without scheme or trailing slash", arguments: [
        ("http://192.168.1.20:3000/", "192.168.1.20:3000"),
        ("https://pool.example.com", "pool.example.com"),
        ("  192.168.1.20:3000  ", "192.168.1.20:3000")
    ])
    func displaysAddress(_ input: String, _ expected: String) {
        #expect(ServerAddress.display(input) == expected)
    }

    @Test("builds API URLs from whatever the user typed")
    func buildsURLs() throws {
        let typed = try StatusClient(serverAddress: "192.168.1.20:3000/").url(for: "status")
        #expect(typed.absoluteString == "http://192.168.1.20:3000/rhbroberg/pool-api/1.0.0/status")
        let secure = try StatusClient(serverAddress: "https://pool.example.com").url(for: "heating")
        #expect(secure.absoluteString == "https://pool.example.com/rhbroberg/pool-api/1.0.0/heating")
        let remote = try StatusClient(serverAddress: "pool.example.com").url(for: "status")
        #expect(remote.scheme == "https", "plain http only reaches the local network")
        #expect(try StatusClient(serverAddress: "poolserver.local:3000").url(for: "status").scheme == "http")
        #expect(try StatusClient(serverAddress: "localhost:3000").url(for: "status").scheme == "http")
        #expect(throws: StatusClientError.self) { try StatusClient(serverAddress: "").url(for: "status") }
    }
}

@Suite("Readings and names")
struct ReadingTests {
    private func decode(_ json: String) throws -> [StatusReading] {
        try StatusClient.decoder.decode([StatusReading].self, from: Data(json.utf8))
    }

    @Test("formats temperatures, salt and switches")
    func formats() throws {
        let readings = try decode(Fixture.status([("pool temp", "info", 81), ("salt", "info", 3100), ("filter", "status", 1)]))
        #expect(readings[0].formattedValue == "81°F")
        #expect(readings[1].formattedValue == "3100 ppm")
        #expect(readings[2].isOn)
        #expect(ReadingName.poolTemperature.format(nil) == "--°F")
        #expect(ReadingName.salt.format(nil) == "-- ppm")
    }

    @Test("words a pending change to suit the control")
    func pendingText() throws {
        #expect(try #require(EquipmentControl.control(named: .lights)).pendingText(true) == "Turning On…")
        #expect(try #require(EquipmentControl.control(named: .heater)).pendingText(false) == "To Manual Off…")
    }

    @Test("names controller outputs the way the panel does", arguments: [
        ("aux14", "Spa Filter"), ("aux3", "Yard Lights"), ("aux5", "Blower"), ("valve4", "Heat Pump"),
        ("heater1", "Heater"), ("ambient", "Air"), ("lights", "Lights")
    ])
    func names(_ name: String, _ title: String) {
        #expect(ReadingName(name).displayName == title)
    }

    @Test("maps server event types onto the log's filters")
    func eventKinds() {
        #expect(EventKind(serverType: "status") == .equipment)
        #expect(EventKind(serverType: "action") == .actions)
        #expect(EventKind(serverType: "failed") == .protocolErrors)
        #expect(EventKind(serverType: "something new") == nil)
        #expect(EventUserFilter.controller.query == "controller")
        #expect(EventUserFilter.everyone.query == nil)
    }

    @Test("decodes values this app doesn't know yet instead of failing")
    func unknownValues() throws {
        let readings = try decode(Fixture.status([("pool temp", "info", 81), ("pressure", "gauge", 12)]))
        #expect(readings.map(\.category) == [.info, .other])

        let account = try JSONDecoder().decode(AccountInfo.self, from: Data(#"{"email":"guest","role":"auditor"}"#.utf8))
        #expect(account.name == "guest")
        #expect(account.role == .viewer, "an unknown role gets the least access")
    }

    @Test("decodes the heating status, with no target while no pump runs")
    func heating() throws {
        let heating = try StatusClient.decoder.decode(HeatingStatus.self, from: Data(Fixture.heating(target: nil).utf8))
        #expect(heating.target == nil)
        #expect(heating.range == 65...104)
        #expect(heating.setpoint(.heatpump, for: .spa) == 100)
        #expect(heating.device(.heater1)?.body == nil)
        #expect(HeatingDevice(controlName: .heatPump) == .heatpump)
        #expect(HeatingDevice(controlName: .filter) == nil)
    }
}

@Suite("Keychain")
struct KeychainTests {
    @Test("saves, replaces and deletes the sign-in")
    func roundTrip() {
        let keychain = KeychainCredentialStore(service: "com.rhbroberg.PoolStatus.tests.\(UUID().uuidString)")
        defer { keychain.delete() }
        #expect(keychain.load() == nil)

        keychain.save(Credentials(name: "admin", token: "first", role: .admin))
        #expect(keychain.load() == Credentials(name: "admin", token: "first", role: .admin))

        keychain.save(Credentials(name: "owner", token: "second", role: nil))
        #expect(keychain.load() == Credentials(name: "owner", token: "second", role: nil), "renaming replaces the item")

        keychain.delete()
        #expect(keychain.load() == nil)
    }
}
