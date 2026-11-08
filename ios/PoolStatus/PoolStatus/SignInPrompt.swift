import SwiftUI

/// Shown under controls that are locked until the user signs in.
struct SignInPrompt: View {
    let text: LocalizedStringKey
    let signIn: () -> Void

    var body: some View {
        Button(action: signIn) {
            Label(text, systemImage: "lock")
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }
}
