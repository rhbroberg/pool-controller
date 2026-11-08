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
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var addingAccount = false
    /// Asked about before it's removed.
    @State private var removing: AccountInfo?
    /// Being removed; leaving the page cancels it.
    @State private var deleting: AccountInfo?

    private var auth: AuthSession { store.auth }

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
                    NavigationLink(value: account) {
                        AccountRow(account: account, isYou: account.name == auth.credentials?.name)
                    }
                    .swipeActions {
                        if account.name != auth.credentials?.name {
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
        .navigationDestination(for: AccountInfo.self) { account in
            AccountDetailView(account: account) { updated in
                if let index = accounts.firstIndex(where: { $0.name == updated.name }) {
                    accounts[index] = updated
                }
            }
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
            NewAccountView { created in
                accounts.append(created)
                accounts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
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
            accounts = try await auth.listAccounts()
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
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

private struct AccountRow: View {
    let account: AccountInfo
    let isYou: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name)
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
    private enum Change: Equatable {
        case role(AccountRole)
        case password(String)
    }

    let account: AccountInfo
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

    init(account: AccountInfo, updated: @escaping (AccountInfo) -> Void) {
        self.account = account
        self.updated = updated
        _role = State(initialValue: account.role)
    }

    var body: some View {
        Form {
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
                Text("Reset Password")
            } footer: {
                if let problem = PasswordRules.problem(password, confirmation: confirmation) {
                    Text(problem).foregroundStyle(.red)
                } else {
                    Text("\(account.name) is signed out everywhere and must sign in with the new password.")
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

/// Admin: add an account.
private struct NewAccountView: View {
    let created: (AccountInfo) -> Void

    @Environment(StatusStore.self) private var store
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
                        Button("Add") {
                            errorMessage = nil
                            isSaving = true
                        }
                        .disabled(trimmedName.isEmpty || !PasswordRules.acceptable(password, confirmation: confirmation))
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
            let account = try await store.auth.createAccount(name: trimmedName, password: password, role: role)
            created(account)
            dismiss()
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        isSaving = false
    }
}
