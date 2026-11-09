import Foundation

/// What the sign-in form offers: a name and password, and/or OpenID Connect services.
public nonisolated struct SignInChoices: Decodable, Sendable, Equatable {
    public let passwordSignIn: Bool
    public let providers: [SignInProvider]

    public static let passwordOnly = SignInChoices(passwordSignIn: true, providers: [])

    public init(passwordSignIn: Bool, providers: [SignInProvider]) {
        self.passwordSignIn = passwordSignIn
        self.providers = providers
    }
}

/// A service such as Google or Apple, as the sign-in form shows it.
public nonisolated struct SignInProvider: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

/// What the server said when the sign-in session came back to `poolstatus://signin`.
public nonisolated enum SignInOutcome: Equatable, Sendable {
    /// Trade it for a token.
    case ticket(String)
    /// The person has no account yet; an admin has been asked to approve them.
    case pending(provider: String)
    case denied(provider: String)
    /// The server only lets in invited people.
    case refused
    case cancelled
    /// The service was added to the signed-in account.
    case linked(provider: String)
    case failed(String)

    public static let callbackScheme = "poolstatus"

    public init(callback url: URL) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        let provider = value("provider") ?? String(localized: "the service", bundle: .module)
        if let ticket = value("ticket") {
            self = .ticket(ticket)
            return
        }
        switch value("status") {
        case "pending": self = .pending(provider: provider)
        case "denied": self = .denied(provider: provider)
        case "refused": self = .refused
        case "cancelled": self = .cancelled
        case "linked": self = .linked(provider: provider)
        default: self = .failed(value("error") ?? String(localized: "The sign-in didn’t complete. Try again.", bundle: .module))
        }
    }

    /// What to tell the person, for every outcome but a ticket.
    public var message: String? {
        switch self {
        case .ticket: nil
        case .pending(let provider):
            String(localized: "Your request to sign in with \(provider) was sent to the pool’s admin. Sign in again once they’ve approved it.", bundle: .module)
        case .denied(let provider):
            String(localized: "This \(provider) account isn’t allowed to sign in here.", bundle: .module)
        case .refused:
            String(localized: "This pool only lets in people an admin has invited. Ask an admin to invite your email address, then sign in again.", bundle: .module)
        case .cancelled:
            String(localized: "You didn’t finish signing in.", bundle: .module)
        case .linked(let provider):
            String(localized: "You can sign in with \(provider) from now on.", bundle: .module)
        case .failed(let message):
            message
        }
    }

    /// Whether the message reports a problem rather than news.
    public var isFailure: Bool {
        switch self {
        case .denied, .refused, .failed: true
        default: false
        }
    }
}

/// Someone who signed in with a service but has no account.
public nonisolated struct AccessRequest: Decodable, Sendable, Identifiable, Hashable {
    public enum Status: String, Decodable, Sendable {
        case pending, denied
    }

    public let id: String
    public let provider: String
    public let providerName: String
    public let email: String?
    public let name: String?
    public let status: Status
    public let firstSeen: Date
    public let lastSeen: Date
    public let attempts: Int

    /// The name to show, falling back to the email address.
    public var title: String { name ?? email ?? String(localized: "Someone", bundle: .module) }
}

/// An email address an admin let in ahead of time, with its role.
public nonisolated struct Invitation: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let email: String
    /// nil for any service trusted for email addresses.
    public let provider: String?
    public let providerName: String?
    public let role: AccountRole
    public let createdBy: String
}

/// How people sign in, as an admin sees it.
public nonisolated struct SignInSettings: Decodable, Sendable, Equatable {
    public enum Newcomers: String, Codable, Sendable, CaseIterable, Identifiable {
        case ask, refuse
        public var id: String { rawValue }
    }

    public let passwordSignIn: Bool
    /// POOL_FORCE_PASSWORD_SIGNIN=1 keeps passwords working whatever `passwordSignIn` says.
    public let passwordSignInForced: Bool
    public let signInRequests: Newcomers
    /// The callback address with `{id}` where a service's id goes.
    public let redirectUriTemplate: String
    public let providers: [SignInService]

    public nonisolated struct Changes: Encodable, Sendable {
        public var passwordSignIn: Bool?
        public var signInRequests: Newcomers?

        public init(passwordSignIn: Bool? = nil, signInRequests: Newcomers? = nil) {
            self.passwordSignIn = passwordSignIn
            self.signInRequests = signInRequests
        }
    }
}

/// An OpenID Connect service, without its secrets.
public nonisolated struct SignInService: Decodable, Sendable, Identifiable, Hashable {
    public enum Kind: String, Codable, Sendable {
        case oidc, apple
    }

    public nonisolated struct AppleKey: Decodable, Sendable, Hashable {
        public let teamId: String
        public let keyId: String
        public let hasPrivateKey: Bool
    }

    public let id: String
    public let displayName: String
    public let kind: Kind
    public let issuer: String
    public let clientId: String
    public let hasClientSecret: Bool
    public let apple: AppleKey?
    public let enabled: Bool
    public let trustEmail: Bool
    public let redirectUri: String
}

/// A new service, or the fields of one being changed; nil fields are left alone, and an empty
/// secret keeps the one saved.
public nonisolated struct SignInServiceChange: Encodable, Sendable {
    public nonisolated struct AppleKey: Encodable, Sendable {
        public var teamId: String?
        public var keyId: String?
        public var privateKey: String?

        public init(teamId: String? = nil, keyId: String? = nil, privateKey: String? = nil) {
            self.teamId = teamId
            self.keyId = keyId
            self.privateKey = privateKey
        }
    }

    public var id: String?
    public var displayName: String?
    public var kind: SignInService.Kind?
    public var issuer: String?
    public var clientId: String?
    public var clientSecret: String?
    public var apple: AppleKey?
    public var enabled: Bool?
    public var trustEmail: Bool?

    public init(id: String? = nil, displayName: String? = nil, kind: SignInService.Kind? = nil, issuer: String? = nil,
                clientId: String? = nil, clientSecret: String? = nil, apple: AppleKey? = nil,
                enabled: Bool? = nil, trustEmail: Bool? = nil) {
        self.id = id
        self.displayName = displayName
        self.kind = kind
        self.issuer = issuer
        self.clientId = clientId
        self.clientSecret = clientSecret
        self.apple = apple
        self.enabled = enabled
        self.trustEmail = trustEmail
    }
}

/// Ready-made settings for common services.
public nonisolated struct SignInServicePreset: Sendable, Hashable, Identifiable {
    public let id: String
    public let displayName: String
    public let kind: SignInService.Kind
    public let issuer: String
    /// Whether the service's verified addresses may redeem invitations.
    public let trustEmail: Bool

    public static let all = [
        SignInServicePreset(id: "google", displayName: "Google", kind: .oidc, issuer: "https://accounts.google.com", trustEmail: true),
        SignInServicePreset(id: "microsoft", displayName: "Microsoft", kind: .oidc,
                            issuer: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0", trustEmail: false),
        SignInServicePreset(id: "apple", displayName: "Apple", kind: .apple, issuer: "https://appleid.apple.com", trustEmail: true),
        SignInServicePreset(id: "", displayName: "", kind: .oidc, issuer: "", trustEmail: false)
    ]

    public var isOther: Bool { id.isEmpty }
}

public enum SignInServicesError: LocalizedError, Equatable {
    /// The server predates sign-in services.
    case unsupported

    public var errorDescription: String? {
        String(localized: "This server doesn’t have sign-in services yet. Update it to offer Google, Microsoft or Apple sign-in.", bundle: .module)
    }
}

/// The names of the ways an account signs in, with services' ids replaced by their names.
public func signInMethodNames(_ methods: [String]?, services: [SignInProvider]) -> [String] {
    (methods ?? []).map { method in
        if method == "password" {
            return String(localized: "Password", bundle: .module)
        }
        return services.first { $0.id == method }?.displayName ?? method
    }
}
