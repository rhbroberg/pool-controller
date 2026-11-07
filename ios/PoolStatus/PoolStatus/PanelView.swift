import SwiftUI

/// Mirrors the controller's display and sends its menu and arrow keys.
struct PanelView: View {
    let store: StatusStore

    @AppStorage("serverAddress") private var serverAddress = StatusView.defaultServerAddress
    @State private var model = PanelModel()
    @State private var showingSettings = false

    private var canPress: Bool {
        store.canControl && model.isReachable
    }

    /// Signed in, but the role can't press keys: the pad isn't shown at all.
    private var viewOnly: Bool {
        store.credentials != nil && !store.canControl
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 32) {
                PanelDisplayView(display: model.display, message: model.errorMessage)

                if viewOnly {
                    Label("View only. Your account can watch the panel but not press its keys.", systemImage: "eye")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    DirectionPad(isEnabled: canPress) { key in
                        press(key)
                    }
                }

                if store.credentials == nil {
                    SignInPrompt(text: "Sign in to use the panel keys") {
                        showingSettings = true
                    }
                } else if !viewOnly && !model.isReachable {
                    Text("Reconnect to the server to use the panel keys.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Panel Control")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: serverAddress) {
            await model.poll(serverAddress: serverAddress)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: model.pressCount)
        .sheet(isPresented: $showingSettings) {
            SettingsView(serverAddress: $serverAddress, store: store)
        }
    }

    private func press(_ key: PanelKey) {
        guard let credentials = store.credentials else {
            return
        }
        Task { await model.press(key, serverAddress: serverAddress, token: credentials.token) }
    }
}

private struct PanelDisplayView: View {
    let display: PanelDisplay?
    let message: String?

    private static let background = Color(red: 0.07, green: 0.14, blue: 0.09)
    private static let lit = Color(red: 0.55, green: 1.0, blue: 0.6)
    private static let blinkPeriod = 0.5

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Group {
                if let display {
                    TimelineView(.periodic(from: .now, by: Self.blinkPeriod)) { context in
                        let blinkVisible = Int(context.date.timeIntervalSinceReferenceDate / Self.blinkPeriod) % 2 == 0
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(display.lines.indices, id: \.self) { index in
                                line(index, of: display, blinkVisible: blinkVisible)
                            }
                        }
                    }
                } else {
                    Text(message ?? "Waiting for the panel…")
                        .foregroundStyle(Self.lit.opacity(0.8))
                        .frame(maxWidth: .infinity, minHeight: 60)
                        .multilineTextAlignment(.center)
                }
            }
            .font(.system(size: 22, weight: .medium, design: .monospaced))
            .lineLimit(1)
            .minimumScaleFactor(0.4)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .padding(.horizontal, 12)
            .background(Self.background, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.black.opacity(0.4), lineWidth: 3))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(display?.lines.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
                                ?? message ?? "Waiting for the panel")

            if let display {
                Text("Updated \(display.timestamp, format: .dateTime.hour().minute().second())")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let message {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    /// One display line, with the panel's blinking characters hidden on alternate beats.
    private func line(_ index: Int, of display: PanelDisplay, blinkVisible: Bool) -> Text {
        let blinking = index < display.blinking.count ? Set(display.blinking[index]) : []
        return display.lines[index].enumerated().reduce(Text("")) { text, character in
            let hidden = !blinkVisible && blinking.contains(character.offset)
            return text + Text(String(character.element)).foregroundStyle(hidden ? Color.clear : Self.lit)
        }
    }
}

private struct DirectionPad: View {
    let isEnabled: Bool
    let press: (PanelKey) -> Void

    private static let diameter: CGFloat = 280
    private static let centerDiameter: CGFloat = 112
    private static let arrowDistance: CGFloat = 96

    var body: some View {
        ZStack {
            Circle()
                .fill(Color(.secondarySystemGroupedBackground))
                .shadow(color: .black.opacity(0.12), radius: 10, y: 4)

            arrow(.plus, systemImage: "chevron.up", offset: CGSize(width: 0, height: -Self.arrowDistance))
            arrow(.minus, systemImage: "chevron.down", offset: CGSize(width: 0, height: Self.arrowDistance))
            arrow(.left, systemImage: "chevron.left", offset: CGSize(width: -Self.arrowDistance, height: 0))
            arrow(.right, systemImage: "chevron.right", offset: CGSize(width: Self.arrowDistance, height: 0))

            Button {
                press(.menu)
            } label: {
                Text("MENU")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(width: Self.centerDiameter, height: Self.centerDiameter)
                    .background(Color.accentColor, in: .circle)
            }
            .accessibilityLabel(PanelKey.menu.title)
        }
        .frame(width: Self.diameter, height: Self.diameter)
        .buttonStyle(PadButtonStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
    }

    private func arrow(_ key: PanelKey, systemImage: String, offset: CGSize) -> some View {
        Button {
            press(key)
        } label: {
            Image(systemName: systemImage)
                .font(.title.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(width: 76, height: 76)
                .contentShape(.circle)
        }
        .offset(offset)
        .accessibilityLabel(key.title)
    }
}

private struct PadButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

#Preview {
    NavigationStack {
        PanelView(store: StatusStore())
    }
}
