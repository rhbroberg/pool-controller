import PoolStatusCore
import SwiftUI

/// Admin: every account on the server, with ways to add, change and remove them, guests with
/// their QR codes, and accounts that have expired and been archived.
struct AccountsView: View {
    @Environment(StatusStore.self) private var store
    @State private var accounts: [AccountInfo] = []
    @State private var showArchived = false
    @State private var addingGuest = false
    /// The guest whose QR code is showing.
    @State private var showingCode: AccountInfo?
    @State private var confirmingDeleteArchived = false
    @State private var deletingArchived = false
    /// What the last action did, such as copying a QR code.
    @State private var notice: String?
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
    private var active: [AccountInfo] { accounts.filter { !$0.isArchived } }
    private var archived: [AccountInfo] { accounts.filter(\.isArchived) }

    var body: some View {
        List {
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            } else if let notice {
                Section {
                    Label(notice, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.secondary)
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
                ForEach(active) { account in
                    accountRow(account)
                }
            } header: {
                if !pending.isEmpty || !invitations.isEmpty {
                    Text("Accounts")
                }
            } footer: {
                Text("Swipe left on an account to remove it. Viewers can only look; operators can also change equipment, water flow and panel settings; admins can also manage accounts and the server. Add a guest with \(Image(systemName: "person.badge.plus")) for an operator who lasts a week, with a QR code that lets them in to choose a password.")
            }
            if !accounts.isEmpty {
                Section {
                    Toggle(archived.isEmpty ? String(localized: "Show Archived") : String(localized: "Show Archived (\(archived.count))"),
                           isOn: $showArchived)
                } footer: {
                    Text("Accounts are archived once they expire, and can’t sign in after that.")
                }
            }
            if showArchived && !archived.isEmpty {
                Section("Archived") {
                    ForEach(archived) { account in
                        accountRow(account)
                    }
                    Button(role: .destructive) {
                        confirmingDeleteArchived = true
                    } label: {
                        HStack {
                            Text("Delete Archived Accounts")
                            if deletingArchived {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(deletingArchived)
                }
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
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Add Guest", systemImage: "person.badge.plus") {
                    addingGuest = true
                }
                Button("Add Account", systemImage: "plus") {
                    addingAccount = true
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: $addingGuest) {
            NewGuestView { guest in
                accounts.append(guest)
                accounts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                notice = nil
                showingCode = guest
            }
        }
        .sheet(item: $showingCode) { guest in
            GuestQRView(account: guest, serverAddress: store.serverAddress)
        }
        .confirmationDialog("Delete \(archived.count) archived \(archived.count == 1 ? "account" : "accounts")?",
                            isPresented: $confirmingDeleteArchived, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                deletingArchived = true
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("They’re removed for good. Archived accounts already can’t sign in.")
        }
        .task(id: deletingArchived) {
            if deletingArchived {
                await act {
                    try await auth.deleteArchivedAccounts()
                    accounts.removeAll(where: \.isArchived)
                }
                deletingArchived = false
            }
        }
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

    /// An account, opening its details; a guest that can still sign in also has its QR code and
    /// a way to copy it.
    private func accountRow(_ account: AccountInfo) -> some View {
        HStack(spacing: 4) {
            NavigationLink(value: account) {
                AccountRow(account: account, isYou: account.name == auth.credentials?.name,
                           methods: services.isEmpty || account.isArchived ? nil : signInMethodNames(account.methods, services: providers))
            }
            if account.isGuest && !account.isArchived {
                Button {
                    showingCode = account
                } label: {
                    Label("QR Code", systemImage: "qrcode")
                        .labelStyle(.iconOnly)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Show \(account.name)’s QR Code")
                Button {
                    errorMessage = nil
                    notice = GuestQRCode.copy(account, serverAddress: store.serverAddress)
                        ? String(localized: "Copied \(account.name)’s QR code and link.") : nil
                } label: {
                    Label("Copy QR Code", systemImage: "doc.on.doc")
                        .labelStyle(.iconOnly)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy \(account.name)’s QR Code")
            }
        }
        .swipeActions {
            if account.name != auth.credentials?.name {
                Button("Remove", role: .destructive) {
                    removing = account
                }
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

    /// Archived, a guest yet to use its link, or when it expires.
    private var status: [String] {
        if let archivedAt = account.archivedAt {
            return [String(localized: "Archived \(archivedAt, format: .dateTime.month().day().year())")]
        }
        var parts = [String]()
        if account.isGuest {
            parts.append(account.setupCode != nil ? String(localized: "Guest · hasn’t used the link yet") : String(localized: "Guest"))
        }
        if let expiresAt = account.expiresAt {
            parts.append(String(localized: "expires \(expiresAt, format: .relative(presentation: .named))"))
        }
        return parts
    }

    private var note: String? {
        let parts = (isYou ? [String(localized: "You")] : []) + status + (methods ?? [])
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name)
                    .foregroundStyle(account.isArchived ? .secondary : .primary)
                if account.mustChangeCredentials == true && !account.isGuest {
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

/// Admin: one account's dates, and changing its role, expiry or password.
private struct AccountDetailView: View {
    private enum Change: Equatable {
        case role(AccountRole)
        case password(String)
        case expiry(AccountExpiry)
    }

    let account: AccountInfo
    let services: [SignInProvider]
    let updated: (AccountInfo) -> Void

    @Environment(StatusStore.self) private var store
    /// The account as last saved here, which the dates and expiry follow.
    @State private var current: AccountInfo
    @State private var role: AccountRole
    @State private var expires: Bool
    @State private var expiresAt: Date
    @State private var password = ""
    @State private var confirmation = ""
    /// The change being saved; leaving the page cancels it.
    @State private var saving: Change?
    @State private var message: String?
    @State private var failed = false
    @State private var confirmingReset = false
    @State private var showingCode = false

    init(account: AccountInfo, services: [SignInProvider], updated: @escaping (AccountInfo) -> Void) {
        self.account = account
        self.services = services
        self.updated = updated
        _current = State(initialValue: account)
        _role = State(initialValue: account.role)
        _expires = State(initialValue: account.expiresAt != nil)
        _expiresAt = State(initialValue: account.expiresAt ?? Date.now.addingTimeInterval(7 * 24 * 3600))
    }

    /// The expiry the controls say, if it differs from the saved one.
    private var expiryChange: AccountExpiry? {
        switch (expires, current.expiresAt) {
        case (false, nil): nil
        case (false, _): .never
        case (true, let saved): saved.map { abs($0.timeIntervalSince(expiresAt)) < 60 } == true ? nil : .at(expiresAt)
        }
    }

    var body: some View {
        if current.isArchived {
            Form {
                datesSection
                Section {
                    Text("\(account.name) expired and was archived, so it can’t sign in or be changed. Remove it from Accounts once it’s no longer needed.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(account.name)
            .navigationBarTitleDisplayMode(.inline)
        } else {
            details
        }
    }

    @ViewBuilder
    private var datesSection: some View {
        Section("History") {
            dateRow("Created", current.createdAt, never: "—")
            dateRow("First Signed In", current.firstSignInAt)
            dateRow("Last Signed In", current.lastSignInAt)
            if let archivedAt = current.archivedAt {
                dateRow("Archived", archivedAt)
            }
        }
    }

    private func dateRow(_ title: LocalizedStringKey, _ date: Date?, never: LocalizedStringKey = "Never") -> some View {
        LabeledContent(title) {
            if let date {
                Text(date, format: .dateTime.month().day().year().hour().minute())
            } else {
                Text(never)
            }
        }
    }

    private var details: some View {
        Form {
            if current.isGuest {
                Section {
                    Button("Show QR Code", systemImage: "qrcode") {
                        showingCode = true
                    }
                } footer: {
                    Text(current.setupCode != nil
                         ? "\(account.name) hasn’t used its link yet. The QR code lets them in once to choose a password."
                         : "\(account.name) has chosen a password. The QR code now opens the sign-in with the name filled in.")
                }
            }
            datesSection
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
                .disabled(role == current.role || saving != nil)
            } footer: {
                Text(role.summary)
            }

            Section {
                if current.role == .admin {
                    LabeledContent("Expires", value: String(localized: "Never"))
                } else {
                    Toggle("Expires", isOn: $expires)
                    if expires {
                        DatePicker("Archived On", selection: $expiresAt, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                    }
                    Button(expires || current.expiresAt == nil ? "Save Expiry" : "Never Expire") {
                        if let expiryChange {
                            start(.expiry(expiryChange))
                        }
                    }
                    .disabled(expiryChange == nil || saving != nil)
                }
            } header: {
                Text("Expires")
            } footer: {
                Text(current.role == .admin
                     ? "Admins don’t expire."
                     : "Once it passes, the account is archived and can’t sign in.")
            }

            Section {
                PasswordField("New Password", text: $password)
                PasswordField("Confirm Password", text: $confirmation)
                Button("Reset Password") {
                    confirmingReset = true
                }
                .disabled(!PasswordRules.acceptable(password, confirmation: confirmation) || saving != nil)
            } header: {
                Text(current.hasPassword ? "Reset Password" : "Set a Password")
            } footer: {
                if let problem = PasswordRules.problem(password, confirmation: confirmation) {
                    Text(problem).foregroundStyle(.red)
                } else if current.hasPassword {
                    Text("\(account.name) is signed out everywhere and must sign in with the new password.")
                } else if current.isGuest {
                    Text("\(account.name) hasn’t chosen a password yet. Setting one here lets them sign in with it as well as the link.")
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
        .sheet(isPresented: $showingCode) {
            GuestQRView(account: current, serverAddress: store.serverAddress)
        }
    }

    private func start(_ change: Change) {
        message = nil
        saving = change
    }

    private func keep(_ result: AccountInfo) {
        current = result
        updated(result)
        expires = result.expiresAt != nil
        if let saved = result.expiresAt {
            expiresAt = saved
        }
    }

    private func save(_ change: Change) async {
        do {
            switch change {
            case .role(let role):
                let result = try await store.auth.updateAccount(account.name, role: role)
                keep(result)
                message = result.role.nowDescription(for: account.name)
            case .password(let password):
                keep(try await store.auth.updateAccount(account.name, password: password))
                message = String(localized: "Password reset.")
                self.password = ""
                confirmation = ""
            case .expiry(let expiry):
                let result = try await store.auth.updateAccount(account.name, expiry: expiry)
                keep(result)
                message = result.expiresAt.map { String(localized: "\(account.name) expires \($0, format: .dateTime.month().day().hour().minute()).") }
                    ?? String(localized: "\(account.name) no longer expires.")
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
    @State private var expires = false
    @State private var expiresAt = Date.now.addingTimeInterval(30 * 24 * 3600)
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
                        PasswordField("Password", text: $password)
                        PasswordField("Confirm Password", text: $confirmation)
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
                if method == .password {
                    Section {
                        if role == .admin {
                            LabeledContent("Expires", value: String(localized: "Never"))
                        } else {
                            Toggle("Expires", isOn: $expires)
                            if expires {
                                DatePicker("Archived On", selection: $expiresAt, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                            }
                        }
                    } footer: {
                        Text(role == .admin
                             ? "Admins don’t expire."
                             : "Optional. Once it passes, the account is archived and can’t sign in.")
                    }
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
                created(try await store.auth.createAccount(name: trimmedName, password: password, role: role,
                                                           expiresAt: expires && role != .admin ? expiresAt : nil))
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
