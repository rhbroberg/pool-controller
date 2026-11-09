import Foundation
import Observation

/// Why a request that needs a signed-in account didn't go ahead.
public nonisolated enum AuthError: LocalizedError, Equatable {
    case signedOut(AuthSession.Action)
    /// The server no longer accepts the token, so the app has signed out.
    case expired(AuthSession.Action)
    /// The account's role doesn't allow it; an admin may have changed it.
    case forbidden(AuthSession.Action)

    public var errorDescription: String? {
        switch self {
        case .signedOut(let action): action.signedOutMessage
        case .expired(let action): action.expiredMessage
        case .forbidden(let action): action.forbiddenMessage
        }
    }
}

/// The signed-in account: signing in and out, the first-run rename of the default admin, and
/// every request that needs the account's token.
@Observable
public final class AuthSession {
    /// What a signed-in request is for, which its error messages name. Each message is a whole
    /// sentence so it can be translated as one.
    public nonisolated enum Action: Sendable {
        case changeEquipment, changeWaterFlow, changeSetpoints, usePanelKeys, manageAccounts, maintainServer, configureServer

        public var signedOutMessage: String {
            switch self {
            case .changeEquipment: String(localized: "Sign in to change equipment.", bundle: .module)
            case .changeWaterFlow: String(localized: "Sign in to change the water flow.", bundle: .module)
            case .changeSetpoints: String(localized: "Sign in to change setpoints.", bundle: .module)
            case .usePanelKeys: String(localized: "Sign in to use the panel keys.", bundle: .module)
            case .manageAccounts: String(localized: "Sign in to manage accounts.", bundle: .module)
            case .maintainServer: String(localized: "Sign in to restart or reset the server.", bundle: .module)
            case .configureServer: String(localized: "Sign in to change the server’s settings.", bundle: .module)
            }
        }

        public var expiredMessage: String {
            switch self {
            case .changeEquipment: String(localized: "Your sign-in is no longer valid. Sign in again to change equipment.", bundle: .module)
            case .changeWaterFlow: String(localized: "Your sign-in is no longer valid. Sign in again to change the water flow.", bundle: .module)
            case .changeSetpoints: String(localized: "Your sign-in is no longer valid. Sign in again to change setpoints.", bundle: .module)
            case .usePanelKeys: String(localized: "Your sign-in is no longer valid. Sign in again to use the panel keys.", bundle: .module)
            case .manageAccounts: String(localized: "Your sign-in is no longer valid. Sign in again to manage accounts.", bundle: .module)
            case .maintainServer: String(localized: "Your sign-in is no longer valid. Sign in again to restart or reset the server.", bundle: .module)
            case .configureServer: String(localized: "Your sign-in is no longer valid. Sign in again to change the server’s settings.", bundle: .module)
            }
        }

        public var forbiddenMessage: String {
            switch self {
            case .changeEquipment: String(localized: "Your account can’t change equipment.", bundle: .module)
            case .changeWaterFlow: String(localized: "Your account can’t change the water flow.", bundle: .module)
            case .changeSetpoints: String(localized: "Your account can’t change setpoints.", bundle: .module)
            case .usePanelKeys: String(localized: "Your account can’t use the panel keys.", bundle: .module)
            case .manageAccounts: String(localized: "Your account can’t manage accounts.", bundle: .module)
            case .maintainServer: String(localized: "Your account can’t restart or reset the server.", bundle: .module)
            case .configureServer: String(localized: "Your account can’t change the server’s settings.", bundle: .module)
            }
        }
    }

    public private(set) var credentials: Credentials?
    /// The default admin account, signed in but not yet renamed. Its token only works for
    /// commissioning, so it isn't saved.
    public private(set) var commissioning: Credentials?
    /// How the signed-in account signs in: password and/or services' ids; nil until the server
    /// has said since launch.
    public private(set) var methods: [String]?
    /// The client for the current server; the status store replaces it when the address changes.
    @ObservationIgnored public var client: StatusClient
    @ObservationIgnored private let store: CredentialStore
    /// Whether the saved account's role has been checked with the server since launch.
    @ObservationIgnored private var accountChecked = false

    public init(client: StatusClient, store: CredentialStore) {
        self.client = client
        self.store = store
        credentials = store.load()
    }

    public var role: AccountRole? { credentials?.role }
    /// Signed in with a role that may change equipment and press panel keys.
    public var canControl: Bool { role?.canControl ?? false }
    public var isAdmin: Bool { role?.isAdmin ?? false }
    /// Whether the account has a password to change; true until the server has said.
    public var hasPassword: Bool { methods?.contains("password") ?? true }
    /// Signed in, but the account's current role hasn't been asked for since launch.
    public var needsAccountCheck: Bool { credentials != nil && !accountChecked }

    /// Runs `request` with the signed-in token. A rejected token signs out; a refused request
    /// rechecks the account's role, which an admin may have changed.
    public func authorized<Result>(_ action: Action,
                            _ request: (StatusClient, String) async throws -> Result) async throws -> Result {
        guard let credentials else {
            throw AuthError.signedOut(action)
        }
        do {
            return try await request(client, credentials.token)
        } catch StatusClientError.unauthorized {
            forget()
            throw AuthError.expired(action)
        } catch StatusClientError.server(code: 403, message: _) {
            await refreshAccount()
            throw AuthError.forbidden(action)
        }
    }

    // MARK: Signing in

    public func signIn(name: String, password: String) async throws {
        let result = try await client.signIn(name: name, password: password)
        let signedIn = Credentials(name: result.name, token: result.token, role: result.role)
        if result.mustChangeCredentials == true {
            commissioning = signedIn
            return
        }
        save(signedIn, methods: result.methods)
    }

    /// What the sign-in form offers; nil from a server too old to have sign-in services, which
    /// offers only passwords.
    public func signInChoices() async -> SignInChoices? {
        try? await client.fetchSignInChoices()
    }

    /// Finishes a sign-in through a service with what it came back to `poolstatus://signin`
    /// with: signs in for a ticket, and otherwise says why not.
    public func completeSignIn(callback url: URL) async throws -> SignInOutcome {
        let outcome = SignInOutcome(callback: url)
        switch outcome {
        case .ticket(let ticket):
            let result = try await client.signIn(ticket: ticket)
            save(Credentials(name: result.name, token: result.token, role: result.role), methods: result.methods)
        case .linked:
            await refreshAccount()
        default:
            break
        }
        return outcome
    }

    /// Where to send a web authentication session to add `provider` to this account.
    public func linkURL(provider: String) async throws -> URL {
        try await authorized(.manageAccounts) { client, token in
            try await client.linkIdentityURL(provider: provider, token: token)
        }
    }

    /// Stops this account signing in with `provider`.
    public func unlink(provider: String) async throws {
        let account = try await authorized(.manageAccounts) { client, token in
            try await client.unlinkIdentity(provider: provider, token: token)
        }
        methods = account.methods
    }

    /// Renames the default admin account and sets its password, then signs in as the new account.
    public func commission(name: String, password: String) async throws {
        guard let commissioning else {
            return
        }
        let result = try await client.changeCredentials(name: name, password: password, token: commissioning.token)
        save(Credentials(name: result.name, token: result.token, role: result.role), methods: result.methods)
        self.commissioning = nil
    }

    public func cancelCommissioning() {
        commissioning = nil
    }

    /// Sets a new password for the signed-in account once `current` proves who is asking. The
    /// server signs the account out everywhere else, so this keeps the new token it returns.
    public func changePassword(current: String, new password: String) async throws {
        guard let credentials else {
            throw AuthError.signedOut(.manageAccounts)
        }
        let verified: SignInResult
        do {
            verified = try await client.signIn(name: credentials.name, password: current)
        } catch StatusClientError.unauthorized {
            throw PasswordChangeError.wrongCurrentPassword
        }
        let result = try await client.changeCredentials(name: credentials.name, password: password, token: verified.token)
        save(Credentials(name: result.name, token: result.token, role: result.role ?? credentials.role), methods: result.methods)
    }

    /// Asks the server for the signed-in account's current role, which an admin may have changed.
    public func refreshAccount() async {
        guard let credentials else {
            return
        }
        do {
            let account = try await client.fetchAccount(token: credentials.token)
            save(Credentials(name: account.name, token: credentials.token, role: account.role), methods: account.methods)
        } catch StatusClientError.unauthorized {
            forget()
        } catch {
            return
        }
    }

    /// Ends the session on the server and forgets it here.
    public func signOut() {
        if let token = credentials?.token {
            let client = client
            Task { try? await client.signOut(token: token) }
        }
        forget()
    }

    /// Forgets the sign-in without telling the server, which has already ended it.
    public func forget() {
        store.delete()
        credentials = nil
        methods = nil
        accountChecked = false
    }

    private func save(_ signedIn: Credentials, methods: [String]?) {
        store.save(signedIn)
        credentials = signedIn
        self.methods = methods
        accountChecked = signedIn.role != nil
    }

    // MARK: Accounts (admin)

    public func listAccounts() async throws -> [AccountInfo] {
        try await authorized(.manageAccounts) { client, token in
            try await client.listAccounts(token: token)
        }
    }

    public func createAccount(name: String, password: String, role: AccountRole) async throws -> AccountInfo {
        try await authorized(.manageAccounts) { client, token in
            try await client.createAccount(name: name, password: password, role: role, token: token)
        }
    }

    /// Changes an account's role, resets its password, or both; picks up a change to this
    /// account's own role.
    public func updateAccount(_ name: String, role: AccountRole? = nil, password: String? = nil) async throws -> AccountInfo {
        let updated = try await authorized(.manageAccounts) { client, token in
            try await client.updateAccount(name, role: role, password: password, token: token)
        }
        if name == credentials?.name {
            await refreshAccount()
        }
        return updated
    }

    public func deleteAccount(_ name: String) async throws {
        try await authorized(.manageAccounts) { client, token in
            try await client.deleteAccount(name, token: token)
        }
    }

    // MARK: Sign-in services (admin)

    public func listRequests() async throws -> [AccessRequest] {
        try await authorized(.manageAccounts) { client, token in
            try await client.listRequests(token: token)
        }
    }

    public func approveRequest(_ request: AccessRequest, role: AccountRole) async throws -> AccountInfo {
        try await authorized(.manageAccounts) { client, token in
            try await client.approveRequest(request.id, role: role, token: token)
        }
    }

    public func denyRequest(_ request: AccessRequest) async throws -> AccessRequest {
        try await authorized(.manageAccounts) { client, token in
            try await client.denyRequest(request.id, token: token)
        }
    }

    public func forgetRequest(_ request: AccessRequest) async throws {
        try await authorized(.manageAccounts) { client, token in
            try await client.forgetRequest(request.id, token: token)
        }
    }

    public func listInvitations() async throws -> [Invitation] {
        try await authorized(.manageAccounts) { client, token in
            try await client.listInvitations(token: token)
        }
    }

    public func invite(email: String, role: AccountRole, provider: String?) async throws -> Invitation {
        try await authorized(.manageAccounts) { client, token in
            try await client.createInvitation(email: email, role: role, provider: provider, token: token)
        }
    }

    public func withdraw(_ invitation: Invitation) async throws {
        try await authorized(.manageAccounts) { client, token in
            try await client.deleteInvitation(invitation.id, token: token)
        }
    }

    public func signInSettings() async throws -> SignInSettings {
        do {
            return try await authorized(.configureServer) { client, token in
                try await client.fetchSignInSettings(token: token)
            }
        } catch StatusClientError.server(code: 404, message: _) {
            throw SignInServicesError.unsupported
        }
    }

    public func updateSignInSettings(_ changes: SignInSettings.Changes) async throws -> SignInSettings {
        try await authorized(.configureServer) { client, token in
            try await client.updateSignInSettings(changes, token: token)
        }
    }

    public func createSignInService(_ service: SignInServiceChange) async throws -> SignInService {
        try await authorized(.configureServer) { client, token in
            try await client.createSignInService(service, token: token)
        }
    }

    public func updateSignInService(_ id: String, _ changes: SignInServiceChange) async throws -> SignInService {
        try await authorized(.configureServer) { client, token in
            try await client.updateSignInService(id, changes, token: token)
        }
    }

    public func deleteSignInService(_ id: String) async throws {
        try await authorized(.configureServer) { client, token in
            try await client.deleteSignInService(id, token: token)
        }
    }
}
