import Foundation
import Observation
import SwiftUI

/// `GET /events`
struct EventPage: Decodable {
    let events: [EventEntry]
    let next: String?
}

struct EventEntry: Decodable, Identifiable, Hashable {
    let id: String
    let timestamp: Date
    let type: String
    let user: String?
    let summary: String

    var kind: EventKind { EventKind(serverType: type) }
}

/// The event log's filter buttons, each covering one or more of the server's event types.
enum EventKind: String, CaseIterable, Identifiable {
    case equipment, readings, keypad, actions, protocolErrors

    var id: String { rawValue }

    init(serverType: String) {
        self = Self.allCases.first { $0.serverTypes.contains(serverType) } ?? .protocolErrors
    }

    var serverTypes: [String] {
        switch self {
        case .equipment: ["status"]
        case .readings: ["info"]
        case .keypad: ["control"]
        case .actions: ["action"]
        case .protocolErrors: ["failed", "unrecognized"]
        }
    }

    var title: String {
        switch self {
        case .equipment: "Equipment"
        case .readings: "Readings"
        case .keypad: "Panel Keys"
        case .actions: "User Actions"
        case .protocolErrors: "Communication Errors"
        }
    }

    var systemImage: String {
        switch self {
        case .equipment: "switch.2"
        case .readings: "thermometer.medium"
        case .keypad: "keyboard"
        case .actions: "person.fill"
        case .protocolErrors: "exclamationmark.triangle"
        }
    }

    var tint: Color {
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
enum EventUserFilter: Hashable {
    case everyone
    /// Events the controller produced on its own, with no account.
    case controller
    case account(String)

    /// The server's `user` parameter.
    var query: String? {
        switch self {
        case .everyone: nil
        case .controller: "controller"
        case .account(let name): name
        }
    }

    var title: String {
        switch self {
        case .everyone: "All Users"
        case .controller: "Controller"
        case .account(let name): name
        }
    }
}

/// The event log, fetched a page at a time as the list scrolls.
@Observable
final class EventLogModel {
    static let pageSize = 50

    private(set) var events: [EventEntry] = []
    private(set) var users: [String] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// The server has no more events for these filters.
    private(set) var reachedEnd = false

    /// Starts on what people did and what the equipment did; readings change often enough to
    /// bury those, and communication errors are for diagnosing the connection.
    static let defaultKinds: Set<EventKind> = [.equipment, .actions]

    var kinds = EventLogModel.defaultKinds
    var user = EventUserFilter.everyone
    /// Oldest first rather than newest first.
    var ascending = false

    private var cursor: String?
    /// Bumped on every reload, so a page that arrives after the filters change is dropped.
    private var generation = 0

    var oldest: Date? {
        events.map(\.timestamp).min()
    }

    /// Starts over from the first page, as after a filter or sort change.
    func reload(serverAddress: String) async {
        generation += 1
        events = []
        cursor = nil
        reachedEnd = kinds.isEmpty
        errorMessage = nil
        isLoading = false
        await loadMore(serverAddress: serverAddress)
    }

    /// Fetches the next page, unless one is loading or there are no more.
    func loadMore(serverAddress: String) async {
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
            let page = try await StatusClient(serverAddress: serverAddress).fetchEvents(
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
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch {
            if started == generation {
                errorMessage = error.localizedDescription
            }
        }
    }

    func loadUsers(serverAddress: String) async {
        if let fetched = try? await StatusClient(serverAddress: serverAddress).fetchEventUsers() {
            users = fetched
        }
    }
}
