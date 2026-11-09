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
        context.coordinator.calendarView = view
        context.coordinator.showSelection(immediate: true)
        return view
    }

    func updateUIView(_ view: UICalendarView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.calendarView = view
        if view.calendar.timeZone != model.timeZone {
            view.calendar = model.calendar
        }
        // The end of the range is "now", so it changes on every refresh. Assigning it again
        // while the calendar is paging makes the forward chevron land a month too far.
        let range = availableRange
        if abs(view.availableDateRange.start.timeIntervalSince(range.start)) > 1
            || !model.calendar.isDate(view.availableDateRange.end, inSameDayAs: range.end) {
            view.availableDateRange = range
        }
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
        weak var calendarView: UICalendarView?
        var markedRevision = -1
        /// Set while the selection is being replaced, so those callbacks are not new taps.
        private var applyingSelection = false
        private var selectionGeneration = 0
        /// Set while a wrong two-month jump is being put back, so that change is kept.
        private var correctingMonth = false

        init(_ parent: HistoryCalendar) {
            self.parent = parent
        }

        /// The days from the first tap through the last, in the calendar's own components.
        private func daysToSelect() -> [DateComponents] {
            guard let first = parent.first, let range = parent.model.range(from: first, through: parent.last ?? first) else {
                return []
            }
            return parent.model.days(in: range)
        }

        /// Selects every day from the first tapped through the last.
        ///
        /// The calendar is still applying the tap's own snapshot when this runs, and a selection
        /// applied then never reaches the month on screen. It shows up only after that month is
        /// built again, which is what scrolling away and back does.
        func showSelection(immediate: Bool = false) {
            guard let selection, !applyingSelection else {
                return
            }
            let days = daysToSelect()
            let wanted = Set(days.compactMap(HistoryCalendarModel.key))
            let current = Set(selection.selectedDates.compactMap(HistoryCalendarModel.key))
            guard current != wanted else {
                return
            }
            selectionGeneration &+= 1
            let generation = selectionGeneration
            if immediate {
                applyQueuedSelection(generation)
            } else {
                DispatchQueue.main.async { [weak self] in
                    self?.applyQueuedSelection(generation)
                }
            }
        }

        /// Replaces the selection, then makes the month on screen draw it.
        private func applyQueuedSelection(_ generation: Int) {
            guard selectionGeneration == generation, let selection else {
                return
            }
            let days = daysToSelect()
            applyingSelection = true
            selection.setSelectedDates(days, animated: false)
            if let calendarView {
                let visible = calendarView.visibleDateComponents
                // Putting the behavior back makes the visible month read the selection. Setting
                // the dates alone leaves the month that is already on screen unchanged.
                calendarView.selectionBehavior = selection
                if Self.monthIndex(calendarView.visibleDateComponents) != Self.monthIndex(visible) {
                    correctingMonth = true
                    calendarView.setVisibleDateComponents(DateComponents(year: visible.year, month: visible.month), animated: false)
                    correctingMonth = false
                }
            }
            applyingSelection = false
        }

        private func tapped(_ day: DateComponents) {
            guard !applyingSelection else {
                return
            }
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
            let shown = calendarView.visibleDateComponents
            // A forward chevron moves one month. With a range selected, the one that returns to
            // the month holding that range is reported as two months, so the page in between is skipped.
            if !correctingMonth, let landed = Self.oneMonthForward(from: previousDateComponents, shown: shown) {
                correctingMonth = true
                calendarView.setVisibleDateComponents(landed, animated: false)
                correctingMonth = false
                parent.visibleMonth = landed
                return
            }
            parent.visibleMonth = DateComponents(year: shown.year, month: shown.month)
        }

        private static func monthIndex(_ components: DateComponents) -> Int? {
            guard let year = components.year, let month = components.month else {
                return nil
            }
            return year * 12 + (month - 1)
        }

        /// The month one step forward of `previous`, when `shown` is two steps forward.
        private static func oneMonthForward(from previous: DateComponents, shown: DateComponents) -> DateComponents? {
            guard let from = monthIndex(previous), let to = monthIndex(shown), to - from == 2 else {
                return nil
            }
            let intended = from + 1
            return DateComponents(year: intended / 12, month: intended % 12 + 1)
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
