import SwiftUI

/// Every recorded event, newest first, loaded a page at a time as the list scrolls.
struct EventLogView: View {
    @AppStorage("serverAddress") private var serverAddress = StatusView.defaultServerAddress
    @State private var model = EventLogModel()

    private struct FilterKey: Equatable {
        let kinds: Set<EventKind>
        let user: EventUserFilter
        let ascending: Bool
    }

    var body: some View {
        List {
            Section {
                ForEach(model.events) { event in
                    EventRow(event: event)
                        .onAppear {
                            if event.id == model.events.last?.id {
                                Task { await model.loadMore(serverAddress: serverAddress) }
                            }
                        }
                }
                if model.isLoading {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } header: {
                header
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
        .safeAreaInset(edge: .bottom, spacing: 0) {
            statusLine
        }
        .navigationTitle("Event Log")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model.reload(serverAddress: serverAddress)
            await model.loadUsers(serverAddress: serverAddress)
        }
        .task {
            await model.loadUsers(serverAddress: serverAddress)
        }
        .task(id: FilterKey(kinds: model.kinds, user: model.user, ascending: model.ascending)) {
            await model.reload(serverAddress: serverAddress)
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
                if model.kinds.count < EventKind.allCases.count {
                    Button("Show All") {
                        model.kinds = Set(EventKind.allCases)
                    }
                    .font(.footnote)
                }
            }
            WrappingLayout(spacing: 8) {
                ForEach(EventKind.allCases) { kind in
                    filterChip(kind)
                }
            }
            HStack(spacing: 8) {
                Text("User")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                userMenu
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
            .background(isOn ? kind.tint : Color(.tertiarySystemFill), in: .capsule)
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

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                model.ascending.toggle()
            } label: {
                HStack(spacing: 4) {
                    Text("Time")
                    Image(systemName: model.ascending ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.bold))
                }
                .frame(width: EventRow.timeWidth, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel(model.ascending ? "Time, oldest first" : "Time, newest first")
            .accessibilityHint("Reverses the order")
            Text("Event")
            Spacer()
        }
        .font(.footnote.weight(.semibold))
        .textCase(nil)
    }

    private var statusLine: some View {
        HStack(alignment: .firstTextBaseline) {
            if let oldest = model.oldest {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Oldest shown: \(oldest, format: .relative(presentation: .named))")
                    Text("\(oldest, format: .dateTime.month(.abbreviated).day().year().hour().minute()) · \(model.events.count) events")
                        .foregroundStyle(.secondary)
                }
            } else if model.isLoading {
                Text("Loading…")
            } else {
                Text("No events")
            }
            Spacer()
            if model.reachedEnd && !model.events.isEmpty {
                Text("All loaded")
                    .foregroundStyle(.secondary)
            } else if !model.events.isEmpty {
                Text("Scroll for more")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.footnote.monospacedDigit())
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
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
    static let timeWidth: CGFloat = 78

    let event: EventEntry

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                Text(event.timestamp, format: .dateTime.month(.abbreviated).day())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(event.timestamp, format: .dateTime.hour().minute().second())
                    .font(.caption.monospacedDigit())
            }
            .frame(width: Self.timeWidth, alignment: .leading)

            Image(systemName: event.kind.systemImage)
                .font(.subheadline)
                .foregroundStyle(event.kind.tint)
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

#Preview {
    NavigationStack {
        EventLogView()
    }
}
