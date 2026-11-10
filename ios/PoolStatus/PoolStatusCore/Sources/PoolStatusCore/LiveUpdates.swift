import Foundation

/// One packet of the server's live updates: socket.io over a WebSocket. Only what the app needs
/// of the protocol (Engine.IO 4, Socket.IO 5):
///
///     0{…}            the server opens the session, saying how often it pings
///     2 / 3           its ping and the app's pong
///     40 / 40{…}      joining the default namespace, and the server's welcome
///     42["name",…]    an event
///     44{…} / 41 / 1  refused, left, or closed
public nonisolated enum LivePacket: Equatable, Sendable {
    case open(pingInterval: Duration, pingTimeout: Duration)
    case close
    case ping
    case connect
    case disconnect
    case refused(String)
    /// `payload` is the event's argument as JSON.
    case event(name: String, payload: Data)

    static let path = "/socket.io/"
    static let query = [URLQueryItem(name: "EIO", value: "4"), URLQueryItem(name: "transport", value: "websocket")]

    public static let pong = "3"
    public static let join = "40"

    /// Nil for anything the app doesn't understand.
    public init?(_ text: String) {
        guard let type = text.first else {
            return nil
        }
        let body = text.dropFirst()
        switch type {
        case "0":
            guard let open = try? JSONDecoder().decode(Open.self, from: Data(body.utf8)) else {
                return nil
            }
            self = .open(pingInterval: .milliseconds(open.pingInterval), pingTimeout: .milliseconds(open.pingTimeout))
        case "1":
            self = .close
        case "2":
            self = .ping
        case "4":
            self.init(message: body)
        default:
            return nil
        }
    }

    private init?(message: Substring) {
        guard let type = message.first else {
            return nil
        }
        let body = message.dropFirst()
        // a namespace other than the default one would follow the type, as "/name,"
        if body.first == "/" {
            return nil
        }
        switch type {
        case "0":
            self = .connect
        case "1":
            self = .disconnect
        case "4":
            let refusal = try? JSONDecoder().decode(Refusal.self, from: Data(body.utf8))
            self = .refused(refusal?.message ?? "refused")
        case "2":
            // an acknowledgement id may sit between the type and the payload
            let json = body.drop { $0.isNumber }
            guard let array = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [Any],
                  let name = array.first as? String else {
                return nil
            }
            let argument = array.count > 1 ? array[1] : NSNull()
            guard let payload = try? JSONSerialization.data(withJSONObject: argument, options: .fragmentsAllowed) else {
                return nil
            }
            self = .event(name: name, payload: payload)
        default:
            return nil
        }
    }

    private struct Open: Decodable {
        let pingInterval: Int
        let pingTimeout: Int
    }

    private struct Refusal: Decodable {
        let message: String?
    }
}

/// A change the server pushed.
public nonisolated enum LiveUpdate: Sendable {
    /// Entries as `GET /status` reports them: every switch when one changes, or the readings
    /// that changed on the display.
    case readings([StatusReading])
    /// The same as `GET /heating` answers.
    case heating(HeatingStatus)

    /// Nil for events the app doesn't know, or can't read.
    public init?(name: String, payload: Data) {
        switch name {
        case "readings":
            guard let push = try? StatusClient.decoder.decode(ReadingsPush.self, from: payload) else {
                return nil
            }
            self = .readings(push.readings)
        case "heating":
            guard let heating = try? StatusClient.decoder.decode(HeatingStatus.self, from: payload) else {
                return nil
            }
            self = .heating(heating)
        default:
            return nil
        }
    }

    /// Skips any entry it can't read rather than losing the rest.
    private struct ReadingsPush: Decodable {
        let readings: [StatusReading]

        private enum CodingKeys: String, CodingKey {
            case readings
        }

        init(from decoder: Decoder) throws {
            var entries = try decoder.container(keyedBy: CodingKeys.self).nestedUnkeyedContainer(forKey: .readings)
            var readings: [StatusReading] = []
            while !entries.isAtEnd {
                if let reading = try? entries.decode(StatusReading.self) {
                    readings.append(reading)
                } else {
                    _ = try entries.decode(Skipped.self)
                }
            }
            self.readings = readings
        }

        private struct Skipped: Decodable {
            init(from decoder: Decoder) throws {}
        }
    }
}

/// A connection carrying the live updates' text messages.
public nonisolated protocol LiveSocket: Sendable {
    func send(_ text: String) async throws
    /// The next message; throws once the connection closes, or if nothing arrives within `timeout`.
    func receive(timeout: Duration) async throws -> String
    func close()
}

/// Opens connections to the live updates; the tests use one that needs no server.
public nonisolated protocol LiveTransport: Sendable {
    func open(_ url: URL) -> any LiveSocket
}

public nonisolated enum LiveError: Error {
    /// The server went quiet for longer than it promised to ping.
    case silent
}

/// Live updates over URLSession's WebSockets.
public nonisolated struct URLSessionLiveTransport: LiveTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func open(_ url: URL) -> any LiveSocket {
        let task = session.webSocketTask(with: url)
        task.resume()
        return WebSocketTaskSocket(task: task)
    }
}

private nonisolated struct WebSocketTaskSocket: LiveSocket {
    let task: URLSessionWebSocketTask

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive(timeout: Duration) async throws -> String {
        try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                // the task's own receive doesn't stop when cancelled; ending the connection does
                try await withTaskCancellationHandler {
                    try await nextText()
                } onCancel: {
                    task.cancel(with: .goingAway, reason: nil)
                }
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw LiveError.silent
            }
            defer { group.cancelAll() }
            guard let text = try await group.next() else {
                throw LiveError.silent
            }
            return text
        }
    }

    private func nextText() async throws -> String {
        switch try await task.receive() {
        case .string(let text):
            return text
        case .data(let data):
            return String(decoding: data, as: UTF8.self)
        @unknown default:
            return ""
        }
    }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
    }
}
