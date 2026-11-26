import PoolStatusCore
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
                PasswordField("Current Password", text: $current, contentType: .password)
            }

            Section {
                PasswordField("New Password", text: $password)
                PasswordField("Confirm Password", text: $confirmation)
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
