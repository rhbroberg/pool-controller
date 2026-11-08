import Foundation
import Observation

/// An IPv4 subnet written as an address and prefix, like 192.168.1.0/24.
nonisolated struct IPv4Network: Equatable, CustomStringConvertible {
    /// Larger subnets would take minutes to scan.
    static let maxHosts = 1024

    let network: UInt32
    let prefix: Int

    init(address: UInt32, prefix: Int) {
        self.prefix = prefix
        network = address & Self.mask(prefix)
    }

    init?(_ text: String) {
        let parts = text.trimmingCharacters(in: .whitespaces).split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let address = Self.parse(String(parts[0])),
              let prefix = Int(parts[1]), (0...32).contains(prefix) else {
            return nil
        }
        self.init(address: address, prefix: prefix)
    }

    var description: String { "\(Self.format(network))/\(prefix)" }

    var broadcast: UInt32 { network | ~Self.mask(prefix) }

    /// Addresses a server could have: all but the network and broadcast addresses.
    var hostCount: Int {
        prefix >= 31 ? 1 << (32 - prefix) : (1 << (32 - prefix)) - 2
    }

    var hosts: [String] {
        let range: ClosedRange<UInt32> = prefix >= 31 ? network...broadcast : (network + 1)...(broadcast - 1)
        return range.map(Self.format)
    }

    /// The subnet of this device's Wi-Fi or wired network, narrowed to the /24 around the device
    /// when it's too large to scan.
    static func device() -> IPv4Network? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else {
            return nil
        }
        defer { freeifaddrs(list) }

        var candidates: [(name: String, address: UInt32, prefix: Int)] = []
        for entry in sequence(first: first, next: { $0.pointee.ifa_next }).map(\.pointee) {
            let flags = Int32(bitPattern: entry.ifa_flags)
            guard let address = entry.ifa_addr, let netmask = entry.ifa_netmask,
                  address.pointee.sa_family == sa_family_t(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else {
                continue
            }
            let name = String(cString: entry.ifa_name)
            let ip = ipv4(address)
            // en* is Wi-Fi or Ethernet; cellular and VPN interfaces don't reach the pool server,
            // and 169.254 means the network never handed out an address
            guard name.hasPrefix("en"), ip >> 16 != 0xA9FE else {
                continue
            }
            candidates.append((name, ip, ipv4(netmask).nonzeroBitCount))
        }
        guard let chosen = candidates.first(where: { $0.name == "en0" }) ?? candidates.first else {
            return nil
        }
        let network = IPv4Network(address: chosen.address, prefix: chosen.prefix)
        return network.hostCount > maxHosts ? IPv4Network(address: chosen.address, prefix: 24) : network
    }

    static func parse(_ text: String) -> UInt32? {
        let octets = text.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
        guard octets.count == 4 else {
            return nil
        }
        return octets.reduce(0) { ($0 << 8) | UInt32($1) }
    }

    static func format(_ address: UInt32) -> String {
        [24, 16, 8, 0].map { String((address >> UInt32($0)) & 0xFF) }.joined(separator: ".")
    }

    private static func mask(_ prefix: Int) -> UInt32 {
        prefix == 0 ? 0 : UInt32.max << UInt32(32 - prefix)
    }

    private static func ipv4(_ pointer: UnsafeMutablePointer<sockaddr>) -> UInt32 {
        pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
        }
    }
}

struct FoundServer: Identifiable, Hashable {
    let host: String
    let port: Int
    let version: String
    let startedAt: Date

    var address: String { "\(host):\(port)" }
    var id: String { address }
}

/// Asks every address in a subnet for the server's identity and collects the pool servers.
@Observable
final class NetworkScanner {
    static let defaultPort = 3000
    static let defaultTimeoutSeconds = 1.5
    static let concurrency = 128

    private(set) var found: [FoundServer] = []
    private(set) var checked = 0
    private(set) var total = 0
    private(set) var port = defaultPort
    private(set) var isScanning = false
    private(set) var hasScanned = false
    private(set) var wasStopped = false

    private let session: URLSession
    private var task: Task<Void, Never>?
    /// Lets a stopped scan's last few answers arrive without counting toward it or the next scan.
    private var generation = 0

    init(session: URLSession = .shared) {
        self.session = session
    }

    func scan(_ network: IPv4Network, port: Int, timeout: TimeInterval) {
        stop()
        #if targetEnvironment(simulator)
        // the simulator shares the Mac's network, so a server running on the Mac answers here
        let hosts = ["localhost"] + network.hosts
        #else
        let hosts = network.hosts
        #endif
        generation += 1
        let scan = generation
        found = []
        checked = 0
        total = hosts.count
        self.port = port
        isScanning = true
        hasScanned = true
        wasStopped = false

        let clients = hosts.map { StatusClient(serverAddress: "\($0):\(port)", session: session) }
        task = Task {
            await withTaskGroup(of: FoundServer?.self) { group in
                var next = 0
                func probeNext() {
                    let host = hosts[next]
                    let client = clients[next]
                    next += 1
                    group.addTask { await Self.probe(client, host: host, port: port, timeout: timeout) }
                }
                while next < min(Self.concurrency, hosts.count) {
                    probeNext()
                }
                for await server in group {
                    guard scan == generation else {
                        continue
                    }
                    checked += 1
                    if let server {
                        found.append(server)
                        found.sort(by: Self.listOrder)
                    }
                    if next < hosts.count, !Task.isCancelled {
                        probeNext()
                    }
                }
            }
            if scan == generation {
                isScanning = false
            }
        }
    }

    func stop() {
        guard isScanning else {
            return
        }
        task?.cancel()
        task = nil
        generation += 1
        isScanning = false
        wasStopped = true
    }

    private static func probe(_ client: StatusClient, host: String, port: Int, timeout: TimeInterval) async -> FoundServer? {
        guard let info = try? await client.fetchSystemInfo(timeout: timeout),
              info.service == SystemInfo.poolService else {
            return nil
        }
        return FoundServer(host: host, port: port, version: info.version, startedAt: info.startedAt)
    }

    /// localhost first, then by address rather than alphabetically, so .9 comes before .10.
    private static func listOrder(_ a: FoundServer, _ b: FoundServer) -> Bool {
        let left = IPv4Network.parse(a.host) ?? 0
        let right = IPv4Network.parse(b.host) ?? 0
        return left == right ? a.host < b.host : left < right
    }
}
