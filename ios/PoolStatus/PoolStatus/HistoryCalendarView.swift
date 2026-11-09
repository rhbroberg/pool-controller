import PoolStatusCore
import SwiftUI
import UIKit

/// Picks a range of days for a history graph: tap the first day, then the last. A dot marks
/// each day `reading` was recorded, or any pool, spa or salt reading when `reading` is nil.
struct HistoryCalendarSheet: View {
    let initialRange: ClosedRange<Date>
    /// The temperature this calendar is choosing days for.
    let reading: ReadingName?
    let choose: (ClosedRange<Date>) -> Void

    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: HistoryCalendarModel
    @State private var first: DateComponents?
    @State private var last: DateComponents?
    @State private var visibleMonth: DateComponents

    init(initialRange: ClosedRange<Date>, reading: ReadingName? = nil, choose: @escaping (ClosedRange<Date>) -> Void) {
        self.initialRange = initialRange
        self.reading = reading
        self.choose = choose
        _model = State(initialValue: HistoryCalendarModel(names: reading.map { [$0] } ?? []))
        let calendar = Calendar.current
        let lastMoment = max(initialRange.lowerBound, initialRange.upperBound.addingTimeInterval(-1))
        _first = State(initialValue: calendar.dateComponents([.year, .month, .day], from: initialRange.lowerBound))
        _last = State(initialValue: calendar.dateComponents([.year, .month, .day], from: lastMoment))
        _visibleMonth = State(initialValue: calendar.dateComponents([.year, .month], from: lastMoment))
    }

    private var dotCaption: String {
        if reading == .poolTemperature {
            return String(localized: "A dot marks a day the pool was running and its temperature was known. Tap the first day, then the last.")
        }
        if reading == .spaTemperature {
            return String(localized: "A dot marks a day the spa was running and its temperature was known. Tap the first day, then the last.")
        }
        return String(localized: "A dot marks a day with pool, spa or salt readings. Tap the first day, then the last.")
    }

    private var chosenRange: ClosedRange<Date>? {
        guard let first else {
            return nil
        }
        return model.range(from: first, through: last ?? first)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HistoryCalendar(model: model, first: $first, last: $last, visibleMonth: $visibleMonth)
                        .fixedSize(horizontal: false, vertical: true)

                    if let chosenRange {
                        // the range ends at the midnight after the last day, so name the last day itself
                        Text(chosenRange.lowerBound..<max(chosenRange.lowerBound, chosenRange.upperBound.addingTimeInterval(-1)),
                             format: .interval.month(.abbreviated).day().year())
                            .font(.headline)
                    }
                    Label(dotCaption, systemImage: "circle.fill")
                        .labelStyle(DotLabelStyle())
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let errorMessage = model.errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                .padding()
            }
            .navigationTitle("Choose Dates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Show") {
                        if let chosenRange {
                            choose(chosenRange)
                        }
                        dismiss()
                    }
                    .disabled(chosenRange == nil)
                }
            }
            .task(id: visibleMonth) {
                await model.load(around: visibleMonth, client: store.client)
            }
        }
        .presentationDetents([.large])
    }
}

/// The footnote's dot, small and in the calendar's color.
private struct DotLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon
                .font(.system(size: 6))
                .foregroundStyle(Color.teal)
            configuration.title
        }
    }
}

/// UIKit's calendar, which can mark individual days, inside SwiftUI.
private struct HistoryCalendar: UIViewRepresentable {
    let model: HistoryCalendarModel
    @Binding var first: DateComponents?
    @Binding var last: DateComponents?
    @Binding var visibleMonth: DateComponents

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UICalendarView {
        let view = UICalendarView()
        view.calendar = model.calendar
        view.delegate = context.coordinator
        let selection = UICalendarSelectionMultiDate(delegate: context.coordinator)
        view.selectionBehavior = selection
        context.coordinator.selection = selection
        view.availableDateRange = availableRange
        view.visibleDateComponents = visibleMonth
        view.tintColor = .systemTeal
        view.setContentCompressionResistancePriority(.required, for: .vertical)
        context.coordinator.showSelection()
        return view
    }

    func updateUIView(_ view: UICalendarView, context: Context) {
        context.coordinator.parent = self
        if view.calendar.timeZone != model.timeZone {
            view.calendar = model.calendar
        }
        view.availableDateRange = availableRange
        context.coordinator.showSelection()
        if context.coordinator.markedRevision != model.revision {
            context.coordinator.markedRevision = model.revision
            let days = daysAround(visibleMonth)
            // An animated reload applies a collection snapshot, and the calendar scrolls while
            // that snapshot is still applying, which asks for a second one. UIKit aborts on that.
            DispatchQueue.main.async {
                view.reloadDecorations(forDateComponents: days, animated: false)
            }
        }
    }

    private var availableRange: DateInterval {
        let start = model.earliest ?? Date.now.addingTimeInterval(-10 * 365 * 24 * 60 * 60)
        return DateInterval(start: start, end: max(start, Date.now))
    }

    /// Every day of the visible month and the ones either side, whose marks may have changed.
    private func daysAround(_ month: DateComponents) -> [DateComponents] {
        let calendar = model.calendar
        guard let year = month.year, let number = month.month,
              let middle = calendar.date(from: DateComponents(year: year, month: number, day: 1)),
              let start = calendar.date(byAdding: .month, value: -1, to: middle),
              let end = calendar.date(byAdding: .month, value: 2, to: middle) else {
            return []
        }
        return model.days(in: start...end)
    }

    final class Coordinator: NSObject, UICalendarViewDelegate, UICalendarSelectionMultiDateDelegate {
        var parent: HistoryCalendar
        var selection: UICalendarSelectionMultiDate?
        var markedRevision = -1

        init(_ parent: HistoryCalendar) {
            self.parent = parent
        }

        /// Selects every day from the first tapped through the last.
        func showSelection() {
            guard let selection else {
                return
            }
            var days: [DateComponents] = []
            if let first = parent.first {
                if let range = parent.model.range(from: first, through: parent.last ?? first) {
                    days = parent.model.days(in: range)
                }
            }
            let current = Set(selection.selectedDates.compactMap(HistoryCalendarModel.key))
            if current != Set(days.compactMap(HistoryCalendarModel.key)) {
                selection.setSelectedDates(days, animated: false)
            }
        }

        private func tapped(_ day: DateComponents) {
            let day = DateComponents(calendar: parent.model.calendar, year: day.year, month: day.month, day: day.day)
            if parent.first == nil || parent.last != nil {
                parent.first = day
                parent.last = nil
            } else {
                parent.last = day
            }
            showSelection()
        }

        func calendarView(_ calendarView: UICalendarView, decorationFor dateComponents: DateComponents) -> UICalendarView.Decoration? {
            parent.model.hasReadings(on: dateComponents) ? .default(color: .systemTeal, size: .small) : nil
        }

        func calendarView(_ calendarView: UICalendarView, didChangeVisibleDateComponentsFrom previousDateComponents: DateComponents) {
            let month = calendarView.visibleDateComponents
            parent.visibleMonth = DateComponents(year: month.year, month: month.month)
        }

        func multiDateSelection(_ selection: UICalendarSelectionMultiDate, didSelectDate dateComponents: DateComponents) {
            tapped(dateComponents)
        }

        // tapping a selected day starts a new range there rather than leaving a hole in this one
        func multiDateSelection(_ selection: UICalendarSelectionMultiDate, didDeselectDate dateComponents: DateComponents) {
            tapped(dateComponents)
        }
    }
}

#if DEBUG
#Preview {
    HistoryCalendarSheet(initialRange: Date.now.addingTimeInterval(-3 * 86400)...Date.now) { _ in }
        .environment(StatusStore.preview())
}
#endif
