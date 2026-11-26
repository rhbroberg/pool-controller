import PoolStatusCore
import SwiftUI

/// The open site's settings: its name and address, and the account signed in to it. The event
/// log and server maintenance open from the dashboard's bottom row.
struct SettingsView: View {
    private enum Route: Hashable {
        case site, changePassword, signInMethods
    }

    @Environment(SiteSession.self) private var session
    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// nil from a server too old to have sign-in services.
    @State private var serverChoices: SignInChoices?
    /// The server's build, for the about line; nil until it answers.
    @State private var serverInfo: SystemInfo?

    private var auth: AuthSession { store.auth }
    private var choices: SignInChoices { serverChoices ?? .passwordOnly }

    var body: some View {
        NavigationStack {
            Form {
                // kept to few sections so Administration stays on screen without scrolling
                Section {
                    NavigationLink(value: Route.site) {
                        LabeledContent(session.openSite?.name ?? SiteStore.defaultName,
                                       value: ServerAddress.display(store.serverAddress))
                    }
                } header: {
                    Text("Pool")
                }

                Section {
                    if let credentials = auth.credentials {
                        LabeledContent("Signed In") {
                            if let role = credentials.role {
                                Text("\(credentials.name) · \(role.title)")
                            } else {
                                Text(credentials.name)
                            }
                        }
                        if !choices.providers.isEmpty {
                            NavigationLink(value: Route.signInMethods) {
                                LabeledContent("Sign-In Methods",
                                               value: signInMethodNames(auth.methods, services: choices.providers).joined(separator: ", "))
                            }
                        } else if auth.hasPassword {
                            NavigationLink("Change Password", value: Route.changePassword)
                        }
                        Button("Sign Out", role: .destructive) {
                            dismiss()
                            auth.signOut()
                        }
                    }
                } header: {
                    Text("Account")
                } footer: {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("You stay signed in to this pool on this iPhone until you sign out.")
                        Text(SystemInfo.aboutLine(appCommit: Bundle.main.object(forInfoDictionaryKey: "PoolGitCommit") as? String,
                                                  server: serverInfo))
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .site:
                    if let site = session.openSite {
                        SiteEditorView(site: site)
                    }
                case .changePassword: ChangePasswordView()
                case .signInMethods: SignInMethodsView(providers: choices.providers)
                }
            }
            .task(id: store.serverAddress) {
                serverInfo = nil
                async let choices = auth.signInChoices()
                async let info = store.systemInfo()
                serverChoices = await choices
                serverInfo = await info
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // every change applies as it's made, so there's nothing for a Cancel to undo
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
