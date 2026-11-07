import SwiftUI

/// Shown after signing in with the default admin / admin account: the account must be
/// renamed and given a new password before it can change anything.
struct CommissioningView: View {
    static let defaultAdmin = "admin"
    static let minimumPasswordLength = 6

    let store: StatusStore
    let serverAddress: String

    @State private var name = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Why the entries can't be saved yet, once the user has started typing.
    private var problem: String? {
        if trimmedName.lowercased() == Self.defaultAdmin {
            return "Choose an account name other than \(Self.defaultAdmin)."
        }
        if !password.isEmpty && password.count < Self.minimumPasswordLength {
            return "Use at least \(Self.minimumPasswordLength) characters for the password."
        }
        if !confirmation.isEmpty && confirmation != password {
            return "The passwords don’t match."
        }
        return nil
    }

    private var canSave: Bool {
        !trimmedName.isEmpty && password.count >= Self.minimumPasswordLength
            && password == confirmation && problem == nil && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This server still has its default \(Self.defaultAdmin) account. Choose your own account name and password. Once you save, \(Self.defaultAdmin) / \(Self.defaultAdmin) no longer signs in.")
                        .font(.subheadline)
                }

                Section {
                    TextField("Account Name", text: $name)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("New Password", text: $password)
                        .textContentType(.newPassword)
                    SecureField("Confirm Password", text: $confirmation)
                        .textContentType(.newPassword)
                } header: {
                    Text("Your Account")
                } footer: {
                    if let message = errorMessage ?? problem {
                        Text(message).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Set Up Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { store.cancelCommissioning() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .disabled(!canSave)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            defer { isSaving = false }
            do {
                try await store.commission(name: trimmedName, password: password, serverAddress: serverAddress)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
