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
                Section {
                    TextField(StatusView.defaultPoolName, text: $draftPoolName)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                } header: {
                    Text("Pool Name")
                } footer: {
                    Text("Shown as the title of the main screen.")
                }

                Section {
                    TextField("http://192.168.1.20:8080", text: $draftAddress)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Use Default (\(StatusView.defaultServerAddress))") {
                        draftAddress = StatusView.defaultServerAddress
                    }
                } header: {
                    Text("Server Address")
                } footer: {
                    Text("The pool controller’s web server, with its port. Use https and no port when going through the reverse proxy.")
                }

                Section {
                    Picker("Retry Every", selection: $reconnectSeconds) {
                        ForEach(Self.reconnectChoices, id: \.self) { seconds in
                            Text(Duration.seconds(seconds), format: .units(allowed: [.minutes, .seconds], width: .wide))
                                .tag(seconds)
                        }
                    }
                } header: {
                    Text("Connection")
                } footer: {
                    Text("How often the app tries to reach the server after losing the connection.")
                }

                Section {
                    if let credentials = store.credentials {
                        LabeledContent("Signed In", value: credentials.email)
                        Button("Sign Out", role: .destructive) {
                            store.signOut()
                        }
                    } else {
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress)
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
                    } else {
                        Text("Signing in lets the app turn equipment on and off. Status is visible without an account.")
                    }
                }
            }
            .navigationTitle("Settings")
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
