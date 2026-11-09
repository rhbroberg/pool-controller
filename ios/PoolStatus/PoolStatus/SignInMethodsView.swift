import AuthenticationServices
import PoolStatusCore
import SwiftUI

/// Opens `url` in a web authentication session and finishes with what the server sent back to
/// `poolstatus://signin`; nil if the person closed the session.
@MainActor
func runSignInSession(_ url: URL, in session: WebAuthenticationSession, auth: AuthSession) async throws -> SignInOutcome? {
    do {
        let callback = try await session.authenticate(using: url, callbackURLScheme: SignInOutcome.callbackScheme)
        return try await auth.completeSignIn(callback: callback)
    } catch ASWebAuthenticationSessionError.canceledLogin {
        return nil
    }
}

/// How the signed-in account signs in: its password, and the services linked to it.
struct SignInMethodsView: View {
    let providers: [SignInProvider]

    @Environment(StatusStore.self) private var store
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    /// The service whose page is open; leaving the page cancels it.
    @State private var linking: SignInProvider?
    @State private var unlinking: SignInProvider?
    @State private var message: String?
    @State private var failed = false

    private var auth: AuthSession { store.auth }

    var body: some View {
        let methods = auth.methods ?? []
        Form {
            if auth.hasPassword {
                Section {
                    NavigationLink("Change Password") { ChangePasswordView() }
                }
            }
            Section {
                ForEach(providers) { provider in
                    if methods.contains(provider.id) {
                        LabeledContent(provider.displayName) {
                            Button("Unlink") { unlinking = provider }
                                .buttonStyle(.borderless)
                        }
                    } else {
                        Button {
                            message = nil
                            linking = provider
                        } label: {
                            HStack {
                                Text("Link \(provider.displayName)")
                                if linking == provider {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(linking != nil)
                    }
                }
            } header: {
                Text("Services")
            } footer: {
                if let message {
                    Text(message).foregroundStyle(failed ? .red : .secondary)
                } else {
                    Text("Link a service to sign in with it instead of a password.")
                }
            }
        }
        .navigationTitle("Sign-In Methods")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: linking) {
            if let linking {
                await link(linking)
            }
        }
        .confirmationDialog("Stop signing in with \(unlinking?.displayName ?? "")?", isPresented: Binding(isPresent: $unlinking),
                            titleVisibility: .visible) {
            Button("Unlink", role: .destructive) {
                if let provider = unlinking {
                    Task { await unlink(provider) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You can link it again later.")
        }
    }

    private func link(_ provider: SignInProvider) async {
        defer { linking = nil }
        do {
            let url = try await auth.linkURL(provider: provider.id)
            if let outcome = try await runSignInSession(url, in: webAuthenticationSession, auth: auth) {
                message = outcome.message
                failed = outcome.isFailure
            }
        } catch {
            if !error.isCancellation {
                message = error.localizedDescription
                failed = true
            }
        }
    }

    private func unlink(_ provider: SignInProvider) async {
        do {
            try await auth.unlink(provider: provider.id)
            message = nil
        } catch {
            if !error.isCancellation {
                message = error.localizedDescription
                failed = true
            }
        }
    }
}
