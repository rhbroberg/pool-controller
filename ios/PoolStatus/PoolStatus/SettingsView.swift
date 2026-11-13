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
                serverChoices = await auth.signInChoices()
            }
            .task(id: store.serverAddress) {
                serverInfo = nil
                serverInfo = await store.systemInfo()
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

/// The accounts, the pool's location for weather, the time zone and history settings, the
/// maintenance jobs, restart and factory reset: everything an admin keeps the server running with.
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
            if store.auth.isAdmin {
                Section {
                    NavigationLink("Accounts") {
                        AccountsView()
                    }
                } footer: {
                    Text("Who can sign in, what each may do, and how they sign in.")
                }
            }

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
