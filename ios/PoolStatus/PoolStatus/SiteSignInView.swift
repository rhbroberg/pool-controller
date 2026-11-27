import AuthenticationServices
import PoolStatusCore
import SwiftUI

/// A site that isn't signed in: nothing from the pool shows until it is.
struct SiteSignInView: View {
    @Environment(SiteSession.self) private var session
    @Environment(StatusStore.self) private var store
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var accountName = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @State private var signInError: String?
    @FocusState private var passwordFocused: Bool
    /// nil from a server too old to have sign-in services, or one that can't be reached.
    @State private var serverChoices: SignInChoices?
    /// The service whose sign-in page is open.
    @State private var signingInWith: SignInProvider?
    /// What signing in with a service ended with, when it didn't simply sign in.
    @State private var serviceMessage: String?
    @State private var serviceFailed = false
    @State private var scanningCode = false
    /// What a scanned guest code is doing, or why it couldn't.
    @State private var codeMessage: String?

    private var auth: AuthSession { store.auth }
    private var choices: SignInChoices { serverChoices ?? .passwordOnly }
    private var site: Site? { session.openSite }

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
                        Text(site?.name ?? SiteStore.defaultName)
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
                    Button {
                        signInError = nil
                        codeMessage = nil
                        scanningCode = true
                    } label: {
                        Label("Sign In with QR Code", systemImage: "qrcode.viewfinder")
                    }
                    .accessibilityIdentifier("sign-in-qr")
                } footer: {
                    Text("Scan the guest QR code an admin shared. It uses the same link a phone’s camera opens in the browser.")
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
                    } else if let codeMessage {
                        Text(codeMessage)
                    } else if let serviceMessage {
                        Text(serviceMessage).foregroundStyle(serviceFailed ? .red : .secondary)
                    } else {
                        Text("Sign in to see and control this pool. You stay signed in on this iPhone until you sign out.")
                    }
                }
            }
            .navigationTitle(site?.name ?? SiteStore.defaultName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarTitleMenu {
                SiteSwitcherMenu()
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        session.showSites()
                    } label: {
                        Label("Sites", systemImage: "chevron.left")
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            .task {
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
            .fullScreenCover(item: Binding(
                get: { auth.commissioning },
                set: { if $0 == nil { auth.cancelCommissioning() } }
            )) { _ in
                CommissioningView()
            }
            .sheet(isPresented: $scanningCode) {
                ScanGuestCodeView { link in
                    Task { await open(link) }
                }
            }
            // a code scanned before this site opened, as from the list or Add Site
            .task(id: session.pendingGuestLink) {
                if let link = session.pendingGuestLink, link.isServer(store.serverAddress) {
                    session.pendingGuestLink = nil
                    await use(link)
                }
            }
            .onAppear {
                accountName = site?.accountName ?? ""
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

    /// A code for this site signs in here; one for another pool opens that pool, adding it first
    /// if it's new, and signs in there.
    private func open(_ link: GuestLink) async {
        guard !link.isServer(store.serverAddress) else {
            await use(link)
            return
        }
        do {
            try await session.open(link)
        } catch {
            if !error.isCancellation {
                signInError = error.localizedDescription
            }
        }
    }

    /// Signs the guest in with its code to choose a password, which opens the set-up sheet; once
    /// it has one, fills in its name to sign in with it.
    private func use(_ link: GuestLink) async {
        accountName = link.name
        password = ""
        signInError = nil
        guard let code = link.code else {
            codeMessage = String(localized: "Sign in as \(link.name) with the password you chose.")
            passwordFocused = true
            return
        }
        codeMessage = String(localized: "Signing in as \(link.name)…")
        do {
            try await auth.signInAsGuest(name: link.name, code: code)
            codeMessage = nil
        } catch StatusClientError.server(code: 409, message: _) {
            codeMessage = String(localized: "\(link.name) has already chosen a password. Sign in with it.")
            passwordFocused = true
        } catch {
            codeMessage = nil
            if !error.isCancellation {
                signInError = error.localizedDescription
            }
        }
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

/// Every site, the open one checked, a way to add another, and the way back to the list; the
/// menu under a site's title, the same with one site as with many.
struct SiteSwitcherMenu: View {
    @Environment(SiteSession.self) private var session

    var body: some View {
        ForEach(session.sites.sites) { site in
            Button {
                session.open(site)
            } label: {
                if site.id == session.openID {
                    Label(site.name, systemImage: "checkmark")
                } else {
                    Text(site.name)
                }
            }
        }
        Divider()
        Button("Add Site…", systemImage: "plus") {
            session.isAddingSite = true
        }
        Button("All Sites", systemImage: "list.bullet") {
            session.showSites()
        }
    }
}
