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
        // Keep the open month inside what UICalendarView will allow before earliest is known.
        let latest = Date.now
        let earliest = latest.addingTimeInterval(-10 * 365 * 24 * 60 * 60)
        let lastMoment = min(max(initialRange.lowerBound, initialRange.upperBound.addingTimeInterval(-1)), latest)
        let firstMoment = min(max(initialRange.lowerBound, earliest), lastMoment)
        _first = State(initialValue: calendar.dateComponents([.year, .month, .day], from: firstMoment))
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
        let range = availableRange
        view.availableDateRange = range
        // UICalendarView aborts if the visible month is outside the available range.
        let month = Self.clampedMonth(visibleMonth, to: range, calendar: model.calendar)
        view.visibleDateComponents = month
        if Self.monthIndex(month) != Self.monthIndex(visibleMonth) {
            DispatchQueue.main.async {
                self.visibleMonth = month
            }
        }
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
            // Earliest can move in after the first fetch and leave the open month out of range.
            let shown = view.visibleDateComponents
            let month = Self.clampedMonth(shown, to: range, calendar: model.calendar)
            if Self.monthIndex(month) != Self.monthIndex(shown) {
                view.visibleDateComponents = month
                visibleMonth = month
            }
        }
        context.coordinator.showSelection()
        if context.coordinator.markedRevision != model.revision {
            context.coordinator.markedRevision = model.revision
            let days = daysAround(visibleMonth)
            // An animated reload applies a collection snapshot, and the calendar scrolls while
            // that snapshot is still applying, which asks for a second one. UIKit aborts on that.
            // Hop to the next turn of the main actor so the current update finishes first.
            Task { @MainActor in
                view.reloadDecorations(forDateComponents: days, animated: false)
            }
        }
    }

    /// Half-open `[start, end)`. Start is the first of the earliest month so the calendar can
    /// lay out that whole month; a mid-month earliest left it without a lower bound and it aborted.
    private var availableRange: DateInterval {
        let calendar = model.calendar
        let today = calendar.startOfDay(for: .now)
        let end = calendar.date(byAdding: .day, value: 1, to: today) ?? today.addingTimeInterval(86400)
        let raw = model.earliest ?? today.addingTimeInterval(-10 * 365 * 24 * 60 * 60)
        let start = calendar.date(from: calendar.dateComponents([.year, .month], from: raw))
            ?? calendar.startOfDay(for: raw)
        return DateInterval(start: min(start, end.addingTimeInterval(-86400)), end: end)
    }

    /// A year/month that intersects `range`. UICalendarView crashes if the visible month is outside it.
    fileprivate static func clampedMonth(_ month: DateComponents, to range: DateInterval,
                                         calendar: Calendar) -> DateComponents {
        // range is half-open, so the last included instant is just before end
        let last = range.end.addingTimeInterval(-1)
        let startMonth = calendar.dateComponents([.year, .month], from: range.start)
        let endMonth = calendar.dateComponents([.year, .month], from: last)
        guard let year = month.year, let number = month.month,
              let date = calendar.date(from: DateComponents(year: year, month: number, day: 1)),
              let firstAllowed = calendar.date(from: DateComponents(year: startMonth.year, month: startMonth.month, day: 1)),
              let lastAllowed = calendar.date(from: DateComponents(year: endMonth.year, month: endMonth.month, day: 1)) else {
            return endMonth
        }
        if date < firstAllowed {
            return startMonth
        }
        if date > lastAllowed {
            return endMonth
        }
        return DateComponents(year: year, month: number)
    }

    fileprivate static func monthIndex(_ components: DateComponents) -> Int? {
        guard let year = components.year, let month = components.month else {
            return nil
        }
        return year * 12 + (month - 1)
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
                // Same deferral as reloadDecorations: wait until UIKit finishes the tap's snapshot.
                Task { @MainActor [weak self] in
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
                if HistoryCalendar.monthIndex(calendarView.visibleDateComponents) != HistoryCalendar.monthIndex(visible) {
                    correctingMonth = true
                    show(visible, on: calendarView)
                    correctingMonth = false
                }
            }
            applyingSelection = false
        }

        /// Sets the visible month only when it still falls inside the available range.
        private func show(_ month: DateComponents, on calendarView: UICalendarView) {
            let clamped = HistoryCalendar.clampedMonth(month, to: calendarView.availableDateRange,
                                                       calendar: calendarView.calendar)
            guard HistoryCalendar.monthIndex(clamped) != HistoryCalendar.monthIndex(calendarView.visibleDateComponents) else {
                return
            }
            calendarView.setVisibleDateComponents(clamped, animated: false)
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
                let clamped = HistoryCalendar.clampedMonth(landed, to: calendarView.availableDateRange,
                                                           calendar: calendarView.calendar)
                correctingMonth = true
                calendarView.setVisibleDateComponents(clamped, animated: false)
                correctingMonth = false
                parent.visibleMonth = clamped
                return
            }
            parent.visibleMonth = DateComponents(year: shown.year, month: shown.month)
        }

        /// The month one step forward of `previous`, when `shown` is two steps forward.
        private static func oneMonthForward(from previous: DateComponents, shown: DateComponents) -> DateComponents? {
            guard let from = HistoryCalendar.monthIndex(previous), let to = HistoryCalendar.monthIndex(shown),
                  to - from == 2 else {
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
