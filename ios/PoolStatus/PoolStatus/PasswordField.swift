import SwiftUI
import UIKit

/// A password entry with an eye button that shows what's typed. Submitting works as for any
/// text field, with `.onSubmit` on this view or one around it.
struct PasswordField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    /// `.password` to fill a saved password. A new password gets nil: `.newPassword` turns on
    /// automatic strong passwords, which also types into the confirmation field.
    var contentType: UITextContentType?

    /// Set by a view that moves focus here, as from the account name's Return.
    private let externalFocus: FocusState<Bool>.Binding?

    @State private var isRevealed = false
    @FocusState private var ownFocus: Bool

    init(_ title: LocalizedStringKey, text: Binding<String>, contentType: UITextContentType? = nil,
         focused: FocusState<Bool>.Binding? = nil) {
        self.title = title
        _text = text
        self.contentType = contentType
        externalFocus = focused
    }

    private var focus: FocusState<Bool>.Binding { externalFocus ?? $ownFocus }

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if isRevealed {
                    TextField(title, text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } else {
                    SecureField(title, text: $text)
                }
            }
            .textContentType(contentType)
            .focused(focus)

            Button {
                let wasFocused = focus.wrappedValue
                isRevealed.toggle()
                // the field was swapped for the other kind, which starts unfocused
                if wasFocused {
                    Task { @MainActor in focus.wrappedValue = true }
                }
            } label: {
                Image(systemName: isRevealed ? "eye.slash" : "eye")
                    .foregroundStyle(.secondary)
            }
            // borderless so tapping the field doesn't also press the button
            .buttonStyle(.borderless)
            .accessibilityLabel(isRevealed ? "Hide Password" : "Show Password")
        }
    }
}
