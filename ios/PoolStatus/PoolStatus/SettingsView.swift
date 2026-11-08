import SwiftUI

struct SettingsView: View {
    static let reconnectChoices = [10, 30, 60, 120, 300]

    private enum Route: Hashable {
        case changePassword, eventLog, accounts, serverMaintenance
    }

    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.reconnectSeconds) private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @AppStorage(SettingsKey.poolName) private var poolName = StatusView.defaultPoolName
    @Environment(\.dismiss) private var dismiss
    @State private var draftAddress = ""
    @State private var draftPoolName = ""
    @State private var accountName = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @State private var signInError: String?
    @State private var isScanningNetwork = false

    private var auth: AuthSession { store.auth }

    private var trimmedAddress: String {
        draftAddress.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                // kept to few sections so Administration stays on screen without scrolling
                Section {
                    LabeledContent("Name") {
                        TextField(StatusView.defaultPoolName, text: $draftPoolName)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.done)
                    }
                    LabeledContent("Server") {
                        HStack(spacing: 12) {
                            TextField("", text: $draftAddress)
                                .accessibilityLabel("Server")
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.URL)
                                .textContentType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            Button {
                                isScanningNetwork = true
                            } label: {
                                Image(systemName: "magnifyingglass")
                            }
                            // borderless so tapping the text field doesn't also start a scan
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Scan Network")
                        }
                    }
                    Picker("Retry Every", selection: $reconnectSeconds) {
                        ForEach(Self.reconnectChoices, id: \.self) { seconds in
                            Text(Duration.seconds(seconds), format: .units(allowed: [.minutes, .seconds], width: .wide))
                                .tag(seconds)
                        }
                    }
                } header: {
                    Text("Pool")
                } footer: {
                    Text("The server attached to your pool controller, with its port. Tap \(Image(systemName: "magnifyingglass")) to look for one on your network.")
                }

                Section {
                    if let credentials = auth.credentials {
                        LabeledContent("Signed In") {
                            if let role = credentials.role {
                                Text("\(credentials.name) · \(role.title)")
                            } else {
                                Text(credentials.name)
                            }
                        }
                        NavigationLink("Change Password", value: Route.changePassword)
                        Button("Sign Out", role: .destructive) {
                            auth.signOut()
                        }
                    } else {
                        TextField("Account Name", text: $accountName)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                        Button {
                            signInError = nil
                            // signing in is to the server being typed, so it takes effect now
                            // rather than on Done
                            store.serverAddress = trimmedAddress
                            isSigningIn = true
                        } label: {
                            HStack {
                                Text("Sign In")
                                if isSigningIn {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(accountName.isEmpty || password.isEmpty || trimmedAddress.isEmpty || isSigningIn)
                    }
                } header: {
                    Text("Account")
                } footer: {
                    if let signInError {
                        Text(signInError).foregroundStyle(.red)
                    } else if auth.credentials == nil {
                        Text("Signing in lets you change equipment, water flow and the controller’s settings. Status is visible without an account.")
                    }
                }

                Section(auth.isAdmin ? "History & Administration" : "History") {
                    NavigationLink("Event Log", value: Route.eventLog)
                    if auth.isAdmin {
                        NavigationLink("Accounts", value: Route.accounts)
                        NavigationLink("Server Maintenance", value: Route.serverMaintenance)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .changePassword: ChangePasswordView()
                case .eventLog: EventLogView()
                case .accounts: AccountsView()
                case .serverMaintenance: ServerMaintenanceView()
                }
            }
            .fullScreenCover(isPresented: Binding(get: { auth.commissioning != nil },
                                                  set: { if !$0 { auth.cancelCommissioning() } })) {
                CommissioningView()
            }
            .sheet(isPresented: $isScanningNetwork) {
                NetworkScanView { draftAddress = $0 }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // every change applies: the picker and sign-in at once, the text fields on Done
                // or when the sheet is swiped away, so there's nothing for a Cancel to undo
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                draftAddress = store.serverAddress
                draftPoolName = poolName
            }
        }
        .task(id: isSigningIn) {
            if isSigningIn {
                await signIn()
            }
        }
        .onDisappear(perform: commitDrafts)
    }

    private func commitDrafts() {
        if !trimmedAddress.isEmpty {
            store.serverAddress = trimmedAddress
        }
        let name = draftPoolName.trimmingCharacters(in: .whitespacesAndNewlines)
        poolName = name.isEmpty ? StatusView.defaultPoolName : name
    }

    private func signIn() async {
        do {
            try await auth.signIn(name: accountName.trimmingCharacters(in: .whitespacesAndNewlines),
                                  password: password)
            password = ""
        } catch {
            if !error.isCancellation {
                signInError = error.localizedDescription
            }
        }
        isSigningIn = false
    }
}

/// Restart and factory reset, kept off the main Settings page because they affect the server
/// rather than this app.
struct ServerMaintenanceView: View {
    private enum Operation {
        case restart, factoryReset
    }

    @Environment(StatusStore.self) private var store
    @State private var confirmingRestart = false
    @State private var confirmingReset = false
    /// The operation under way; leaving the page cancels it.
    @State private var operation: Operation?
    @State private var message: String?

    var body: some View {
        Form {
            Section {
                Button("Restart Server") {
                    confirmingRestart = true
                }
            } footer: {
                Text("The server stops and its container starts it again. The app reconnects when it’s back.")
            }

            Section {
                Button("Factory Reset", role: .destructive) {
                    confirmingReset = true
                }
                .foregroundStyle(.red)
            } footer: {
                Text("Erases all history and accounts on the server and recreates the \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) account.")
            }

            if let message {
                Section {
                    Text(message)
                }
            } else if store.auth.credentials == nil {
                Section {
                    Text("Sign in to restart or reset the server.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(!store.auth.isAdmin || operation != nil)
        .navigationTitle("Server Maintenance")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Restart the server?", isPresented: $confirmingRestart, titleVisibility: .visible) {
            Button("Restart Server") {
                start(.restart)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Status, equipment changes and panel keys stop for everyone until it’s back, usually within a minute.")
        }
        .confirmationDialog("Are you sure?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Factory Reset", role: .destructive) {
                start(.factoryReset)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases all history and accounts on the server and recreates the \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) account. It can’t be undone.")
        }
        .task(id: operation) {
            if let operation {
                await perform(operation)
            }
        }
    }

    private func start(_ operation: Operation) {
        message = nil
        self.operation = operation
    }

    private func perform(_ operation: Operation) async {
        do {
            switch operation {
            case .restart:
                try await store.restartServer()
                message = String(localized: "The server is restarting. The app reconnects when it’s back.")
            case .factoryReset:
                _ = try await store.factoryReset()
                message = String(localized: "Factory reset complete. Sign in as \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) to set up the server.")
            }
        } catch {
            if !error.isCancellation {
                message = error.localizedDescription
            }
        }
        self.operation = nil
    }
}
