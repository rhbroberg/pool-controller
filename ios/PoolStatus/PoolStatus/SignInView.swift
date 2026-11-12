import AuthenticationServices
import PoolStatusCore
import SwiftUI

/// The server is known but nobody is signed in: nothing from the pool shows until someone is.
struct SignInView: View {
    @Environment(StatusStore.self) private var store
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @AppStorage(SettingsKey.poolName) private var poolName = StatusView.defaultPoolName
    @State private var accountName = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @State private var signInError: String?
    @State private var confirmingChangeServer = false
    @FocusState private var passwordFocused: Bool
    /// nil from a server too old to have sign-in services, or one that can't be reached.
    @State private var serverChoices: SignInChoices?
    /// The service whose sign-in page is open.
    @State private var signingInWith: SignInProvider?
    /// What signing in with a service ended with, when it didn't simply sign in.
    @State private var serviceMessage: String?
    @State private var serviceFailed = false

    private var auth: AuthSession { store.auth }
    private var choices: SignInChoices { serverChoices ?? .passwordOnly }

    private var canSignIn: Bool {
        !accountName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty && !isSigningIn
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: "figure.pool.swim")
                            .font(.largeTitle)
                            .foregroundStyle(Color.accentColor)
                        Text(poolName.isEmpty ? StatusView.defaultPoolName : poolName)
                            .font(.title2.weight(.semibold))
                        Text(ServerAddress.display(store.serverAddress))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }

                if auth.signInExpired {
                    Section {
                        Label("Your sign-in is no longer valid. Sign in again.", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    if choices.passwordSignIn {
                        TextField("Account Name", text: $accountName)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                            .onSubmit { passwordFocused = true }
                        PasswordField("Password", text: $password, contentType: .password, focused: $passwordFocused)
                            .submitLabel(.go)
                            .onSubmit(startPasswordSignIn)
                        Button(action: startPasswordSignIn) {
                            HStack {
                                Text("Sign In")
                                if isSigningIn {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(!canSignIn)
                    }
                    ForEach(choices.providers) { provider in
                        Button {
                            signInError = nil
                            serviceMessage = nil
                            signingInWith = provider
                        } label: {
                            HStack {
                                Text("Continue with \(provider.displayName)")
                                if signingInWith == provider {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(signingInWith != nil)
                    }
                } header: {
                    Text("Sign In")
                } footer: {
                    if let signInError {
                        Text(signInError).foregroundStyle(.red)
                    } else if let serviceMessage {
                        Text(serviceMessage).foregroundStyle(serviceFailed ? .red : .secondary)
                    } else {
                        Text("Sign in to see and control this pool. You stay signed in on this iPhone until you sign out.")
                    }
                }

                Section {
                    Button("Use a Different Server") {
                        confirmingChangeServer = true
                    }
                    .disabled(isSigningIn || signingInWith != nil)
                }
            }
            .navigationTitle("Sign In")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog("Use a different server?", isPresented: $confirmingChangeServer, titleVisibility: .visible) {
                Button("Use a Different Server") {
                    store.serverAddress = ""
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You’ll choose the server attached to your pool controller again.")
            }
            .task(id: store.serverAddress) {
                serverChoices = await auth.signInChoices()
            }
            .task(id: isSigningIn) {
                if isSigningIn {
                    await signIn()
                }
            }
            .task(id: signingInWith) {
                if let signingInWith {
                    await signIn(with: signingInWith)
                }
            }
            .fullScreenCover(isPresented: Binding(get: { auth.commissioning != nil },
                                                  set: { if !$0 { auth.cancelCommissioning() } })) {
                CommissioningView()
            }
            .onAppear {
                accountName = auth.lastAccountName ?? ""
                passwordFocused = !accountName.isEmpty
            }
        }
    }

    private func startPasswordSignIn() {
        guard canSignIn else {
            return
        }
        signInError = nil
        isSigningIn = true
    }

    private func signIn() async {
        do {
            try await auth.signIn(name: accountName.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            password = ""
        } catch {
            if !error.isCancellation {
                signInError = error.localizedDescription
            }
        }
        isSigningIn = false
    }

    private func signIn(with provider: SignInProvider) async {
        defer { signingInWith = nil }
        do {
            let url = try auth.client.signInURL(provider: provider.id)
            if let outcome = try await runSignInSession(url, in: webAuthenticationSession, auth: auth) {
                serviceMessage = outcome.message
                serviceFailed = outcome.isFailure
            }
        } catch {
            if !error.isCancellation {
                serviceMessage = error.localizedDescription
                serviceFailed = true
            }
        }
    }
}

#if DEBUG
#Preview {
    SignInView()
        .environment(StatusStore.preview())
}
#endif
