import Foundation

/// What the iPhone app tells the watch app: the server, the pool's name and the sign-in, so
/// nothing has to be typed on the watch. Sent as a WatchConnectivity application context, which
/// holds only property-list values.
public nonisolated struct WatchContext: Equatable, Sendable {
    /// Empty until the iPhone app has found a server.
    public var serverAddress: String
    public var poolName: String
    /// Nil while the iPhone app is signed out, so the watch only shows status.
    public var credentials: Credentials?

    public init(serverAddress: String, poolName: String, credentials: Credentials?) {
        self.serverAddress = serverAddress
        self.poolName = poolName
        self.credentials = credentials
    }

    /// The key of the message the watch app sends to ask the iPhone app for the context, as when
    /// it was installed after the iPhone app last sent one.
    public static let requestKey = "requestContext"

    private enum Key {
        static let serverAddress = "serverAddress"
        static let poolName = "poolName"
        static let accountName = "accountName"
        static let token = "token"
        static let role = "role"
    }

    /// Nil for a context without a server address, as from before the iPhone sent one.
    public init?(_ dictionary: [String: Any]) {
        guard let serverAddress = dictionary[Key.serverAddress] as? String else {
            return nil
        }
        self.serverAddress = serverAddress
        poolName = dictionary[Key.poolName] as? String ?? ""
        if let token = dictionary[Key.token] as? String {
            credentials = Credentials(name: dictionary[Key.accountName] as? String ?? "",
                                      token: token,
                                      role: (dictionary[Key.role] as? String).map { AccountRole(rawValue: $0) ?? .viewer })
        } else {
            credentials = nil
        }
    }

    public var dictionary: [String: Any] {
        var dictionary: [String: Any] = [Key.serverAddress: serverAddress, Key.poolName: poolName]
        if let credentials {
            dictionary[Key.accountName] = credentials.name
            dictionary[Key.token] = credentials.token
            if let role = credentials.role {
                dictionary[Key.role] = role.rawValue
            }
        }
        return dictionary
    }
}
