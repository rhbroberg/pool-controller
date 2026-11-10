import Foundation
import Observation

/// `GET /events`
public nonisolated struct EventPage: Decodable, Sendable {
    public let events: [EventEntry]
    public let next: String?
}

public nonisolated struct EventEntry: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let timestamp: Date
    public let type: String
    public let user: String?
    public let summary: String

    /// Nil for a type this app doesn't know yet.
    public var kind: EventKind? { EventKind(serverType: type) }
}

/// The event log's filter buttons, each covering one or more of the server's event types.
public nonisolated enum EventKind: String, CaseIterable, Identifiable, Sendable {
    case equipment, readings, keypad, actions, protocolErrors

    public var id: String { rawValue }

    /// The kinds made from controller frames, which can be read again; actions come from accounts.
    public static let reprocessable: [EventKind] = [.equipment, .readings, .keypad, .protocolErrors]

    public init?(serverType: String) {
        guard let kind = Self.allCases.first(where: { $0.serverTypes.contains(serverType) }) else {
            return nil
        }
        self = kind
    }

    public var serverTypes: [String] {
        switch self {
        case .equipment: ["status"]
        case .readings: ["info"]
        case .keypad: ["control"]
        case .actions: ["action"]
        case .protocolErrors: ["failed", "unrecognized"]
        }
    }

    public var title: String {
        switch self {
        case .equipment: String(localized: "Equipment", bundle: .module)
        case .readings: String(localized: "Readings", bundle: .module)
        case .keypad: String(localized: "Panel Keys", bundle: .module)
        case .actions: String(localized: "User Actions", bundle: .module)
        case .protocolErrors: String(localized: "Communication Errors", bundle: .module)
        }
    }

    public var systemImage: String {
        switch self {
        case .equipment: "switch.2"
        case .readings: "thermometer.medium"
        case .keypad: "keyboard"
        case .actions: "person.fill"
        case .protocolErrors: "exclamationmark.triangle"
        }
    }

    public var tint: Tint {
        switch self {
        case .equipment: .blue
        case .readings: .teal
        case .keypad: .indigo
        case .actions: .green
        case .protocolErrors: .orange
        }
    }
}

/// Who an event came from, for the user filter.
public enum EventUserFilter: Hashable {
    case everyone
    /// Events the controller produced on its own, with no account.
    case controller
    case account(String)

    /// The server's `user` parameter.
    public var query: String? {
        switch self {
        case .everyone: nil
        case .controller: "controller"
        case .account(let name): name
        }
    }

    public var title: String {
        switch self {
        case .everyone: String(localized: "All Users", bundle: .module)
        case .controller: String(localized: "Controller", bundle: .module)
        case .account(let name): name
        }
    }
}

/// The event log, fetched a page at a time as the list scrolls.
@Observable
public final class EventLogModel {
    public static let pageSize = 50

    public private(set) var events: [EventEntry] = []
    public private(set) var users: [String] = []
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    /// The server has no more events for these filters.
    public private(set) var reachedEnd = false

    /// Starts on what people did and what the equipment did; readings change often enough to
    /// bury those, and communication errors are for diagnosing the connection.
    public static let defaultKinds: Set<EventKind> = [.equipment, .actions]

    public var kinds = EventLogModel.defaultKinds
    public var user = EventUserFilter.everyone
    /// Oldest first rather than newest first.
    public var ascending = false

    private var cursor: String?
    /// Bumped on every reload, so a page that arrives after the filters change is dropped.
    private var generation = 0

    public init() {}

    public var oldest: Date? {
        events.map(\.timestamp).min()
    }

    /// Starts over from the first page, as after a filter or sort change.
    public func reload(client: StatusClient) async {
        generation += 1
        events = []
        cursor = nil
        reachedEnd = kinds.isEmpty
        errorMessage = nil
        isLoading = false
        await loadMore(client: client)
    }

    /// Fetches the next page, unless one is loading or there are no more.
    public func loadMore(client: StatusClient) async {
        guard !isLoading, !reachedEnd else {
            return
        }
        isLoading = true
        let started = generation
        defer {
            if started == generation {
                isLoading = false
            }
        }
        do {
            let page = try await client.fetchEvents(
                types: kinds.flatMap(\.serverTypes), user: user.query, cursor: cursor,
                ascending: ascending, limit: Self.pageSize)
            guard started == generation else {
                return
            }
            let known = Set(events.map(\.id))
            events.append(contentsOf: page.events.filter { !known.contains($0.id) })
            cursor = page.next
            reachedEnd = page.next == nil
            errorMessage = nil
        } catch {
            if started == generation && !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    public func loadUsers(client: StatusClient) async {
        if let fetched = try? await client.fetchEventUsers() {
            users = fetched
        }
    }
}
