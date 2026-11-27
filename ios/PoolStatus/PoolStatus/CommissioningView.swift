import PoolStatusCore
import SwiftUI

/// Shown after signing in with the default admin / admin account, which must be renamed and
/// given a new password before it can change anything, and after a guest signs in with the code
/// in its link or QR code, which must choose a password.
struct CommissioningView: View {
    static let defaultAdmin = "admin"

    @Environment(StatusStore.self) private var store
    @State private var name = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    /// The guest's name, which it keeps; nil for the default admin, which chooses one.
    private var guest: String? {
        store.auth.commissioningGuest ? store.auth.commissioning?.name : nil
    }

    private var trimmedName: String {
        (guest ?? name).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Why the entries can't be saved yet, once the user has started typing.
    private var problem: String? {
        if guest == nil && trimmedName.lowercased() == Self.defaultAdmin {
            return String(localized: "Choose an account name other than \(Self.defaultAdmin).")
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
                    if let guest {
                        Text("Welcome, \(guest). Choose a password for this account. From now on you sign in with it, and the QR code you used no longer does.")
                            .font(.subheadline)
                    } else {
                        Text("This server still has its default \(Self.defaultAdmin) account. Choose your own account name and password. Once you save, \(Self.defaultAdmin) / \(Self.defaultAdmin) no longer signs in.")
                            .font(.subheadline)
                    }
                }

                Section {
                    if let guest {
                        LabeledContent("Account Name", value: guest)
                    } else {
                        TextField("Account Name", text: $name)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    PasswordField("New Password", text: $password)
                    PasswordField("Confirm Password", text: $confirmation)
                        .submitLabel(.done)
                        .onSubmit {
                            if canSave {
                                errorMessage = nil
                                isSaving = true
                            }
                        }
                } header: {
                    Text("Your Account")
                } footer: {
                    if let message = errorMessage ?? problem {
                        Text(message).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(guest == nil ? "Set Up Account" : "Choose a Password")
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
