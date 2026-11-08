import Foundation
import Observation

/// The panel's two-line display, from `GET /panel/display`.
nonisolated struct PanelDisplay: Decodable, Equatable, Sendable {
    let lines: [String]
    /// For each line, the character positions the panel is blinking.
    let blinking: [[Int]]
    let timestamp: Date
}

/// The panel's navigation keys. On the panel, + and − step through a menu and change values.
nonisolated enum PanelKey: String, CaseIterable, Identifiable, Sendable {
    case menu, left, right, minus, plus

    var id: String { rawValue }

    /// The spoken name, for VoiceOver.
    var title: String {
        switch self {
        case .menu: String(localized: "Menu")
        case .left: String(localized: "Left")
        case .right: String(localized: "Right")
        case .minus: String(localized: "Minus")
        case .plus: String(localized: "Plus")
        }
    }

    /// As printed on the panel and the wireless remote.
    var label: String {
        switch self {
        case .menu: "Menu"
        case .left: "<"
        case .right: ">"
        case .minus: "−"
        case .plus: "+"
        }
    }
}

/// One key press, as shown in the trail under the display.
struct KeyPress: Identifiable {
    enum Delivery {
        /// On its way to the server.
        case sending
        /// The server has it and sends it on the controller's next ping.
        case queued
        case failed
    }

    let id: Int
    let key: PanelKey
    var delivery: Delivery
}

@Observable
final class PanelModel {
    static let refreshInterval: Duration = .seconds(1)
    /// Time for the controller to act on a key before the display is read again.
    static let keyResponseDelay: Duration = .milliseconds(300)

    private(set) var display: PanelDisplay?
    private(set) var errorMessage: String?
    /// False once the server can't be reached; true while it answers, even with an error.
    private(set) var isReachable = true
    /// Increments when the server accepts a key press, for haptic feedback.
    private(set) var pressCount = 0
    /// The last few presses, oldest first.
    private(set) var recentPresses: [KeyPress] = []
    static let recentPressLimit = 8
    private var nextPressID = 0

    func poll(client: StatusClient) async {
        while !Task.isCancelled {
            await refresh(client: client)
            try? await Task.sleep(for: Self.refreshInterval)
        }
    }

    func refresh(client: StatusClient) async {
        do {
            display = try await client.fetchPanelDisplay()
            errorMessage = nil
            isReachable = true
        } catch StatusClientError.server(code: 404, message: _) {
            display = nil
            errorMessage = String(localized: "The panel hasn’t sent any display text yet.")
            isReachable = true
        } catch {
            handle(error)
        }
    }

    /// Sends a key press as the signed-in account, then reads the display again.
    func press(_ key: PanelKey, auth: AuthSession) async {
        let id = nextPressID
        nextPressID += 1
        recentPresses.append(KeyPress(id: id, key: key, delivery: .sending))
        if recentPresses.count > Self.recentPressLimit {
            recentPresses.removeFirst(recentPresses.count - Self.recentPressLimit)
        }

        do {
            try await auth.authorized(.usePanelKeys) { client, token in
                try await client.pressPanelKey(key, token: token)
            }
            mark(id, .queued)
            pressCount += 1
            try await Task.sleep(for: Self.keyResponseDelay)
            await refresh(client: auth.client)
        } catch let error as AuthError {
            mark(id, .failed)
            errorMessage = error.localizedDescription
        } catch {
            if !error.isCancellation {
                mark(id, .failed)
            }
            handle(error)
        }
    }

    private func mark(_ id: Int, _ delivery: KeyPress.Delivery) {
        if let index = recentPresses.firstIndex(where: { $0.id == id }), recentPresses[index].delivery == .sending {
            recentPresses[index].delivery = delivery
        }
    }

    private func handle(_ error: Error) {
        if error.isCancellation {
            return
        }
        if error is URLError {
            isReachable = false
        }
        errorMessage = error.localizedDescription
    }
}
