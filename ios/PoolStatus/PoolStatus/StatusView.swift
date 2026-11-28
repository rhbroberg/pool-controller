import PoolStatusCore
import SwiftUI

/// A signed-in site's pool.
struct StatusView: View {
    /// Keeps the page readable on iPad and in landscape.
    static let maximumWidth: CGFloat = 640

    @Environment(SiteSession.self) private var session
    @Environment(StatusStore.self) private var store
    @AppStorage(SettingsKey.reconnectSeconds) private var reconnectSeconds = StatusStore.defaultReconnectSeconds
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingSettings = false
    /// Bumped to restart polling immediately, as from Retry.
    @State private var pollGeneration = 0
    /// Whether the details of the heating estimate are open.
    @State private var showingEstimate = false

    private struct PollKey: Equatable {
        let serverAddress: String
        let reconnectSeconds: Int
        let generation: Int
    }

    var body: some View {
        // Poll and live updates hang off the stack, not the dashboard root: pushing Event Log
        // (or any destination) can cancel `.task` on the covered root, which killed the socket.
        NavigationStack {
            ScrollView {
                // sized so the whole dashboard fits on one iPhone screen without scrolling
                VStack(alignment: .leading, spacing: 14) {
                    if store.connection == .disconnected {
                        OfflineBanner(host: ServerAddress.display(store.serverAddress),
                                      reason: store.connectionFailure,
                                      nextAttempt: store.nextAttempt,
                                      isRetrying: store.isLoading,
                                      retry: { pollGeneration += 1 },
                                      change: { showingSettings = true })
                    }

                    if let errorMessage = store.errorMessage, store.isConnected {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                            .cardBackground()
                    }

                    if !store.readings.isEmpty {
                        dashboard
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
                .frame(maxWidth: Self.maximumWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Color(.systemGroupedBackground))
            .safeAreaInset(edge: .top, spacing: 0) {
                if store.needsAttention {
                    CheckSystemBar()
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !store.readings.isEmpty {
                    DashboardBar(isAdmin: store.auth.isAdmin)
                }
            }
            .animation(.default, value: store.needsAttention)
            .overlay {
                if store.readings.isEmpty {
                    if store.connection == .connecting {
                        ProgressView("Connecting…")
                    } else if store.isConnected && store.errorMessage == nil {
                        ContentUnavailableView("No Readings", systemImage: "drop",
                                               description: Text("The server hasn’t recorded any status yet."))
                    }
                }
            }
            .navigationTitle(session.openSite?.name ?? SiteStore.defaultName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarTitleMenu {
                SiteSwitcherMenu()
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if store.connection != .connected {
                        ConnectionIndicator(connection: store.connection)
                    } else if !store.readings.isEmpty {
                        WeatherButton(air: store.measurement(named: .airTemperature), weather: store.weatherSummary)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "person.crop.circle") {
                        showingSettings = true
                    }
                }
            }
            .refreshable {
                await store.refresh()
            }
            .sensoryFeedback(.success, trigger: store.confirmedChanges)
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
            .sheet(isPresented: $showingEstimate) {
                HeatingEstimateView()
            }
            .navigationDestination(for: DashboardRoute.self) { route in
                switch route {
                case .thermostat(let water): ThermostatView(water: water)
                case .temperatureHistory(let water): TemperatureHistoryView(water: water)
                case .saltHistory: SaltHistoryView()
                case .equipment: EquipmentView()
                case .panel: PanelView()
                case .eventLog: EventLogView()
                case .serverMaintenance: ServerMaintenanceView()
                }
            }
        }
        .task(id: PollKey(serverAddress: store.serverAddress, reconnectSeconds: reconnectSeconds,
                          generation: pollGeneration)) {
            await store.poll(reconnectSeconds: reconnectSeconds)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                pollGeneration += 1
            }
        }
    }

    @ViewBuilder
    private var dashboard: some View {
        TemperatureCard(waters: WaterBody.allCases.map { body in
                            WaterStatus(body: body,
                                        reading: store.measurement(named: body.temperatureName),
                                        heating: store.heating?.heating(of: body))
                        },
                        lastRefresh: store.lastRefresh,
                        isConnected: store.isConnected,
                        isLive: store.isLive)

        ControlSection(title: String(localized: "Tasks")) {
            if !store.auth.canControl {
                AccessNote()
            }
            TaskRows()
        } trailing: {
            if let estimate = store.heating?.estimate, estimate.isShown {
                HeatingEstimateButton(estimate: estimate) {
                    showingEstimate = true
                }
            }
        }
        .opacity(store.isConnected ? 1 : 0.5)

        UpdateFooter(lastChange: store.lastSwitchChange)
    }
}

#if DEBUG
#Preview {
    StatusView()
        .environment(SiteSession.preview())
        .environment(StatusStore.preview())
}
#endif
