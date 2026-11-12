import Foundation
import Observation

/// The Reprocess History screen apart from its drawing: the range and kinds chosen, what may
/// start, what is sent, and the run followed until it's done.
@Observable
public final class ReprocessModel {
    /// One count of a run, labelled for a preview or for changes made.
    public struct Row: Identifiable, Equatable {
        public let title: String
        public let count: Int
        public var id: String { title }
    }

    public static let pollInterval: Duration = .seconds(1)
    /// Frames the server couldn't read are what a protocol fix recovers; stored readings and
    /// switches also drop repeats the server once recorded, so they're opt-in.
    public static let defaultKinds: Set<EventKind> = [.protocolErrors]

    public var from: Date
    public var to: Date
    public var kinds: Set<EventKind> = ReprocessModel.defaultKinds
    public private(set) var run: ReprocessRun?
    public private(set) var starting = false
    public private(set) var errorMessage: String?
    @ObservationIgnored private let sleep: StatusStore.Sleep

    public init(now: Date = .now, calendar: Calendar = .current,
                sleep: @escaping StatusStore.Sleep = StatusStore.clockSleep) {
        from = calendar.date(byAdding: .day, value: -30, to: now) ?? now
        to = now
        self.sleep = sleep
    }

    /// The server's event types for the kinds chosen.
    public var eventTypes: [String] {
        EventKind.reprocessable.filter { kinds.contains($0) }.flatMap(\.serverTypes)
    }

    /// What's wrong with the range, or nil.
    public var rangeProblem: String? {
        from < to ? nil : String(localized: "The start has to be before the end.", bundle: .module)
    }

    /// Why nothing can start, or nil.
    public var problem: String? {
        rangeProblem ?? (kinds.isEmpty ? String(localized: "Choose at least one kind of event.", bundle: .module) : nil)
    }

    public var isBusy: Bool { starting || run?.isActive == true }

    public func canStart(isAdmin: Bool) -> Bool {
        isAdmin && !isBusy && problem == nil
    }

    /// Reads the run under way or the last one.
    public func load(store: StatusStore) async {
        do {
            run = try await store.reprocessRun()
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    public func start(dryRun: Bool, store: StatusStore) async {
        starting = true
        errorMessage = nil
        defer { starting = false }
        do {
            run = try await store.startReprocess(ReprocessRequest(from: from, to: to, eventTypes: eventTypes, dryRun: dryRun))
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Looks at the run every `pollInterval` until it's done or the task is cancelled, as when
    /// the screen goes away.
    public func follow(store: StatusStore) async {
        while run?.isActive == true && !Task.isCancelled {
            do {
                try await sleep(Self.pollInterval)
            } catch {
                return
            }
            guard !Task.isCancelled else {
                return
            }
            await load(store: store)
        }
    }

    /// How a run is going, in a sentence.
    public static func stateText(_ run: ReprocessRun) -> String {
        switch run.state {
        case .waiting:
            run.dryRun
                ? String(localized: "Preview waits for a maintenance job to finish", bundle: .module)
                : String(localized: "Reprocessing waits for a maintenance job to finish", bundle: .module)
        case .running:
            if let through = run.through {
                run.dryRun
                    ? String(localized: "Preview is through \(through, format: .dateTime)", bundle: .module)
                    : String(localized: "Reprocessing is through \(through, format: .dateTime)", bundle: .module)
            } else {
                run.dryRun
                    ? String(localized: "Preview has started", bundle: .module)
                    : String(localized: "Reprocessing has started", bundle: .module)
            }
        case .failed:
            run.dryRun
                ? String(localized: "Preview stopped: \(run.error ?? "")", bundle: .module)
                : String(localized: "Reprocessing stopped: \(run.error ?? "")", bundle: .module)
        case .finished:
            run.dryRun ? String(localized: "Previewed", bundle: .module) : String(localized: "Reprocessed", bundle: .module)
        }
    }

    /// A run's counts, labelled for a preview or for changes made.
    public static func rows(_ run: ReprocessRun) -> [Row] {
        [
            Row(title: String(localized: "Events read again", bundle: .module), count: run.examined),
            Row(title: run.dryRun ? String(localized: "Would be rewritten", bundle: .module) : String(localized: "Rewritten", bundle: .module),
                count: run.updated),
            Row(title: run.dryRun ? String(localized: "Would be removed", bundle: .module) : String(localized: "Removed", bundle: .module),
                count: run.removed),
            Row(title: String(localized: "Unchanged", bundle: .module), count: run.unchanged)
        ] + run.transitions.map { transition in
            Row(title: "\(ReprocessRun.title(ofType: transition.from)) → \(ReprocessRun.title(ofType: transition.to))",
                count: transition.count)
        }
    }

    /// What the screen says under a finished run, or nil.
    public static func footer(_ run: ReprocessRun) -> String? {
        guard run.state == .finished else {
            return nil
        }
        if run.dryRun {
            return String(localized: "Nothing has changed yet. Reprocess makes these changes.", bundle: .module)
        }
        return run.updated > 0 || run.removed > 0
            ? String(localized: "The history summaries are being redone from the start of the range; graphs catch up as they are.", bundle: .module)
            : nil
    }
}
