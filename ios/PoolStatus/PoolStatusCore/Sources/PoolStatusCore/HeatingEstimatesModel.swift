import Foundation
import Observation

/// The Heating Estimates screen apart from its drawing: the range to look in, the windows found
/// and which are ticked, the model calculated from them beside the one in use, and saving it.
@Observable
public final class HeatingEstimatesModel {
    public static let pollInterval: Duration = .seconds(1)

    public var from: Date
    public var to: Date
    /// The kinds of window used; unticking one leaves all of its windows out.
    public var kinds: Set<HeatingWindowKind> = Set(HeatingWindowKind.allCases) {
        didSet {
            if kinds != oldValue {
                preview = nil
            }
        }
    }
    public private(set) var state: HeatingModelState?
    public private(set) var scan: HeatingScan?
    public private(set) var windows: [HeatingWindow] = []
    /// Windows the admin turned off one by one.
    public private(set) var excluded: Set<String> = []
    public private(set) var preview: HeatingModelPreview?
    public private(set) var starting = false
    public private(set) var calculating = false
    public private(set) var saving = false
    public private(set) var errorMessage: String?
    /// Said once after saving.
    public private(set) var savedMessage: String?
    @ObservationIgnored private var rangeChosen = false
    @ObservationIgnored private let sleep: StatusStore.Sleep

    public init(now: Date = .now, calendar: Calendar = .current,
                sleep: @escaping StatusStore.Sleep = StatusStore.clockSleep) {
        from = calendar.date(byAdding: .year, value: -1, to: now) ?? now
        to = now
        self.sleep = sleep
    }

    // MARK: Range and scan

    /// What's wrong with the range, or nil.
    public var rangeProblem: String? {
        from < to ? nil : String(localized: "The start has to be before the end.", bundle: .module)
    }

    public var isBusy: Bool { starting || scan?.isActive == true }

    public func canFind(isAdmin: Bool) -> Bool {
        isAdmin && !isBusy && rangeProblem == nil
    }

    /// Marks the range as the admin's own, so loading doesn't put the default back.
    public func rangeEdited() {
        rangeChosen = true
    }

    /// Reads the model in use, the last scan and, when it finished, its windows. The range starts
    /// as the server's default (all of history before the simulator's) until it's edited.
    public func load(store: StatusStore) async {
        do {
            let loaded = try await store.heatingModel()
            state = loaded
            if !rangeChosen {
                from = loaded.defaultRange.from
                to = loaded.defaultRange.to
            }
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
            return
        }
        await loadScan(store: store)
    }

    /// Reads the scan under way or the last one, and its windows once finished.
    ///
    /// A finished scan is only taken once its windows are in hand. The screen follows the scan
    /// while it's active, and that stops, cancelling this very call, the moment a finished scan is
    /// stored; keeping it until the windows were read left a finished scan with none, and the
    /// next look had no reason to fetch them again.
    public func loadScan(store: StatusStore) async {
        do {
            let latest = try await store.heatingScan()
            if latest?.state == .finished && (scan?.id != latest?.id || scan?.state != .finished || windows.isEmpty) {
                try await loadWindows(store: store)
            }
            scan = latest
            errorMessage = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func loadWindows(store: StatusStore) async throws {
        let found = try await store.heatingWindows()
        if windows.first?.id != found.windows.first?.id || windows.count != found.windows.count || scan?.id != found.scanId {
            excluded = []
            preview = nil
        }
        windows = found.windows
    }

    public func find(store: StatusStore) async {
        starting = true
        errorMessage = nil
        savedMessage = nil
        defer { starting = false }
        do {
            scan = try await store.startHeatingScan(HeatingScanRequest(from: from, to: to))
            windows = []
            excluded = []
            preview = nil
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Looks at the scan every `pollInterval` until it's done or the task is cancelled, as when the
    /// screen goes away.
    public func follow(store: StatusStore) async {
        while scan?.isActive == true && !Task.isCancelled {
            do {
                try await sleep(Self.pollInterval)
            } catch {
                return
            }
            guard !Task.isCancelled else {
                return
            }
            await loadScan(store: store)
        }
    }

    /// How the scan is going, in a sentence.
    public static func stateText(_ scan: HeatingScan) -> String {
        switch scan.state {
        case .waiting:
            String(localized: "Waits for a maintenance job to finish", bundle: .module)
        case .running:
            if let through = scan.through {
                String(localized: "Looked through \(through, format: .dateTime.month(.abbreviated).day().year())", bundle: .module)
            } else {
                String(localized: "Started looking", bundle: .module)
            }
        case .failed:
            String(localized: "Stopped: \(scan.error ?? "")", bundle: .module)
        case .finished:
            String(localized: "Found \(scan.summary?.windows ?? 0) windows in \(scan.scanned.formatted()) events", bundle: .module)
        }
    }

    // MARK: Windows

    /// Whether the fit would use this window: it's suitable, its kind is ticked and it hasn't been
    /// turned off.
    public func isIncluded(_ window: HeatingWindow) -> Bool {
        window.suitable && kinds.contains(window.sources) && !excluded.contains(window.id)
    }

    public func setIncluded(_ window: HeatingWindow, _ included: Bool) {
        guard window.suitable else {
            return
        }
        if included {
            excluded.remove(window.id)
        } else {
            excluded.insert(window.id)
        }
        preview = nil
    }

    public func windows(for water: WaterBody, kind: HeatingWindowKind? = nil) -> [HeatingWindow] {
        windows.filter { $0.body == water && (kind == nil || $0.sources == kind) }
    }

    /// How many windows of the body the fit would use.
    public func includedCount(_ water: WaterBody) -> Int {
        windows.filter { $0.body == water && isIncluded($0) }.count
    }

    /// The suitable windows of one kind, how many are ticked, and their hours, for a toggle's detail.
    public func detail(_ water: WaterBody, _ kind: HeatingWindowKind) -> String {
        let suitable = windows(for: water, kind: kind).filter(\.suitable)
        let used = suitable.filter { !excluded.contains($0.id) }
        let hours = used.reduce(0) { $0 + $1.hours }
        return String(localized: "\(used.count) of \(suitable.count) windows · \(Int(hours.rounded())) hours", bundle: .module)
    }

    /// The bodies of water with any windows.
    public var bodiesWithWindows: [WaterBody] {
        WaterBody.allCases.filter { water in windows.contains { $0.body == water } }
    }

    public func canCalculate(isAdmin: Bool) -> Bool {
        isAdmin && scan?.state == .finished && !calculating && !saving && !windows.isEmpty
    }

    // MARK: Calculate and save

    /// Fits a model to the windows left ticked and shows it beside the one in use; nothing is kept
    /// until it's saved.
    public func calculate(store: StatusStore) async {
        guard let scan else {
            return
        }
        calculating = true
        errorMessage = nil
        savedMessage = nil
        defer { calculating = false }
        do {
            let request = HeatingModelRequest(scanId: scan.id,
                                              excludeWindowIds: windows.filter { excluded.contains($0.id) }.map(\.id),
                                              includeSources: HeatingWindowKind.allCases.filter { kinds.contains($0) })
            preview = try await store.previewHeatingModel(request)
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    public func discard() {
        preview = nil
    }

    public func canSave(isAdmin: Bool) -> Bool {
        isAdmin && !saving && preview?.canSave == true
    }

    /// Keeps the calculated model as the one every estimate uses.
    public func save(store: StatusStore) async {
        guard let preview else {
            return
        }
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            state = try await store.saveHeatingModel(previewId: preview.previewId)
            self.preview = nil
            savedMessage = String(localized: "Saved. Every estimate uses this model from now on.", bundle: .module)
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: Words

    /// °F per hour, as "0.55 °F/h".
    public static func rate(_ value: Double) -> String {
        String(localized: "\(value.formatted(.number.precision(.fractionLength(2)))) °F/h", bundle: .module)
    }

    /// The share lost per hour, as "1.2% per hour".
    public static func lossText(_ loss: Double) -> String {
        String(localized: "\((loss * 100).formatted(.number.precision(.fractionLength(1))))% per hour", bundle: .module)
    }

    /// What the model says about each source, one line each, for the details and the preview.
    public static func lines(_ model: HeatingBodyModel) -> [(title: String, value: String)] {
        guard model.available else {
            return [(String(localized: "Not enough to tell", bundle: .module), model.reason ?? "")]
        }
        var lines: [(title: String, value: String)] = []
        lines.append((String(localized: "Heater", bundle: .module),
                      model.heater.map(rate) ?? String(localized: "not known", bundle: .module)))
        if let pump = model.heatPump {
            var value = String(localized: "\(rate(pump.base)) at \(Int(pump.referenceAirTemperature))° air", bundle: .module)
            if pump.slope > 0.0005 {
                value += String(localized: ", +\(pump.slope.formatted(.number.precision(.fractionLength(3)))) per °F warmer", bundle: .module)
            }
            lines.append((String(localized: "Heat Pump", bundle: .module), value))
        } else {
            lines.append((String(localized: "Heat Pump", bundle: .module), String(localized: "not known", bundle: .module)))
        }
        if let solar = model.solar {
            lines.append((String(localized: "Full sun", bundle: .module), rate(solar)))
        }
        if let loss = model.loss {
            lines.append((String(localized: "Heat lost to air", bundle: .module), lossText(loss)))
        }
        return lines
    }

    /// A sample as a sentence, such as "84° → 92° in 80° air: 2 h 5 min".
    public static func sampleText(_ sample: HeatingModelPreview.Sample) -> String {
        let outcome: String
        if let minutes = sample.minutes, sample.status == "ready" {
            outcome = HeatingEstimate.duration(minutes: minutes)
        } else {
            outcome = String(localized: "out of reach", bundle: .module)
        }
        return String(localized: "\(Int(sample.from))° → \(Int(sample.to))° in \(Int(sample.airTemperature))° air: \(outcome)", bundle: .module)
    }
}
