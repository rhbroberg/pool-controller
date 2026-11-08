import Foundation
import Observation

/// Why a request that needs a signed-in account didn't go ahead.
nonisolated enum AuthError: LocalizedError, Equatable {
    case signedOut(AuthSession.Action)
    /// The server no longer accepts the token, so the app has signed out.
    case expired(AuthSession.Action)
    /// The account's role doesn't allow it; an admin may have changed it.
    case forbidden(AuthSession.Action)

    var errorDescription: String? {
        switch self {
        case .signedOut(let action): "Sign in to \(action.phrase)."
        case .expired(let action): "Your sign-in is no longer valid. Sign in again to \(action.phrase)."
        case .forbidden(let action): "Your account can’t \(action.phrase)."
        }
    }
}

/// The signed-in account: signing in and out, the first-run rename of the default admin, and
/// every request that needs the account's token.
@Observable
final class AuthSession {
    /// What a signed-in request is for, as said in its error messages.
    nonisolated enum Action: Sendable {
        case changeEquipment, changeWaterFlow, changeSetpoints, usePanelKeys, manageAccounts, maintainServer

        var phrase: String {
            switch self {
            case .changeEquipment: "change equipment"
            case .changeWaterFlow: "change the water flow"
            case .changeSetpoints: "change setpoints"
            case .usePanelKeys: "use the panel keys"
            case .manageAccounts: "manage accounts"
            case .maintainServer: "restart or reset the server"
            }
        }
    }

    private(set) var credentials: Credentials?
    /// The default admin account, signed in but not yet renamed. Its token only works for
    /// commissioning, so it isn't saved.
    private(set) var commissioning: Credentials?
    /// The client for the current server; the status store replaces it when the address changes.
    @ObservationIgnored var client: StatusClient
    @ObservationIgnored private let store: CredentialStore
    /// Whether the saved account's role has been checked with the server since launch.
    @ObservationIgnored private var accountChecked = false

    init(client: StatusClient, store: CredentialStore) {
        self.client = client
        self.store = store
        credentials = store.load()
    }

    var role: AccountRole? { credentials?.role }
    /// Signed in with a role that may change equipment and press panel keys.
    var canControl: Bool { role?.canControl ?? false }
    var isAdmin: Bool { role?.isAdmin ?? false }
    /// Signed in, but the account's current role hasn't been asked for since launch.
    var needsAccountCheck: Bool { credentials != nil && !accountChecked }

    /// Runs `request` with the signed-in token. A rejected token signs out; a refused request
    /// rechecks the account's role, which an admin may have changed.
    func authorized<Result>(_ action: Action,
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

    func signIn(name: String, password: String) async throws {
        let result = try await client.signIn(name: name, password: password)
        let signedIn = Credentials(name: result.name, token: result.token, role: result.role)
        if result.mustChangeCredentials == true {
            commissioning = signedIn
            return
        }
        save(signedIn)
    }

    /// Renames the default admin account and sets its password, then signs in as the new account.
    func commission(name: String, password: String) async throws {
        guard let commissioning else {
            return
        }
        let result = try await client.changeCredentials(name: name, password: password, token: commissioning.token)
        save(Credentials(name: result.name, token: result.token, role: result.role))
        self.commissioning = nil
    }

    func cancelCommissioning() {
        commissioning = nil
    }

    /// Sets a new password for the signed-in account once `current` proves who is asking. The
    /// server signs the account out everywhere else, so this keeps the new token it returns.
    func changePassword(current: String, new password: String) async throws {
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
        save(Credentials(name: result.name, token: result.token, role: result.role ?? credentials.role))
    }

    /// Asks the server for the signed-in account's current role, which an admin may have changed.
    func refreshAccount() async {
        guard let credentials else {
            return
        }
        do {
            let account = try await client.fetchAccount(token: credentials.token)
            save(Credentials(name: account.name, token: credentials.token, role: account.role))
        } catch StatusClientError.unauthorized {
            forget()
        } catch {
            return
        }
    }

    /// Ends the session on the server and forgets it here.
    func signOut() {
        if let token = credentials?.token {
            let client = client
            Task { try? await client.signOut(token: token) }
        }
        forget()
    }

    /// Forgets the sign-in without telling the server, which has already ended it.
    func forget() {
        store.delete()
        credentials = nil
        accountChecked = false
    }

    private func save(_ signedIn: Credentials) {
        store.save(signedIn)
        credentials = signedIn
        accountChecked = signedIn.role != nil
    }

    // MARK: Accounts (admin)

    func listAccounts() async throws -> [AccountInfo] {
        try await authorized(.manageAccounts) { client, token in
            try await client.listAccounts(token: token)
        }
    }

    func createAccount(name: String, password: String, role: AccountRole) async throws -> AccountInfo {
        try await authorized(.manageAccounts) { client, token in
            try await client.createAccount(name: name, password: password, role: role, token: token)
        }
    }

    /// Changes an account's role, resets its password, or both; picks up a change to this
    /// account's own role.
    func updateAccount(_ name: String, role: AccountRole? = nil, password: String? = nil) async throws -> AccountInfo {
        let updated = try await authorized(.manageAccounts) { client, token in
            try await client.updateAccount(name, role: role, password: password, token: token)
        }
        if name == credentials?.name {
            await refreshAccount()
        }
        return updated
    }

    func deleteAccount(_ name: String) async throws {
        try await authorized(.manageAccounts) { client, token in
            try await client.deleteAccount(name, token: token)
        }
    }
}
