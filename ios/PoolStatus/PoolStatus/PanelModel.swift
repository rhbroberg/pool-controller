import Foundation
import Observation

/// The panel's two-line display, from `GET /panel/display`.
struct PanelDisplay: Decodable, Equatable {
    let lines: [String]
    /// For each line, the character positions the panel is blinking.
    let blinking: [[Int]]
    let timestamp: Date
}

/// The panel's navigation keys. On the panel, + and − move up and down through a menu.
enum PanelKey: String, CaseIterable, Identifiable {
    case menu, left, right, minus, plus

    var id: String { rawValue }

    var title: String {
        switch self {
        case .menu: "Menu"
        case .left: "Left"
        case .right: "Right"
        case .minus: "Down"
        case .plus: "Up"
        }
    }
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
    /// Increments on every key press, for haptic feedback.
    private(set) var pressCount = 0

    func poll(serverAddress: String) async {
        while !Task.isCancelled {
            await refresh(serverAddress: serverAddress)
            try? await Task.sleep(for: Self.refreshInterval)
        }
    }

    func refresh(serverAddress: String) async {
        do {
            display = try await StatusClient(serverAddress: serverAddress).fetchPanelDisplay()
            errorMessage = nil
            isReachable = true
        } catch StatusClientError.server(code: 404, message: _) {
            display = nil
            errorMessage = "The panel hasn’t sent any display text yet."
            isReachable = true
        } catch {
            handle(error)
        }
    }

    func press(_ key: PanelKey, serverAddress: String, token: String) async {
        pressCount += 1
        do {
            try await StatusClient(serverAddress: serverAddress).pressPanelKey(key, token: token)
            try await Task.sleep(for: Self.keyResponseDelay)
            await refresh(serverAddress: serverAddress)
        } catch StatusClientError.unauthorized {
            errorMessage = "Your sign-in is no longer valid. Sign in again to use the panel keys."
        } catch {
            handle(error)
        }
    }

    private func handle(_ error: Error) {
        if error is CancellationError {
            return
        }
        if let urlError = error as? URLError {
            if urlError.code == .cancelled {
                return
            }
            isReachable = false
        }
        errorMessage = error.localizedDescription
    }
}
