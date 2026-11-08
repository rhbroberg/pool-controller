import SwiftUI

/// Every recorded event, newest first, loaded a page at a time as the list scrolls.
struct EventLogView: View {
    @Environment(StatusStore.self) private var store
    @State private var model = EventLogModel()

    private struct FilterKey: Equatable {
        let serverAddress: String
        let kinds: Set<EventKind>
        let user: EventUserFilter
        let ascending: Bool
    }

    var body: some View {
        List {
            ForEach(model.events) { event in
                EventRow(event: event)
                    .task {
                        if event.id == model.events.last?.id {
                            await model.loadMore(client: store.client)
                        }
                    }
            }
            if !model.events.isEmpty || model.isLoading {
                endRow
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.events.isEmpty && !model.isLoading {
                if model.kinds.isEmpty {
                    ContentUnavailableView("No Event Types Chosen", systemImage: "line.3.horizontal.decrease.circle",
                                           description: Text("Turn on at least one of the filters above."))
                } else if let errorMessage = model.errorMessage {
                    ContentUnavailableView("Can’t Load Events", systemImage: "wifi.exclamationmark",
                                           description: Text(errorMessage))
                } else {
                    ContentUnavailableView("No Events", systemImage: "list.bullet.rectangle",
                                           description: Text("Nothing matches these filters."))
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            filterBar
        }
        .navigationTitle("Event Log")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model.reload(client: store.client)
            await model.loadUsers(client: store.client)
        }
        .task(id: store.serverAddress) {
            await model.loadUsers(client: store.client)
        }
        .task(id: FilterKey(serverAddress: store.serverAddress, kinds: model.kinds, user: model.user,
                            ascending: model.ascending)) {
            await model.reload(client: store.client)
        }
    }

    // MARK: - Filters

    private var filterBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Show")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if model.kinds != EventLogModel.defaultKinds {
                    Button("Reset") {
                        model.kinds = EventLogModel.defaultKinds
                    }
                    .font(.footnote)
                }
            }
            WrappingLayout(spacing: 8) {
                ForEach(EventKind.allCases) { kind in
                    filterChip(kind)
                }
            }
            // side by side where they fit; a long account name puts them on separate lines
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    userMenu
                    orderMenu
                }
                VStack(alignment: .leading, spacing: 8) {
                    userMenu
                    orderMenu
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private func filterChip(_ kind: EventKind) -> some View {
        let isOn = model.kinds.contains(kind)
        return Button {
            if isOn {
                model.kinds.remove(kind)
            } else {
                model.kinds.insert(kind)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: isOn ? "checkmark" : kind.systemImage)
                    .font(.caption.weight(.bold))
                Text(kind.title)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .foregroundStyle(isOn ? Color.white : Color.secondary)
            .background(isOn ? kind.tint.color : Color(.tertiarySystemFill), in: .capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(kind.title)
        .accessibilityValue(isOn ? "Shown" : "Hidden")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    private var userMenu: some View {
        Menu {
            Picker("User", selection: $model.user) {
                Text(EventUserFilter.everyone.title).tag(EventUserFilter.everyone)
                Text(EventUserFilter.controller.title).tag(EventUserFilter.controller)
                ForEach(model.users, id: \.self) { name in
                    Text(name).tag(EventUserFilter.account(name))
                }
            }
        } label: {
            HStack(spacing: 4) {
                Label(model.user.title, systemImage: model.user == .everyone ? "person.2" : "person.fill")
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(model.user == .everyone ? Color.primary : Color.white)
            .background(model.user == .everyone ? Color(.tertiarySystemFill) : Color.accentColor, in: .capsule)
        }
        .accessibilityLabel("User: \(model.user.title)")
    }

    private var orderMenu: some View {
        Menu {
            Picker("Order", selection: $model.ascending) {
                Text("Newest First").tag(false)
                Text("Oldest First").tag(true)
            }
        } label: {
            HStack(spacing: 4) {
                Label(model.ascending ? "Oldest First" : "Newest First", systemImage: "arrow.up.arrow.down")
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(Color.primary)
            .background(Color(.tertiarySystemFill), in: .capsule)
        }
        .accessibilityLabel("Order: \(model.ascending ? "oldest first" : "newest first")")
    }

    /// The last row: loading, or how far back the list goes once there's nothing more.
    private var endRow: some View {
        HStack {
            Spacer()
            if model.isLoading {
                ProgressView()
            } else if let oldest = model.oldest {
                VStack(spacing: 2) {
                    Text("\(model.events.count) events back to \(oldest, format: .dateTime.month(.abbreviated).day().year().hour().minute())")
                    if model.reachedEnd {
                        Text("That’s everything for these filters.")
                    }
                }
                .multilineTextAlignment(.center)
            }
            Spacer()
        }
        .font(.footnote.monospacedDigit())
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
        .listRowSeparator(.hidden)
    }
}

/// Lays its subviews out left to right, starting a new line when one doesn't fit.
private struct WrappingLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = rows[rows.count - 1].indices.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
            if needed > width && !rows[rows.count - 1].indices.isEmpty {
                rows.append(Row())
            }
            var row = rows[rows.count - 1]
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

private struct EventRow: View {
    let event: EventEntry

    @ScaledMetric(relativeTo: .caption) private var timeWidth: CGFloat = 78

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                Text(event.timestamp, format: .dateTime.month(.abbreviated).day())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(event.timestamp, format: .dateTime.hour().minute().second())
                    .font(.caption.monospacedDigit())
            }
            .frame(width: timeWidth, alignment: .leading)

            Image(systemName: event.kind?.systemImage ?? "circle.dashed")
                .font(.subheadline)
                .foregroundStyle(event.kind?.tint.color ?? .secondary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(event.summary)
                    .font(.subheadline)
                if let user = event.user {
                    Text(user)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        EventLogView()
    }
    .environment(StatusStore.preview())
}
#endif
