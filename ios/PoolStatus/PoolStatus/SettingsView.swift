import AuthenticationServices
import PoolStatusCore
import SwiftUI

struct SettingsView: View {
    static let reconnectChoices = [10, 30, 60, 120, 300]

    private enum Route: Hashable {
        case changePassword, signInMethods, eventLog, accounts, serverMaintenance
    }

    @Environment(StatusStore.self) private var store
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @AppStorage(SettingsKey.reconnectSeconds) private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @AppStorage(SettingsKey.poolName) private var poolName = StatusView.defaultPoolName
    @Environment(\.dismiss) private var dismiss
    @State private var draftAddress = ""
    @State private var draftPoolName = ""
    @State private var accountName = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @State private var signInError: String?
    @State private var isScanningNetwork = false
    @FocusState private var passwordFocused: Bool
    /// nil from a server too old to have sign-in services.
    @State private var serverChoices: SignInChoices?
    /// The service whose sign-in page is open.
    @State private var signingInWith: SignInProvider?
    /// What signing in with a service ended with, when it didn't simply sign in.
    @State private var serviceMessage: String?
    @State private var serviceFailed = false
    /// The server's build, for the about line; nil until it answers.
    @State private var serverInfo: SystemInfo?

    private var auth: AuthSession { store.auth }
    private var choices: SignInChoices { serverChoices ?? .passwordOnly }

    private var trimmedAddress: String {
        draftAddress.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                // kept to few sections so Administration stays on screen without scrolling
                Section {
                    LabeledContent("Name") {
                        TextField(StatusView.defaultPoolName, text: $draftPoolName)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.done)
                    }
                    LabeledContent("Server") {
                        HStack(spacing: 12) {
                            TextField("", text: $draftAddress)
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
                    Picker("Retry Every", selection: $reconnectSeconds) {
                        ForEach(Self.reconnectChoices, id: \.self) { seconds in
                            Text(Duration.seconds(seconds), format: .units(allowed: [.minutes, .seconds], width: .wide))
                                .tag(seconds)
                        }
                    }
                } header: {
                    Text("Pool")
                } footer: {
                    Text("The server attached to your pool controller, with its port. Tap \(Image(systemName: "magnifyingglass")) to look for one on your network.")
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
                            auth.signOut()
                        }
                    } else {
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
                                store.serverAddress = trimmedAddress
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
                            .disabled(trimmedAddress.isEmpty || signingInWith != nil)
                        }
                    }
                } header: {
                    Text("Account")
                } footer: {
                    if let signInError {
                        Text(signInError).foregroundStyle(.red)
                    } else if auth.credentials == nil, let serviceMessage {
                        Text(serviceMessage).foregroundStyle(serviceFailed ? .red : .secondary)
                    } else if auth.credentials == nil {
                        Text("Signing in lets you change equipment, water flow and the controller’s settings. Status is visible without an account.")
                    }
                }

                Section {
                    NavigationLink("Event Log", value: Route.eventLog)
                    if auth.isAdmin {
                        NavigationLink("Accounts", value: Route.accounts)
                        NavigationLink("Server Maintenance", value: Route.serverMaintenance)
                    }
                } header: {
                    Text(auth.isAdmin ? "History & Administration" : "History")
                } footer: {
                    Text(SystemInfo.aboutLine(appCommit: Bundle.main.object(forInfoDictionaryKey: "PoolGitCommit") as? String,
                                              server: serverInfo))
                }
            }
            .navigationTitle("Settings")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .changePassword: ChangePasswordView()
                case .signInMethods: SignInMethodsView(providers: choices.providers)
                case .eventLog: EventLogView()
                case .accounts: AccountsView()
                case .serverMaintenance: ServerMaintenanceView()
                }
            }
            .task(id: store.serverAddress) {
                serverChoices = await auth.signInChoices()
            }
            .task(id: store.serverAddress) {
                serverInfo = nil
                serverInfo = await store.systemInfo()
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
            .sheet(isPresented: $isScanningNetwork) {
                NetworkScanView { draftAddress = $0 }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // every change applies: the picker and sign-in at once, the text fields on Done
                // or when the sheet is swiped away, so there's nothing for a Cancel to undo
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                draftAddress = store.serverAddress
                draftPoolName = poolName
            }
        }
        .task(id: isSigningIn) {
            if isSigningIn {
                await signIn()
            }
        }
        .onDisappear(perform: commitDrafts)
    }

    private func commitDrafts() {
        if !trimmedAddress.isEmpty {
            store.serverAddress = trimmedAddress
        }
        let name = draftPoolName.trimmingCharacters(in: .whitespacesAndNewlines)
        poolName = name.isEmpty ? StatusView.defaultPoolName : name
    }

    private var canSignIn: Bool {
        !accountName.isEmpty && !password.isEmpty && !trimmedAddress.isEmpty && !isSigningIn
    }

    private func startPasswordSignIn() {
        guard canSignIn else {
            return
        }
        signInError = nil
        // signing in is to the server being typed, so it takes effect now rather than on Done
        store.serverAddress = trimmedAddress
        isSigningIn = true
    }

    private func signIn() async {
        do {
            try await auth.signIn(name: accountName.trimmingCharacters(in: .whitespacesAndNewlines),
                                  password: password)
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

/// The pool's location for weather, the time zone and history settings, the maintenance jobs,
/// restart and factory reset, kept off the main Settings page because they affect the server
/// rather than this app.
struct ServerMaintenanceView: View {
    private enum Operation {
        case restart, factoryReset
    }

    @Environment(StatusStore.self) private var store
    @State private var confirmingRestart = false
    @State private var confirmingReset = false
    /// The operation under way; leaving the page cancels it.
    @State private var operation: Operation?
    @State private var message: String?
    @State private var settings: ServerSettings?
    @State private var jobs: [MaintenanceJob] = []
    /// Settings or jobs that couldn't be read or changed.
    @State private var settingsError: String?
    @State private var runningJob: String?
    /// The zip code being typed; nil shows the saved one.
    @State private var zipDraft: String?
    @State private var savingZip = false
    @State private var locationError: String?
    @FocusState private var zipFocused: Bool

    var body: some View {
        Form {
            if let settings {
                locationSection(settings)

                Section {
                    NavigationLink {
                        TimeZonePicker(settings: settings) { choice in
                            Task { await apply(.init(timeZone: choice)) }
                        }
                    } label: {
                        LabeledContent("Time Zone", value: settings.timeZone)
                    }
                    Picker("Keep Raw History", selection: Binding(
                        get: { settings.rawRetentionDays },
                        set: { days in Task { await apply(.init(rawRetentionDays: days)) } })) {
                        ForEach(retentionChoices(settings), id: \.self) { days in
                            Text(Self.retentionTitle(days)).tag(days)
                        }
                    }
                } header: {
                    Text("History")
                } footer: {
                    Text(historyFooter(settings))
                }

                // a server too old to estimate doesn't say
                if let display = settings.heatingEstimateDisplay {
                    Section {
                        Picker("Show Heating As", selection: Binding(
                            get: { display },
                            set: { choice in Task { await apply(.init(heatingEstimateDisplay: choice)) } })) {
                            ForEach(HeatingEstimate.Display.allCases) { choice in
                                Text(choice.title).tag(choice)
                            }
                        }
                    } header: {
                        Text("Heating Estimates")
                    } footer: {
                        Text("How every app shows when the water will be warm: the time left, or the time of day it will be ready.")
                    }
                }
            }

            if !jobs.isEmpty {
                Section {
                    ForEach(jobs) { job in
                        jobRow(job)
                    }
                } header: {
                    Text("Maintenance Jobs")
                } footer: {
                    Text("These run on their own. Run Now brings them up to date straight away.")
                }
            }

            if store.auth.isAdmin {
                Section {
                    NavigationLink("Heating Estimates") {
                        HeatingEstimatesView()
                    }
                    NavigationLink("Reprocess History") {
                        ReprocessHistoryView()
                    }
                } footer: {
                    Text("Heating Estimates teaches the server how long the water takes to warm from its history. Reprocess History reads stored history again with the server’s current decoding, as after a fix to how it reads the controller.")
                }
            }

            if let settingsError {
                Section {
                    Label(settingsError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }

            Section {
                Button("Restart Server") {
                    confirmingRestart = true
                }
            } footer: {
                Text("The server stops and its container starts it again. The app reconnects when it’s back.")
            }

            Section {
                Button("Factory Reset", role: .destructive) {
                    confirmingReset = true
                }
                .foregroundStyle(.red)
            } footer: {
                Text("Erases all history and accounts on the server and recreates the \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) account.")
            }

            if let message {
                Section {
                    Text(message)
                }
            } else if store.auth.credentials == nil {
                Section {
                    Text("Sign in to restart or reset the server.")
                        .foregroundStyle(.secondary)
                }
            }        }
        .disabled(!store.auth.isAdmin || operation != nil)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Server Maintenance")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Restart the server?", isPresented: $confirmingRestart, titleVisibility: .visible) {
            Button("Restart Server") {
                start(.restart)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Status, equipment changes and panel keys stop for everyone until it’s back, usually within a minute.")
        }
        .confirmationDialog("Are you sure?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Factory Reset", role: .destructive) {
                start(.factoryReset)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases all history and accounts on the server and recreates the \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) account. It can’t be undone.")
        }
        .task(id: operation) {
            if let operation {
                await perform(operation)
            }
        }
        .task(id: store.auth.isAdmin) {
            if store.auth.isAdmin {
                await loadSettings()
            }
        }        .refreshable {
            await loadSettings()
        }
    }

    private func locationSection(_ settings: ServerSettings) -> some View {
        let saved = settings.location?.zipCode ?? ""
        let draft = zipDraft ?? saved
        let trimmed = draft.trimmingCharacters(in: .whitespaces)
        let canSave = trimmed != saved && ServerSettings.isZipCode(trimmed) && !savingZip
        return Section {
            HStack {
                TextField("Zip Code", text: Binding(
                    get: { draft },
                    set: { zipDraft = $0; locationError = nil }), prompt: Text(verbatim: "32801"))
                    .keyboardType(.numbersAndPunctuation)
                    .textContentType(.postalCode)
                    .autocorrectionDisabled()
                    .focused($zipFocused)
                    .submitLabel(.done)
                    .onSubmit {
                        if canSave {
                            Task { await saveZip(.code(trimmed)) }
                        }
                    }
                if savingZip {
                    ProgressView()
                } else {
                    Button("Save") {
                        Task { await saveZip(.code(trimmed)) }
                    }
                    .buttonStyle(.borderless)
                    .disabled(!canSave)
                }
            }
            if let location = settings.location {
                LabeledContent("Place", value: location.placeName)
                Button("Stop Fetching Weather", role: .destructive) {
                    Task { await saveZip(.clear) }
                }
                .disabled(savingZip)
            }
        } header: {
            Text("Location")
        } footer: {
            if let locationError {
                Text(locationError)
                    .foregroundStyle(.orange)
            } else if settings.location != nil {
                Text("The server fetches the forecast for this zip code every half hour, shows today’s on the main page and keeps the conditions with the water temperature history.")
            } else {
                Text("Give the pool’s zip code to show today’s forecast on the main page. Weather comes from Open-Meteo.")
            }
        }
    }

    /// A zip code is looked up by the server before it answers.
    private func saveZip(_ choice: ServerSettings.Changes.ZipCodeChoice) async {
        zipFocused = false
        savingZip = true
        locationError = nil
        defer { savingZip = false }
        do {
            settings = try await store.updateServerSettings(.init(zipCode: choice))
            zipDraft = nil
            jobs = (try? await store.maintenanceJobs()) ?? jobs
        } catch {
            if !error.isCancellation {
                locationError = error.localizedDescription
            }
        }
    }

    private func jobRow(_ job: MaintenanceJob) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(job.title)
                if let finished = job.lastFinishedAt {
                    Text(job.failed
                         ? String(localized: "Failed \(finished, format: .relative(presentation: .named)): \(job.lastError ?? "")")
                         : String(localized: "Ran \(finished, format: .relative(presentation: .named))"))
                        .font(.caption)
                        .foregroundStyle(job.failed ? Color.orange : .secondary)
                } else {
                    Text("Hasn’t run yet")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let summary = job.lastSummary {
                    Text(summary)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 8)
            if runningJob == job.name || job.running {
                ProgressView()
            } else {
                Button("Run Now") {
                    Task { await run(job) }
                }
                .buttonStyle(.borderless)
                .disabled(runningJob != nil)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func historyFooter(_ settings: ServerSettings) -> String {
        let zone = switch settings.timeZoneSource {
        case .configured: String(localized: "Days start at midnight in this time zone, which an admin chose.")
        case .system: String(localized: "Days start at midnight in this time zone, the server’s own.")
        case .default: String(localized: "The server couldn’t find its time zone, so days start at midnight UTC. Choose the pool’s time zone.")
        }
        let retention = String(localized: "Raw history older than this is removed; graphs keep showing it from hourly and daily summaries.")
        return "\(zone) \(retention)"
    }

    private func retentionChoices(_ settings: ServerSettings) -> [Int] {
        let usual = [30, 90, 180, 365, 730, 1095, 1825, 3650]
            .filter { $0 >= settings.minimumRetentionDays && $0 <= settings.maximumRetentionDays }
        return Array(Set(usual + [settings.rawRetentionDays])).sorted()
    }

    static func retentionTitle(_ days: Int) -> String {
        if days % 365 == 0 {
            return String(localized: "\(days / 365) years")
        }
        if days % 30 == 0 {
            return String(localized: "\(days / 30) months")
        }
        return String(localized: "\(days) days")
    }

    private func loadSettings() async {
        do {
            async let loadedSettings = store.serverSettings()
            async let loadedJobs = store.maintenanceJobs()
            settings = try await loadedSettings
            jobs = try await loadedJobs
            settingsError = nil
        } catch {
            if !error.isCancellation {
                settingsError = error.localizedDescription
            }
        }
    }

    private func apply(_ changes: ServerSettings.Changes) async {
        do {
            settings = try await store.updateServerSettings(changes)
            settingsError = nil
            // a new time zone redoes the daily summaries, which shows in the jobs
            jobs = (try? await store.maintenanceJobs()) ?? jobs
        } catch {
            if !error.isCancellation {
                settingsError = error.localizedDescription
            }
        }
    }

    private func run(_ job: MaintenanceJob) async {
        runningJob = job.name
        defer { runningJob = nil }
        do {
            let ran = try await store.runMaintenanceJob(job.name)
            jobs = jobs.map { $0.name == ran.name ? ran : $0 }
            settingsError = ran.more == true
                ? String(localized: "\(ran.title) has more to do and carries on by itself.")
                : nil
        } catch {
            if !error.isCancellation {
                settingsError = error.localizedDescription
            }
        }
    }

    private func start(_ operation: Operation) {
        message = nil
        self.operation = operation
    }

    private func perform(_ operation: Operation) async {
        do {
            switch operation {
            case .restart:
                try await store.restartServer()
                message = String(localized: "The server is restarting. The app reconnects when it’s back.")
            case .factoryReset:
                _ = try await store.factoryReset()
                message = String(localized: "Factory reset complete. Sign in as \(CommissioningView.defaultAdmin) / \(CommissioningView.defaultAdmin) to set up the server.")
            }
        } catch {
            if !error.isCancellation {
                message = error.localizedDescription
            }
        }
        self.operation = nil
    }
}
