import PoolStatusCore
import SwiftUI

/// Any signed-in account changing its own password.
struct ChangePasswordView: View {
    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                SecureField("Current Password", text: $current)
                    .textContentType(.password)
            }

            Section {
                SecureField("New Password", text: $password)
                    .textContentType(.newPassword)
                SecureField("Confirm Password", text: $confirmation)
                    .textContentType(.newPassword)
            } footer: {
                if let message = errorMessage ?? PasswordRules.problem(password, confirmation: confirmation) {
                    Text(message).foregroundStyle(.red)
                } else {
                    Text("Other devices signed in to this account will need to sign in again.")
                }
            }
        }
        .navigationTitle("Change Password")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Save") {
                        errorMessage = nil
                        isSaving = true
                    }
                    .disabled(current.isEmpty || !PasswordRules.acceptable(password, confirmation: confirmation))
                }
            }
        }
        .task(id: isSaving) {
            if isSaving {
                await save()
            }
        }
    }

    private func save() async {
        do {
            try await store.auth.changePassword(current: current, new: password)
            dismiss()
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        isSaving = false
    }
}

/// Admin: every account on the server, with ways to add, change and remove them.
struct AccountsView: View {
    @Environment(StatusStore.self) private var store
    @State private var accounts: [AccountInfo] = []
    @State private var requests: [AccessRequest] = []
    @State private var invitations: [Invitation] = []
    @State private var services: [SignInService] = []
    /// Whether the server has sign-in services, which a server from before them doesn't.
    @State private var offersSignInServices = false
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var addingAccount = false
    /// Asked about before it's removed.
    @State private var removing: AccountInfo?
    /// Being removed; leaving the page cancels it.
    @State private var deleting: AccountInfo?
    /// Asked about before it's denied.
    @State private var denying: AccessRequest?

    private var auth: AuthSession { store.auth }
    private var pending: [AccessRequest] { requests.filter { $0.status == .pending } }
    private var denied: [AccessRequest] { requests.filter { $0.status == .denied } }
    private var providers: [SignInProvider] { services.map { SignInProvider(id: $0.id, displayName: $0.displayName) } }

    var body: some View {
        List {
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            if offersSignInServices {
                Section {
                    NavigationLink("Sign-In Settings") { SignInSettingsView() }
                } footer: {
                    Text("Google, Microsoft, Apple and other services, whether newcomers may ask to join, and whether passwords still work.")
                }
            }
            if !pending.isEmpty {
                Section {
                    ForEach(pending) { request in
                        RequestRow(request: request) { role in
                            Task { await approve(request, as: role) }
                        } deny: {
                            denying = request
                        }
                    }
                } header: {
                    Text("Waiting for Approval (\(pending.count))")
                } footer: {
                    Text("These people signed in with a service but have no account. Approving one creates their account with the role chosen; they’re signed in the next time they sign in.")
                }
            }
            Section {
                ForEach(accounts) { account in
                    NavigationLink(value: account) {
                        AccountRow(account: account, isYou: account.name == auth.credentials?.name,
                                   methods: services.isEmpty ? nil : signInMethodNames(account.methods, services: providers))
                    }
                    .swipeActions {
                        if account.name != auth.credentials?.name {
                            Button("Remove", role: .destructive) {
                                removing = account
                            }
                        }
                    }
                }
            } header: {
                if !pending.isEmpty || !invitations.isEmpty {
                    Text("Accounts")
                }
            } footer: {
                Text("Swipe left on an account to remove it. Viewers can only look; operators can also change equipment, water flow and panel settings; admins can also manage accounts and the server.")
            }
            if !invitations.isEmpty {
                Section {
                    ForEach(invitations) { invitation in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(invitation.email)
                                Text("\(invitation.providerName ?? String(localized: "Any trusted service")) · invited by \(invitation.createdBy)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(invitation.role.title)
                                .foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button("Withdraw", role: .destructive) {
                                Task { await withdraw(invitation) }
                            }
                        }
                    }
                } header: {
                    Text("Invitations")
                } footer: {
                    Text("The first sign-in with one of these verified email addresses creates the account with the role shown. Swipe left to withdraw one.")
                }
            }
            if !denied.isEmpty {
                Section {
                    ForEach(denied) { request in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(request.title)
                            Text([request.name != nil ? request.email : nil, request.providerName].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button("Forget") {
                                Task { await forget(request) }
                            }
                        }
                    }
                } header: {
                    Text("Denied")
                } footer: {
                    Text("Turned away without asking again. Swipe left and Forget to let the person ask again.")
                }
            }
        }
        .overlay {
            if accounts.isEmpty && isLoading {
                ProgressView()
            }
        }
        .navigationTitle("Accounts")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: AccountInfo.self) { account in
            AccountDetailView(account: account, services: providers) { updated in
                if let index = accounts.firstIndex(where: { $0.name == updated.name }) {
                    accounts[index] = updated
                }
            }
        }
        .confirmationDialog("Deny \(denying?.title ?? "")?", isPresented: Binding(isPresent: $denying), titleVisibility: .visible) {
            Button("Deny", role: .destructive) {
                if let request = denying {
                    Task { await deny(request) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("They won’t be able to sign in with \(denying?.providerName ?? ""), and won’t be asked about again unless you forget the request.")
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add Account", systemImage: "plus") {
                    addingAccount = true
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: $addingAccount) {
            NewAccountView(trustedServices: services.filter(\.trustEmail)) { created in
                accounts.append(created)
                accounts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            } invited: { invitation in
                invitations.append(invitation)
                invitations.sort { $0.email < $1.email }
            }
        }
        .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: Binding(isPresent: $removing),
                            titleVisibility: .visible) {
            Button("Remove Account", role: .destructive) {
                deleting = removing
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The account is deleted and signed out everywhere.")
        }
        .task(id: deleting) {
            if let deleting {
                await remove(deleting)
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            // requests, invitations and services are extras an older server doesn't have
            async let waiting = try? auth.listRequests()
            async let invited = try? auth.listInvitations()
            async let signIn = try? auth.signInSettings()
            accounts = try await auth.listAccounts()
            requests = await waiting ?? []
            invitations = await invited ?? []
            let settings = await signIn
            services = settings?.providers ?? []
            offersSignInServices = settings != nil
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Runs an admin change, showing what went wrong.
    private func act(_ change: () async throws -> Void) async {
        do {
            try await change()
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func approve(_ request: AccessRequest, as role: AccountRole) async {
        await act {
            let created = try await auth.approveRequest(request, role: role)
            requests.removeAll { $0.id == request.id }
            accounts.append(created)
            accounts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
    }

    private func deny(_ request: AccessRequest) async {
        await act {
            let updated = try await auth.denyRequest(request)
            requests = requests.map { $0.id == request.id ? updated : $0 }
        }
    }

    private func forget(_ request: AccessRequest) async {
        await act {
            try await auth.forgetRequest(request)
            requests.removeAll { $0.id == request.id }
        }
    }

    private func withdraw(_ invitation: Invitation) async {
        await act {
            try await auth.withdraw(invitation)
            invitations.removeAll { $0.id == invitation.id }
        }
    }

    private func remove(_ account: AccountInfo) async {
        do {
            try await auth.deleteAccount(account.name)
            accounts.removeAll { $0.name == account.name }
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        deleting = nil
    }
}

/// Someone waiting to be let in: who they are, a menu of roles to approve them as, and Deny.
private struct RequestRow: View {
    let request: AccessRequest
    let approve: (AccountRole) -> Void
    let deny: () -> Void

    private var detail: String {
        var parts = [String]()
        if request.name != nil, let email = request.email {
            parts.append(email)
        }
        parts.append(request.providerName)
        parts.append(String(localized: "asked \(request.lastSeen, format: .relative(presentation: .named))"))
        if request.attempts > 1 {
            parts.append(String(localized: "\(request.attempts) times"))
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(request.title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Menu("Approve as…") {
                    ForEach(AccountRole.allCases) { role in
                        Button(role.title) { approve(role) }
                    }
                }
                .buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive, action: deny)
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }
}

private struct AccountRow: View {
    let account: AccountInfo
    let isYou: Bool
    /// How it signs in, when the server has sign-in services.
    var methods: [String]?

    private var note: String? {
        let parts = (isYou ? [String(localized: "You")] : []) + (methods ?? [])
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name)
                if account.mustChangeCredentials == true {
                    Text("Not set up yet")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } else if let note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(account.role.title)
                .foregroundStyle(.secondary)
        }
    }
}

/// Admin: change one account's role or reset its password.
private struct AccountDetailView: View {
    private enum Change: Equatable {
        case role(AccountRole)
        case password(String)
    }

    let account: AccountInfo
    let services: [SignInProvider]
    let updated: (AccountInfo) -> Void

    @Environment(StatusStore.self) private var store
    @State private var role: AccountRole
    @State private var password = ""
    @State private var confirmation = ""
    /// The change being saved; leaving the page cancels it.
    @State private var saving: Change?
    @State private var message: String?
    @State private var failed = false
    @State private var confirmingReset = false

    init(account: AccountInfo, services: [SignInProvider], updated: @escaping (AccountInfo) -> Void) {
        self.account = account
        self.services = services
        self.updated = updated
        _role = State(initialValue: account.role)
    }

    var body: some View {
        Form {
            if account.methods != nil && !services.isEmpty {
                Section {
                    LabeledContent("Signs In With",
                                   value: signInMethodNames(account.methods, services: services).joined(separator: ", "))
                }
            }
            Section {
                Picker("Role", selection: $role) {
                    ForEach(AccountRole.allCases) { role in
                        Text(role.title).tag(role)
                    }
                }
                Button("Save Role") {
                    start(.role(role))
                }
                .disabled(role == account.role || saving != nil)
            } footer: {
                Text(role.summary)
            }

            Section {
                SecureField("New Password", text: $password)
                    .textContentType(.newPassword)
                SecureField("Confirm Password", text: $confirmation)
                    .textContentType(.newPassword)
                Button("Reset Password") {
                    confirmingReset = true
                }
                .disabled(!PasswordRules.acceptable(password, confirmation: confirmation) || saving != nil)
            } header: {
                Text(account.hasPassword ? "Reset Password" : "Set a Password")
            } footer: {
                if let problem = PasswordRules.problem(password, confirmation: confirmation) {
                    Text(problem).foregroundStyle(.red)
                } else if account.hasPassword {
                    Text("\(account.name) is signed out everywhere and must sign in with the new password.")
                } else {
                    Text("\(account.name) signs in with a service. A password lets them sign in without it too.")
                }
            }

            if let message {
                Section {
                    Text(message)
                        .foregroundStyle(failed ? .red : .secondary)
                }
            }
        }
        .navigationTitle(account.name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Reset \(account.name)’s password?", isPresented: $confirmingReset,
                            titleVisibility: .visible) {
            Button("Reset Password", role: .destructive) {
                start(.password(password))
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(account.name) is signed out on every device and must sign in with the new password.")
        }
        .task(id: saving) {
            if let saving {
                await save(saving)
            }
        }
    }

    private func start(_ change: Change) {
        message = nil
        saving = change
    }

    private func save(_ change: Change) async {
        do {
            switch change {
            case .role(let role):
                let result = try await store.auth.updateAccount(account.name, role: role)
                updated(result)
                message = result.role.nowDescription(for: account.name)
            case .password(let password):
                updated(try await store.auth.updateAccount(account.name, password: password))
                message = String(localized: "Password reset.")
                self.password = ""
                confirmation = ""
            }
            failed = false
        } catch {
            if !error.isCancellation {
                failed = true
                message = error.localizedDescription
            }
        }
        saving = nil
    }
}

/// Admin: add an account with a password, or invite an email address to sign in with a service.
private struct NewAccountView: View {
    private enum Method: Hashable {
        case password, invitation
    }

    /// The services whose verified email addresses may redeem an invitation.
    let trustedServices: [SignInService]
    let created: (AccountInfo) -> Void
    let invited: (Invitation) -> Void

    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var method = Method.password
    @State private var name = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var email = ""
    /// nil for any trusted service.
    @State private var service: String?
    @State private var role = AccountRole.user
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canAdd: Bool {
        switch method {
        case .password: !trimmedName.isEmpty && PasswordRules.acceptable(password, confirmation: confirmation)
        case .invitation: trimmedEmail.contains("@")
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if !trustedServices.isEmpty {
                    Section {
                        Picker("Signs In With", selection: $method) {
                            Text("Password").tag(Method.password)
                            Text("A Service (Invitation)").tag(Method.invitation)
                        }
                    } footer: {
                        if method == .invitation {
                            Text("No password to share: the first sign-in with this verified email address creates the account.")
                        }
                    }
                }
                if method == .invitation {
                    Section {
                        TextField("Email Address", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Picker("Service", selection: $service) {
                            Text("Any of Them").tag(String?.none)
                            ForEach(trustedServices) { service in
                                Text(service.displayName).tag(Optional(service.id))
                            }
                        }
                    } footer: {
                        if let errorMessage {
                            Text(errorMessage).foregroundStyle(.red)
                        }
                    }
                } else {
                    Section {
                        TextField("Account Name", text: $name)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        SecureField("Password", text: $password)
                            .textContentType(.newPassword)
                        SecureField("Confirm Password", text: $confirmation)
                            .textContentType(.newPassword)
                    } footer: {
                        if let message = errorMessage ?? PasswordRules.problem(password, confirmation: confirmation) {
                            Text(message).foregroundStyle(.red)
                        }
                    }
                }
                Section {
                    Picker("Role", selection: $role) {
                        ForEach(AccountRole.allCases) { role in
                            Text(role.title).tag(role)
                        }
                    }
                } footer: {
                    Text(role.summary)
                }
            }
            .navigationTitle(method == .invitation ? "Invite" : "Add Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button(method == .invitation ? "Invite" : "Add") {
                            errorMessage = nil
                            isSaving = true
                        }
                        .disabled(!canAdd)
                    }
                }
            }
        }
        .task(id: isSaving) {
            if isSaving {
                await add()
            }
        }
    }

    private func add() async {
        do {
            switch method {
            case .password:
                created(try await store.auth.createAccount(name: trimmedName, password: password, role: role))
            case .invitation:
                invited(try await store.auth.invite(email: trimmedEmail, role: role, provider: service))
            }
            dismiss()
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        isSaving = false
    }
}
