import SwiftUI

struct SettingsView: View {
    @Binding var serverAddress: String
    let store: StatusStore

    @Environment(\.dismiss) private var dismiss
    @State private var draftAddress = ""
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
                        dismiss()
                    }
                    .disabled(trimmedAddress.isEmpty)
                }
            }
            .onAppear { draftAddress = serverAddress }
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
