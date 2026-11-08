import SwiftUI

/// Shown after signing in with the default admin / admin account: the account must be
/// renamed and given a new password before it can change anything.
struct CommissioningView: View {
    static let defaultAdmin = "admin"

    @Environment(StatusStore.self) private var store
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
        return PasswordRules.problem(password, confirmation: confirmation)
    }

    private var canSave: Bool {
        !trimmedName.isEmpty && PasswordRules.acceptable(password, confirmation: confirmation)
            && problem == nil && !isSaving
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
                    Button("Cancel") { store.auth.cancelCommissioning() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") {
                            errorMessage = nil
                            isSaving = true
                        }
                        .disabled(!canSave)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
        }
        .task(id: isSaving) {
            if isSaving {
                await save()
            }
        }
    }

    private func save() async {
        do {
            try await store.auth.commission(name: trimmedName, password: password)
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        isSaving = false
    }
}
