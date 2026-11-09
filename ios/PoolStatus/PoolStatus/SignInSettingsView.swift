import PoolStatusCore
import SwiftUI

/// Admin: how people sign in. Passwords on or off, whether newcomers may ask to join, and the
/// OpenID Connect services offered on the sign-in form.
struct SignInSettingsView: View {
    /// The service being edited in the sheet, or a new one.
    private enum Editing: Identifiable {
        case new, existing(SignInService)

        var id: String {
            switch self {
            case .new: ""
            case .existing(let service): service.id
            }
        }
    }

    @Environment(StatusStore.self) private var store
    @State private var settings: SignInSettings?
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var editing: Editing?

    private var auth: AuthSession { store.auth }

    var body: some View {
        Form {
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            if let settings {
                Section {
                    Toggle("Password Sign-In", isOn: Binding(
                        get: { settings.passwordSignIn },
                        set: { on in Task { await apply(.init(passwordSignIn: on)) } }))
                } header: {
                    Text("Passwords")
                } footer: {
                    if settings.passwordSignInForced {
                        Text("POOL_FORCE_PASSWORD_SIGNIN=1 is set where the server runs, so passwords work whatever this says.")
                    } else {
                        Text("Turn passwords off once you’ve linked a service to your own account in Settings, so an admin can still sign in.")
                    }
                }

                Section {
                    Picker("Without an Invitation", selection: Binding(
                        get: { settings.signInRequests },
                        set: { choice in Task { await apply(.init(signInRequests: choice)) } })) {
                        Text("Ask an Admin").tag(SignInSettings.Newcomers.ask)
                        Text("Turn Away").tag(SignInSettings.Newcomers.refuse)
                    }
                } header: {
                    Text("Newcomers")
                } footer: {
                    Text(settings.signInRequests == .ask
                         ? "Someone who signs in with a service but has no account and no invitation waits in Accounts for an admin to approve them."
                         : "Only people with an account or an invitation can sign in with a service; anyone else is turned away.")
                }

                Section {
                    ForEach(settings.providers) { service in
                        Button {
                            editing = .existing(service)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(service.displayName)
                                        .foregroundStyle(.primary)
                                    Text(service.kind == .apple ? String(localized: "Sign in with Apple") : service.issuer)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(service.enabled ? "On" : "Off")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button("Add Service") {
                        editing = .new
                    }
                } header: {
                    Text("Services")
                } footer: {
                    Text("Each service needs this redirect address registered with it, with the service’s id in place of {id}: \(settings.redirectUriTemplate)")
                        .textSelection(.enabled)
                }
            } else if errorMessage == nil {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        }
        .disabled(!auth.isAdmin || isSaving)
        .navigationTitle("Sign-In")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: auth.isAdmin) {
            if auth.isAdmin {
                await load()
            }
        }
        .refreshable { await load() }
        .sheet(item: $editing) { editing in
            let service: SignInService? = if case .existing(let service) = editing { service } else { nil }
            if let settings {
                SignInServiceEditor(service: service, redirectTemplate: settings.redirectUriTemplate) {
                    Task { await load() }
                }
            }
        }
    }

    private func load() async {
        do {
            settings = try await auth.signInSettings()
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func apply(_ changes: SignInSettings.Changes) async {
        isSaving = true
        defer { isSaving = false }
        do {
            settings = try await auth.updateSignInSettings(changes)
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// Adds a service (`service` nil) or changes one.
private struct SignInServiceEditor: View {
    private enum Operation {
        case save, remove
    }

    let service: SignInService?
    let redirectTemplate: String
    let saved: () -> Void

    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var preset = SignInServicePreset.all[0]
    @State private var id = ""
    @State private var displayName = ""
    @State private var kind = SignInService.Kind.oidc
    @State private var issuer = ""
    @State private var clientId = ""
    @State private var clientSecret = ""
    @State private var teamId = ""
    @State private var keyId = ""
    @State private var privateKey = ""
    @State private var trustEmail = false
    @State private var enabled = true
    @State private var operation: Operation?
    @State private var confirmingRemove = false
    @State private var errorMessage: String?

    private var adding: Bool { service == nil }
    private var isApple: Bool { kind == .apple }
    private var trimmedId: String { id.trimmingCharacters(in: .whitespaces).lowercased() }
    private var canSave: Bool {
        !trimmedId.isEmpty && !displayName.trimmingCharacters(in: .whitespaces).isEmpty && !clientId.isEmpty &&
            (isApple || !issuer.isEmpty) && (!adding || !isApple || (!teamId.isEmpty && !keyId.isEmpty && !privateKey.isEmpty))
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                if adding {
                    Section {
                        Picker("Service", selection: $preset) {
                            ForEach(SignInServicePreset.all) { preset in
                                Text(preset.isOther ? String(localized: "Other OpenID Connect") : preset.displayName).tag(preset)
                            }
                        }
                    } footer: {
                        if preset.isOther {
                            Text("Any service that supports OpenID Connect discovery, such as Auth0, Okta, Keycloak or Authentik.")
                        }
                    }
                }
                Section {
                    if adding {
                        LabeledContent("ID") {
                            TextField("such as auth0", text: $id)
                                .multilineTextAlignment(.trailing)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    LabeledContent("Name") {
                        TextField("shown on the button", text: $displayName)
                            .multilineTextAlignment(.trailing)
                    }
                    if !isApple {
                        LabeledContent("Issuer") {
                            TextField("https://…", text: $issuer)
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                } footer: {
                    if !trimmedId.isEmpty {
                        Text("Register this redirect address with the service: \(redirectTemplate.replacingOccurrences(of: "{id}", with: trimmedId))")
                            .textSelection(.enabled)
                    }
                }
                Section {
                    LabeledContent(isApple ? "Services ID" : "Client ID") {
                        TextField("", text: $clientId)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    if isApple {
                        LabeledContent("Team ID") {
                            TextField("", text: $teamId).multilineTextAlignment(.trailing).autocorrectionDisabled()
                        }
                        LabeledContent("Key ID") {
                            TextField("", text: $keyId).multilineTextAlignment(.trailing).autocorrectionDisabled()
                        }
                        TextField(service?.apple?.hasPrivateKey == true ? "Saved; paste a new key to replace it" : "-----BEGIN PRIVATE KEY-----",
                                  text: $privateKey, axis: .vertical)
                            .font(.caption.monospaced())
                            .lineLimit(3...8)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else {
                        LabeledContent("Client Secret") {
                            SecureField(service?.hasClientSecret == true ? "Saved" : "", text: $clientSecret)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                } header: {
                    Text(isApple ? "Apple Developer" : "Client")
                } footer: {
                    if isApple {
                        Text("The Services ID, your team ID, and a Sign in with Apple key: its key ID and the contents of its .p8 file.")
                    } else if service?.hasClientSecret == true {
                        Text("Leave the secret empty to keep the one saved.")
                    } else {
                        Text("From the app or client registered with the service.")
                    }
                }
                Section {
                    Toggle("Trust Email Addresses", isOn: $trustEmail)
                    Toggle("Offer on the Sign-In Form", isOn: $enabled)
                } footer: {
                    Text(trustEmail
                         ? "An invitation is redeemed by the first sign-in with its email address, if the service says the address is verified."
                         : "Invitations don’t work with this service; newcomers wait for approval. Turn this on only for services that verify email addresses.")
                }
                if !adding {
                    Section {
                        Button("Remove Service", role: .destructive) {
                            confirmingRemove = true
                        }
                    }
                }
            }
            .disabled(operation != nil)
            .navigationTitle(service?.displayName ?? String(localized: "Add Service"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if operation != nil {
                        ProgressView()
                    } else {
                        Button("Save") { start(.save) }
                            .disabled(!canSave)
                    }
                }
            }
            .confirmationDialog("Remove \(service?.displayName ?? "")?", isPresented: $confirmingRemove, titleVisibility: .visible) {
                Button("Remove Service", role: .destructive) { start(.remove) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Its button leaves the sign-in form. Accounts that only sign in with it can’t sign in until it’s added back with the same id.")
            }
        }
        .onAppear(perform: fill)
        .onChange(of: preset) { _, preset in
            id = preset.id
            displayName = preset.displayName
            kind = preset.kind
            issuer = preset.issuer
            trustEmail = preset.trustEmail
        }
        .task(id: operation) {
            if let operation {
                await perform(operation)
            }
        }
    }

    private func fill() {
        if let service {
            id = service.id
            displayName = service.displayName
            kind = service.kind
            issuer = service.issuer
            clientId = service.clientId
            teamId = service.apple?.teamId ?? ""
            keyId = service.apple?.keyId ?? ""
            trustEmail = service.trustEmail
            enabled = service.enabled
        } else {
            id = preset.id
            displayName = preset.displayName
            kind = preset.kind
            issuer = preset.issuer
            trustEmail = preset.trustEmail
        }
    }

    private func start(_ operation: Operation) {
        errorMessage = nil
        self.operation = operation
    }

    private var change: SignInServiceChange {
        let trim = { (text: String) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
        return SignInServiceChange(
            id: adding ? trimmedId : nil,
            displayName: trim(displayName),
            kind: adding ? kind : nil,
            issuer: isApple ? nil : trim(issuer),
            clientId: trim(clientId),
            clientSecret: clientSecret.isEmpty ? nil : clientSecret,
            apple: isApple ? .init(teamId: trim(teamId), keyId: trim(keyId), privateKey: trim(privateKey).isEmpty ? nil : trim(privateKey)) : nil,
            enabled: enabled,
            trustEmail: trustEmail)
    }

    private func perform(_ operation: Operation) async {
        do {
            switch operation {
            case .save:
                if let service {
                    _ = try await store.auth.updateSignInService(service.id, change)
                } else {
                    _ = try await store.auth.createSignInService(change)
                }
            case .remove:
                if let service {
                    try await store.auth.deleteSignInService(service.id)
                }
            }
            saved()
            dismiss()
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        self.operation = nil
    }
}
