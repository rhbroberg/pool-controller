import PoolStatusCore
import SwiftUI

/// The pages the dashboard links to.
enum DashboardRoute: Hashable {
    case thermostat(WaterBody)
    case temperatureHistory(WaterBody)
    case saltHistory
    case equipment
    case panel
    case eventLog
    case serverMaintenance
}

/// Shown above controls a view-only account can't use.
struct AccessNote: View {
    var body: some View {
        Label("View only. Your account can see equipment but not change it.", systemImage: "eye")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A titled group of controls, with an optional link at the trailing end of the title.
struct ControlSection<Content: View, Trailing: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.headline)
                Spacer()
                trailing
            }
            .padding(.horizontal, 4)
            VStack(spacing: 8) {
                content
            }
        }
    }
}

extension ControlSection where Trailing == EmptyView {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, content: content, trailing: { EmptyView() })
    }
}

/// The pages the dashboard opens, as a row of icons along the bottom: the equipment, the
/// controller's own menus, the event log, and for admins, server maintenance.
struct DashboardBar: View {
    let isAdmin: Bool

    @ScaledMetric(relativeTo: .title3) private var iconHeight: CGFloat = 26

    var body: some View {
        HStack(spacing: 0) {
            item(.equipment, systemImage: "switch.2", title: String(localized: "Equipment"))
            item(.panel, systemImage: "dpad", title: String(localized: "Remote Menu"))
            item(.eventLog, systemImage: "list.bullet.rectangle", title: String(localized: "Event Log"))
            if isAdmin {
                item(.serverMaintenance, systemImage: "wrench.and.screwdriver", title: String(localized: "Maintenance"))
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 4)
        .frame(maxWidth: StatusView.maximumWidth)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .overlay(alignment: .top) {
            Divider()
        }
    }

    private func item(_ route: DashboardRoute, systemImage: String, title: String) -> some View {
        NavigationLink(value: route) {
            VStack(spacing: 3) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .frame(height: iconHeight)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(Color.accentColor)
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// A page another page opens, such as the salt history, with the reading it's about, if any,
/// beside the chevron.
struct DashboardLink: View {
    let route: DashboardRoute
    let systemImage: String
    let title: String
    let subtitle: String
    var value: String?

    @ScaledMetric(relativeTo: .title3) private var iconSize: CGFloat = 36

    var body: some View {
        NavigationLink(value: route) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: iconSize, height: iconSize)
                    .background(Color.accentColor, in: .rect(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                if let value {
                    Text(value)
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                }
                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .cardBackground(cornerRadius: Card.tileCornerRadius)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

struct ConnectionIndicator: View {
    let connection: StatusStore.Connection

    private var title: String {
        switch connection {
        case .connecting: String(localized: "Connecting")
        case .connected: String(localized: "Connected")
        case .disconnected: String(localized: "Offline")
        }
    }

    private var color: Color {
        switch connection {
        case .connecting: .gray
        case .connected: .green
        case .disconnected: .red
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(title)
                .font(.subheadline)
                .fixedSize()
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Server \(title)")
    }
}

/// One line: which server can't be reached, with ways to change it or try again.
struct OfflineBanner: View {
    let host: String
    let reason: String?
    let nextAttempt: Date?
    let isRetrying: Bool
    let retry: () -> Void
    let change: () -> Void

    var body: some View {
        // one line when the whole address fits beside the buttons, otherwise the buttons go
        // underneath, so the address is never cut short
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                message
                Spacer(minLength: 4)
                buttons
            }
            VStack(alignment: .leading, spacing: 10) {
                message
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    buttons
                }
            }
        }
        .padding(12)
        .cardBackground()
    }

    private var message: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Can’t reach \(host)")
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if isRetrying {
                    Text("Reconnecting…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let nextAttempt, nextAttempt > .now {
                    Text("Retrying in \(Text(timerInterval: Date.now...nextAttempt, countsDown: true))")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([String(localized: "Can’t reach \(host)."), reason, String(localized: "Retries automatically.")]
            .compactMap(\.self).joined(separator: " "))
    }

    @ViewBuilder
    private var buttons: some View {
        Button("Change", action: change)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
        if isRetrying {
            ProgressView()
                .controlSize(.small)
                .frame(minWidth: 52)
        } else {
            Button("Retry", action: retry)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .fixedSize()
        }
    }
}

struct CheckSystemBar: View {
    private static let amber = Color(red: 1.0, green: 0.75, blue: 0.0)

    var body: some View {
        Label("Check System", systemImage: "exclamationmark.triangle.fill")
            .font(.headline)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Self.amber, ignoresSafeAreaEdges: [])
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityLabel("Check system: the controller reports a fault")
    }
}

struct UpdateFooter: View {
    let lastChange: Date?

    var body: some View {
        if let lastChange {
            Text("Equipment last changed \(lastChange, format: .relative(presentation: .named))")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
        }
    }
}
