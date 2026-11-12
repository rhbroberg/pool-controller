import PoolStatusCore
import SwiftUI

/// Every pool this iPhone knows, each with its own sign-in: where sites are added, removed and
/// opened, and what the app shows when no site is open.
struct SitesView: View {
    static let reconnectChoices = [10, 30, 60, 120, 300]

    @Environment(SiteSession.self) private var session
    @AppStorage(SettingsKey.reconnectSeconds) private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @State private var editing: Site?
    @State private var removing: Site?

    private var sites: [Site] { session.sites.sites }

    var body: some View {
        NavigationStack {
            List {
                if !sites.isEmpty {
                    Section {
                        ForEach(sites) { site in
                            Button {
                                session.open(site)
                            } label: {
                                SiteRow(site: site, signedIn: session.sites.signIns[site.id])
                            }
                            .accessibilityIdentifier("site-\(site.name)")
                            .swipeActions {
                                Button("Remove", role: .destructive) { removing = site }
                                Button("Edit") { editing = site }
                                    .tint(.blue)
                            }
                            .contextMenu {
                                Button("Edit", systemImage: "pencil") { editing = site }
                                Button("Remove", systemImage: "trash", role: .destructive) { removing = site }
                            }
                        }
                    } footer: {
                        Text("Each pool keeps its own sign-in until you sign out of it or remove it.")
                    }

                    Section {
                        Picker("Retry Every", selection: $reconnectSeconds) {
                            ForEach(Self.reconnectChoices, id: \.self) { seconds in
                                Text(Duration.seconds(seconds), format: .units(allowed: [.minutes, .seconds], width: .wide))
                                    .tag(seconds)
                            }
                        }
                    } header: {
                        Text("Connection")
                    } footer: {
                        Text("How often to try a pool’s server again after losing it.")
                    }
                }
            }
            .overlay {
                if sites.isEmpty {
                    ContentUnavailableView {
                        Label("No Pools Yet", systemImage: "figure.pool.swim")
                    } description: {
                        Text("Add the server attached to your pool controller to get started.")
                    } actions: {
                        Button("Add Site") { session.isAddingSite = true }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle("Sites")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add Site", systemImage: "plus") { session.isAddingSite = true }
                }
            }
            .sheet(item: $editing) { site in
                NavigationStack {
                    SiteEditorView(site: site)
                }
            }
            .confirmationDialog("Remove \(removing?.name ?? "")?",
                                isPresented: Binding(isPresent: $removing),
                                titleVisibility: .visible,
                                presenting: removing) { site in
                Button("Remove Site", role: .destructive) {
                    session.remove(site)
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Its sign-in is deleted from this iPhone and its session on the server ends.")
            }
        }
    }
}

private struct SiteRow: View {
    let site: Site
    let signedIn: Credentials?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "figure.pool.swim")
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 32)
            // explicit colors, since a button would otherwise tint all of its label
            VStack(alignment: .leading, spacing: 2) {
                Text(site.name)
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                Text(ServerAddress.display(site.address))
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let signedIn {
                    Label("Signed in as \(signedIn.name)", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(Color.green)
                } else {
                    Label("Signed out", systemImage: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color(.tertiaryLabel))
        }
        .padding(.vertical, 2)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// A site's name and address. Changes apply on Save; removing a site asks first.
struct SiteEditorView: View {
    @Environment(SiteSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var draft: Site
    @State private var errorMessage: String?
    @State private var isScanningNetwork = false
    @State private var confirmingRemove = false

    init(site: Site) {
        _draft = State(initialValue: site)
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Name") {
                    TextField(SiteStore.defaultName, text: $draft.name)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.words)
                }
                LabeledContent("Server") {
                    HStack(spacing: 12) {
                        TextField("", text: $draft.address)
                            .accessibilityLabel("Server")
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            isScanningNetwork = true
                        } label: {
                            Image(systemName: "magnifyingglass")
                        }
                        // borderless so tapping the text field doesn't also start a scan
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Scan Network")
                    }
                }
            } footer: {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                } else {
                    Text("The server attached to this pool’s controller, with its port. Tap \(Image(systemName: "magnifyingglass")) to look for one on your network.")
                }
            }

            Section {
                Button("Remove Site", role: .destructive) {
                    confirmingRemove = true
                }
            } footer: {
                Text("Deletes this pool’s sign-in from this iPhone and ends its session on the server.")
            }
        }
        .navigationTitle(draft.name.isEmpty ? SiteStore.defaultName : draft.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
            }
        }
        .sheet(isPresented: $isScanningNetwork) {
            NetworkScanView { draft.address = $0 }
        }
        .confirmationDialog("Remove \(draft.name)?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove Site", role: .destructive) {
                dismiss()
                if let site = session.sites.site(id: draft.id) {
                    session.remove(site)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its sign-in is deleted from this iPhone and its session on the server ends.")
        }
    }

    private func save() {
        do {
            try session.update(draft)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

#if DEBUG
extension SiteSession {
    /// Two pools, one signed in, whose stores answer from canned data.
    static func preview(signedIn: Bool = true) -> SiteSession {
        let suite = "PoolStatusSitePreviews"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.removePersistentDomain(forName: suite)
        let keychain = InMemoryCredentialStore()
        let sites = SiteStore(defaults: defaults) { _ in keychain }
        let home = try? sites.add(name: "Home", address: "preview.local:3000")
        _ = try? sites.add(name: "Lake House", address: "lake.example.com")
        if signedIn {
            keychain.save(Credentials(name: "preview", token: "preview", role: .user))
        }
        let session = SiteSession(sites: sites) { _, _ in StatusStore.preview(role: signedIn ? .user : nil) }
        if let home {
            session.open(home)
        }
        return session
    }
}

#Preview("Sites") {
    let session = SiteSession.preview()
    session.showSites()
    return SitesView()
        .environment(session)
}
#endif
