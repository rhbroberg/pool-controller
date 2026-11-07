import SwiftUI

/// Shared rules for new passwords, matching the server's.
enum PasswordRules {
    static let minimumLength = 6

    /// Why `password` and `confirmation` can't be used yet, once something has been typed.
    static func problem(_ password: String, confirmation: String) -> String? {
        if !password.isEmpty && password.count < minimumLength {
            return "Use at least \(minimumLength) characters."
        }
        if !confirmation.isEmpty && confirmation != password {
            return "The passwords don’t match."
        }
        return nil
    }

    static func acceptable(_ password: String, confirmation: String) -> Bool {
        password.count >= minimumLength && password == confirmation
    }
}

/// Any signed-in account changing its own password.
struct ChangePasswordView: View {
    let store: StatusStore
    let serverAddress: String

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
                    Button("Save") { save() }
                        .disabled(current.isEmpty || !PasswordRules.acceptable(password, confirmation: confirmation))
                }
            }
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            defer { isSaving = false }
            do {
                try await store.changePassword(current: current, new: password, serverAddress: serverAddress)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// Admin: every account on the server, with ways to add, change and remove them.
struct AccountsView: View {
    let store: StatusStore
    let serverAddress: String

    @State private var accounts: [AccountInfo] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var addingAccount = false
    @State private var removing: AccountInfo?

    private var client: StatusClient { StatusClient(serverAddress: serverAddress) }
    private var token: String { store.credentials?.token ?? "" }

    var body: some View {
        List {
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            Section {
                ForEach(accounts) { account in
                    NavigationLink {
                        AccountDetailView(account: account, store: store, serverAddress: serverAddress) { updated in
                            if let index = accounts.firstIndex(where: { $0.email == updated.email }) {
                                accounts[index] = updated
                            }
                        }
                    } label: {
                        AccountRow(account: account, isYou: account.email == store.credentials?.email)
                    }
                    .swipeActions {
                        if account.email != store.credentials?.email {
                            Button("Remove", role: .destructive) {
                                removing = account
                            }
                        }
                    }
                }
            } footer: {
                Text("Swipe left on an account to remove it. Viewers can only look; operators can also change equipment, water flow and panel settings; admins can also manage accounts and the server.")
            }
        }
        .overlay {
            if accounts.isEmpty && isLoading {
                ProgressView()
            }
        }
        .navigationTitle("Accounts")
        .navigationBarTitleDisplayMode(.inline)
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
            NewAccountView(store: store, serverAddress: serverAddress) { created in
                accounts.append(created)
                accounts.sort { $0.email.localizedCaseInsensitiveCompare($1.email) == .orderedAscending }
            }
        }
        .confirmationDialog("Remove \(removing?.email ?? "")?", isPresented: Binding(get: { removing != nil },
                                                                                       set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible) {
            Button("Remove Account", role: .destructive) {
                if let removing {
                    remove(removing)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The account is deleted and signed out everywhere.")
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            accounts = try await client.listAccounts(token: token)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func remove(_ account: AccountInfo) {
        Task {
            do {
                try await client.deleteAccount(account.email, token: token)
                accounts.removeAll { $0.email == account.email }
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct AccountRow: View {
    let account: AccountInfo
    let isYou: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.email)
                if account.mustChangeCredentials == true {
                    Text("Not set up yet")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } else if isYou {
                    Text("You")
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
    let account: AccountInfo
    let store: StatusStore
    let serverAddress: String
    let updated: (AccountInfo) -> Void

    @State private var role: AccountRole
    @State private var password = ""
    @State private var confirmation = ""
    @State private var isSaving = false
    @State private var message: String?
    @State private var failed = false
    @State private var confirmingReset = false

    init(account: AccountInfo, store: StatusStore, serverAddress: String, updated: @escaping (AccountInfo) -> Void) {
        self.account = account
        self.store = store
        self.serverAddress = serverAddress
        self.updated = updated
        _role = State(initialValue: account.role)
    }

    private var client: StatusClient { StatusClient(serverAddress: serverAddress) }
    private var token: String { store.credentials?.token ?? "" }

    var body: some View {
        Form {
            Section {
                Picker("Role", selection: $role) {
                    ForEach(AccountRole.allCases) { role in
                        Text(role.title).tag(role)
                    }
                }
                Button("Save Role") {
                    save(role: role, password: nil)
                }
                .disabled(role == account.role || isSaving)
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
                .disabled(!PasswordRules.acceptable(password, confirmation: confirmation) || isSaving)
            } header: {
                Text("Reset Password")
            } footer: {
                if let problem = PasswordRules.problem(password, confirmation: confirmation) {
                    Text(problem).foregroundStyle(.red)
                } else {
                    Text("\(account.email) is signed out everywhere and must sign in with the new password.")
                }
            }

            if let message {
                Section {
                    Text(message)
                        .foregroundStyle(failed ? .red : .secondary)
                }
            }
        }
        .navigationTitle(account.email)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Reset \(account.email)’s password?", isPresented: $confirmingReset,
                            titleVisibility: .visible) {
            Button("Reset Password", role: .destructive) {
                save(role: nil, password: password)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(account.email) is signed out on every device and must sign in with the new password.")
        }
    }

    private func save(role: AccountRole?, password: String?) {
        isSaving = true
        message = nil
        Task {
            defer { isSaving = false }
            do {
                let result = try await client.updateAccount(account.email, role: role, password: password, token: token)
                updated(result)
                failed = false
                message = password == nil ? "\(account.email) is now \(result.role.titleWithArticle)." : "Password reset."
                self.password = ""
                confirmation = ""
                if account.email == store.credentials?.email {
                    await store.refreshAccount(serverAddress: serverAddress)
                }
            } catch {
                failed = true
                message = error.localizedDescription
            }
        }
    }
}

/// Admin: add an account.
private struct NewAccountView: View {
    let store: StatusStore
    let serverAddress: String
    let created: (AccountInfo) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var role = AccountRole.user
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
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
            .navigationTitle("Add Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Add") { add() }
                            .disabled(trimmedName.isEmpty || !PasswordRules.acceptable(password, confirmation: confirmation))
                    }
                }
            }
        }
    }

    private func add() {
        isSaving = true
        errorMessage = nil
        Task {
            defer { isSaving = false }
            do {
                let account = try await StatusClient(serverAddress: serverAddress)
                    .createAccount(name: trimmedName, password: password, role: role, token: store.credentials?.token ?? "")
                created(account)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
