import SwiftUI
import UIKit

/// Mirrors the controller's display and sends its menu and arrow keys: the way to every
/// setting on the controller, not only the ones the app shows itself.
struct PanelView: View {
    @Environment(StatusStore.self) private var store
    @State private var model = PanelModel()
    @State private var showingSettings = false

    private static let margin: CGFloat = 16
    private static let spacing: CGFloat = 24
    private static let maximumPad: CGFloat = 320
    private static let minimumPad: CGFloat = 180
    private static let maximumDisplayWidth: CGFloat = 600
    /// The panel shows two lines of 20 characters.
    private static let displayColumns: CGFloat = 20

    private enum Access {
        case signedOut, viewOnly, unreachable, ready
    }

    private var access: Access {
        if store.auth.credentials == nil {
            return .signedOut
        }
        if !store.auth.canControl {
            return .viewOnly
        }
        return model.isReachable ? .ready : .unreachable
    }

    var body: some View {
        // a fixed layout, so the display never scrolls away from the keys
        GeometryReader { geometry in
            let size = geometry.size
            let wide = size.width > size.height
            let pad = Self.padDiameter(for: size, wide: wide)
            // the reader can report a zero size before layout settles, so never go negative
            let displayWidth = max(0, wide
                ? size.width - 2 * Self.margin - Self.spacing - pad
                : min(size.width - 2 * Self.margin, Self.maximumDisplayWidth))

            Group {
                if wide {
                    HStack(alignment: .center, spacing: Self.spacing) {
                        display(width: displayWidth)
                        controls(diameter: pad)
                    }
                } else {
                    VStack(spacing: 0) {
                        display(width: displayWidth)
                        Spacer(minLength: Self.spacing)
                        controls(diameter: pad)
                        Spacer(minLength: Self.margin)
                    }
                }
            }
            .padding(Self.margin)
            .frame(width: size.width, height: size.height)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Panel Control")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.serverAddress) {
            await model.poll(client: store.client)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: model.pressCount)
        .onAppear {
            // a session in the controller's menus shouldn't end because the phone dimmed
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
    }

    private static func padDiameter(for size: CGSize, wide: Bool) -> CGFloat {
        let available = wide
            ? min(size.height - 2 * margin, (size.width - 2 * margin - spacing) * 0.45)
            : min(size.width - 2 * margin, size.height - 260)
        return min(max(available, minimumPad), maximumPad)
    }

    private func display(width: CGFloat) -> some View {
        // the LCD's padding and border take about 30 points; a monospaced character is about 0.62 em
        let fontSize = min(max((width - 30) / (Self.displayColumns * 0.62), 1), 34)
        return PanelDisplayView(display: model.display, message: model.errorMessage,
                                presses: model.recentPresses, fontSize: fontSize)
            .frame(width: width)
    }

    @ViewBuilder
    private func controls(diameter: CGFloat) -> some View {
        switch access {
        case .ready:
            VStack(spacing: 12) {
                DirectionPad(diameter: diameter) { key in
                    press(key)
                }
                Text("Hold + or − to repeat.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .signedOut:
            VStack(spacing: 12) {
                Text("Sign in to press the panel keys and change the controller’s settings.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                SignInPrompt(text: "Sign In") {
                    showingSettings = true
                }
            }
            .frame(maxWidth: diameter)
        case .viewOnly:
            Label("View only. Your account can watch the panel but not press its keys.", systemImage: "eye")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: diameter)
        case .unreachable:
            Label("Can’t reach the server. The keys come back when it answers.", systemImage: "wifi.exclamationmark")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: diameter)
        }
    }

    private func press(_ key: PanelKey) {
        Task { await model.press(key, auth: store.auth) }
    }
}

private struct PanelDisplayView: View {
    let display: PanelDisplay?
    let message: String?
    let presses: [KeyPress]
    let fontSize: CGFloat

    private static let background = Color(red: 0.07, green: 0.14, blue: 0.09)
    private static let lit = Color(red: 0.55, green: 1.0, blue: 0.6)
    private static let blinkPeriod = 0.5

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Group {
                if let display {
                    TimelineView(.periodic(from: .now, by: Self.blinkPeriod)) { context in
                        let blinkVisible = Int(context.date.timeIntervalSinceReferenceDate / Self.blinkPeriod) % 2 == 0
                        VStack(alignment: .leading, spacing: fontSize * 0.25) {
                            ForEach(display.lines.indices, id: \.self) { index in
                                line(index, of: display, blinkVisible: blinkVisible)
                            }
                        }
                        .font(.system(size: fontSize, weight: .medium, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.9)
                    }
                } else {
                    Text(message ?? "Waiting for the panel…")
                        .font(.headline)
                        .foregroundStyle(Self.lit.opacity(0.8))
                        .multilineTextAlignment(.center)
                }
            }
            // two lines tall either way, so the box doesn't jump when the display arrives
            .frame(maxWidth: .infinity, minHeight: fontSize * 2.6)
            .padding(.vertical, 16)
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

            KeyTrail(presses: presses)
        }
    }

    /// One display line, with the panel's blinking characters hidden on alternate beats.
    private func line(_ index: Int, of display: PanelDisplay, blinkVisible: Bool) -> Text {
        let blinking = index < display.blinking.count ? Set(display.blinking[index]) : []
        var text = AttributedString()
        for (offset, character) in display.lines[index].enumerated() {
            var piece = AttributedString(String(character))
            piece.foregroundColor = !blinkVisible && blinking.contains(offset) ? .clear : Self.lit
            text += piece
        }
        return Text(text)
    }
}

/// The last few keys pressed, so a display that lags behind the finger isn't mistaken for a
/// press that didn't take.
private struct KeyTrail: View {
    let presses: [KeyPress]

    var body: some View {
        if !presses.isEmpty {
            // as many of the newest presses as fit on one line, rather than squeezing them all
            ViewThatFits(in: .horizontal) {
                ForEach((1...presses.count).reversed(), id: \.self) { count in
                    row(Array(presses.suffix(count)))
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Recent keys: " + presses.map(description).joined(separator: ", "))
        }
    }

    private func row(_ shown: [KeyPress]) -> some View {
        HStack(spacing: 6) {
            Text("Keys")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(shown) { press in
                chip(press)
            }
        }
    }

    private func chip(_ press: KeyPress) -> some View {
        let failed = press.delivery == .failed
        return HStack(spacing: 2) {
            Text(press.key.label)
            switch press.delivery {
            case .sending:
                Image(systemName: "clock")
                    .font(.caption2)
            case .failed:
                Image(systemName: "xmark")
                    .font(.caption2)
            case .queued:
                EmptyView()
            }
        }
        .font(.footnote.monospaced().weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(failed ? Color.red : press.delivery == .sending ? Color.secondary : Color.primary)
        .background(failed ? Color.red.opacity(0.12) : Color(.tertiarySystemFill), in: .capsule)
        .fixedSize()
    }

    private func description(_ press: KeyPress) -> String {
        switch press.delivery {
        case .sending: "\(press.key.title), sending"
        case .queued: press.key.title
        case .failed: "\(press.key.title), failed"
        }
    }
}

private struct DirectionPad: View {
    let diameter: CGFloat
    let press: (PanelKey) -> Void

    private var centerDiameter: CGFloat { diameter * 0.4 }
    private var arrowDistance: CGFloat { diameter * 0.343 }
    private var keySize: CGFloat { diameter * 0.27 }

    var body: some View {
        ZStack {
            Circle()
                .fill(Color(.secondarySystemGroupedBackground))
                .shadow(color: .black.opacity(0.12), radius: 10, y: 4)

            RepeatingKey(key: .plus, systemImage: "plus", size: keySize, press: press)
                .offset(y: -arrowDistance)
            RepeatingKey(key: .minus, systemImage: "minus", size: keySize, press: press)
                .offset(y: arrowDistance)
            key(.left, systemImage: "lessthan")
                .offset(x: -arrowDistance)
            key(.right, systemImage: "greaterthan")
                .offset(x: arrowDistance)

            Button {
                press(.menu)
            } label: {
                Text(PanelKey.menu.label.uppercased())
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(width: centerDiameter, height: centerDiameter)
                    .background(Color.accentColor, in: .circle)
            }
            .buttonStyle(PadButtonStyle())
            .accessibilityLabel(PanelKey.menu.title)
        }
        .frame(width: diameter, height: diameter)
    }

    private func key(_ key: PanelKey, systemImage: String) -> some View {
        Button {
            press(key)
        } label: {
            KeyLabel(systemImage: systemImage, size: keySize)
        }
        .buttonStyle(PadButtonStyle())
        .accessibilityLabel(key.title)
    }
}

private struct KeyLabel: View {
    let systemImage: String
    let size: CGFloat

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.36, weight: .semibold))
            .foregroundStyle(.primary)
            .frame(width: size, height: size)
            .contentShape(.circle)
    }
}

/// A key that presses once on touch, then repeats while held, as when stepping a value.
private struct RepeatingKey: View {
    static let initialDelay: Duration = .milliseconds(500)
    static let repeatInterval: Duration = .milliseconds(300)

    let key: PanelKey
    let systemImage: String
    let size: CGFloat
    let press: (PanelKey) -> Void

    @Environment(\.isEnabled) private var isEnabled
    @State private var isPressed = false
    @State private var repeater: Task<Void, Never>?

    var body: some View {
        KeyLabel(systemImage: systemImage, size: size)
            .scaleEffect(isPressed ? 0.9 : 1)
            .opacity(isPressed ? 0.7 : 1)
            .animation(.easeOut(duration: 0.12), value: isPressed)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard isEnabled, !isPressed else {
                            return
                        }
                        isPressed = true
                        press(key)
                        repeater = Task {
                            try? await Task.sleep(for: Self.initialDelay)
                            while !Task.isCancelled {
                                press(key)
                                try? await Task.sleep(for: Self.repeatInterval)
                            }
                        }
                    }
                    .onEnded { _ in
                        stop()
                    }
            )
            .onDisappear(perform: stop)
            .accessibilityElement()
            .accessibilityLabel(key.title)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Touch and hold to repeat")
            .accessibilityAction {
                press(key)
            }
    }

    private func stop() {
        isPressed = false
        repeater?.cancel()
        repeater = nil
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

#if DEBUG
#Preview {
    NavigationStack {
        PanelView()
            .environment(StatusStore.preview())
    }
}
#endif
