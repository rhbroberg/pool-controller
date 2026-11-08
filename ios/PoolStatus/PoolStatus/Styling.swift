import PoolStatusCore
import SwiftUI

extension Tint {
    var color: Color {
        switch self {
        case .pink: .pink
        case .orange: .orange
        case .blue: .blue
        case .cyan: .cyan
        case .yellow: .yellow
        case .green: .green
        case .mint: .mint
        case .teal: .teal
        case .indigo: .indigo
        }
    }
}

/// The rounded panels the pages are built from.
enum Card {
    static let cornerRadius: CGFloat = 16
    /// Equipment tiles and the rows between cards are a little tighter.
    static let tileCornerRadius: CGFloat = 14
}

extension View {
    func cardBackground(cornerRadius: CGFloat = Card.cornerRadius) -> some View {
        background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: cornerRadius))
    }
}

extension Binding where Value == Bool {
    /// True while `item` holds a value; dismissing clears it.
    init<Wrapped>(isPresent item: Binding<Wrapped?>) {
        self.init(get: { item.wrappedValue != nil },
                  set: { if !$0 { item.wrappedValue = nil } })
    }
}
