import SwiftUI

struct SettingsView: View {
    static let reconnectChoices = [10, 30, 60, 120, 300]

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
                        NavigationLink("Change Password") {
                            ChangePasswordView()
                        }
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
                            signIn()
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
                    NavigationLink("Event Log") {
                        EventLogView()
                    }
                    if auth.isAdmin {
                        NavigationLink("Accounts") {
                            AccountsView()
                        }
                        NavigationLink("Server Maintenance") {
                            ServerMaintenanceView()
                        }
                    }
                }
            }
            .navigationTitle("Settings")
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
        .onDisappear(perform: commitDrafts)
    }

    private func commitDrafts() {
        if !trimmedAddress.isEmpty {
            store.serverAddress = trimmedAddress
        }
        let name = draftPoolName.trimmingCharacters(in: .whitespacesAndNewlines)
        poolName = name.isEmpty ? StatusView.defaultPoolName : name
    }

    private func signIn() {
        isSigningIn = true
        signInError = nil
        // signing in is to the server being typed, so it takes effect now rather than on Done
        store.serverAddress = trimmedAddress
        Task {
            defer { isSigningIn = false }
            do {
                try await auth.signIn(name: accountName.trimmingCharacters(in: .whitespacesAndNewlines),
                                      password: password)
                password = ""
            } catch {
                signInError = error.localizedDescription
            }
        }
    }
}

/// Restart and factory reset, kept off the main Settings page because they affect the server
/// rather than this app.
struct ServerMaintenanceView: View {
    @Environment(StatusStore.self) private var store
    @State private var confirmingRestart = false
    @State private var confirmingReset = false
    @State private var isWorking = false
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
        .disabled(!store.auth.isAdmin || isWorking)
        .navigationTitle("Server Maintenance")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Restart the server?", isPresented: $confirmingRestart, titleVisibility: .visible) {
            Button("Restart Server") {
                restartServer()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Status, equipment changes and panel keys stop for everyone until it’s back, usually within a minute.")
        }
        .confirmationDialog("Are you sure?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Factory Reset", role: .destructive) {
                factoryReset()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases all history and accounts on the server and recreates the \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) account. It can’t be undone.")
        }
    }

    private func restartServer() {
        isWorking = true
        message = nil
        Task {
            defer { isWorking = false }
            do {
                try await store.restartServer()
                message = "The server is restarting. The app reconnects when it’s back."
            } catch {
                message = error.localizedDescription
            }
        }
    }

    private func factoryReset() {
        isWorking = true
        message = nil
        Task {
            defer { isWorking = false }
            do {
                _ = try await store.factoryReset()
                message = "Factory reset complete. Sign in as \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) to set up the server."
            } catch {
                message = error.localizedDescription
            }
        }
    }
}
