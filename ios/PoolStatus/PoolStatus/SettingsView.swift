import SwiftUI

struct SettingsView: View {
    static let reconnectChoices = [10, 30, 60, 120, 300]

    @Binding var serverAddress: String
    let store: StatusStore

    @AppStorage("reconnectSeconds") private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @AppStorage("poolName") private var poolName = StatusView.defaultPoolName
    @Environment(\.dismiss) private var dismiss
    @State private var draftAddress = ""
    @State private var draftPoolName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @State private var signInError: String?

    private var trimmedAddress: String {
        draftAddress.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Pool Name") {
                    TextField(StatusView.defaultPoolName, text: $draftPoolName)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                }

                Section {
                    TextField("http://192.168.1.20:8080", text: $draftAddress)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Retry Every", selection: $reconnectSeconds) {
                        ForEach(Self.reconnectChoices, id: \.self) { seconds in
                            Text(Duration.seconds(seconds), format: .units(allowed: [.minutes, .seconds], width: .wide))
                                .tag(seconds)
                        }
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Include the port, or use https with no port through the reverse proxy.")
                }

                Section {
                    if let credentials = store.credentials {
                        LabeledContent("Signed In") {
                            if let role = credentials.role {
                                Text("\(credentials.email) · \(role.title)")
                            } else {
                                Text(credentials.email)
                            }
                        }
                        NavigationLink("Change Password") {
                            ChangePasswordView(store: store, serverAddress: serverAddress)
                        }
                        Button("Sign Out", role: .destructive) {
                            store.signOut(serverAddress: serverAddress)
                        }
                    } else {
                        TextField("Account Name", text: $email)
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
                        .disabled(email.isEmpty || password.isEmpty || trimmedAddress.isEmpty || isSigningIn)
                    }
                } header: {
                    Text("Account")
                } footer: {
                    if let signInError {
                        Text(signInError).foregroundStyle(.red)
                    } else if store.credentials == nil {
                        Text("Signing in lets the app turn equipment on and off. Status is visible without an account.")
                    }
                }

                if store.isAdmin {
                    Section("Administration") {
                        NavigationLink("Accounts") {
                            AccountsView(store: store, serverAddress: serverAddress)
                        }
                        NavigationLink("Server Maintenance") {
                            ServerMaintenanceView(store: store, serverAddress: serverAddress)
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: Binding(get: { store.commissioning != nil },
                                        set: { if !$0 { store.cancelCommissioning() } })) {
                CommissioningView(store: store, serverAddress: trimmedAddress)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        serverAddress = trimmedAddress
                        let name = draftPoolName.trimmingCharacters(in: .whitespacesAndNewlines)
                        poolName = name.isEmpty ? StatusView.defaultPoolName : name
                        dismiss()
                    }
                    .disabled(trimmedAddress.isEmpty)
                }
            }
            .onAppear {
                draftAddress = serverAddress
                draftPoolName = poolName
            }
        }
    }

    private func signIn() {
        isSigningIn = true
        signInError = nil
        Task {
            defer { isSigningIn = false }
            do {
                try await store.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                                       password: password,
                                       serverAddress: trimmedAddress)
                serverAddress = trimmedAddress
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
    let store: StatusStore
    let serverAddress: String

    @State private var confirmingReset = false
    @State private var isWorking = false
    @State private var message: String?

    var body: some View {
        Form {
            Section {
                Button("Restart Server") {
                    restartServer()
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
            } else if store.credentials == nil {
                Section {
                    Text("Sign in to restart or reset the server.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(!store.isAdmin || isWorking)
        .navigationTitle("Server Maintenance")
        .navigationBarTitleDisplayMode(.inline)
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
                try await store.restartServer(serverAddress: serverAddress)
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
                _ = try await store.factoryReset(serverAddress: serverAddress)
                message = "Factory reset complete. Sign in as \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) to set up the server."
            } catch {
                message = error.localizedDescription
            }
        }
    }
}
