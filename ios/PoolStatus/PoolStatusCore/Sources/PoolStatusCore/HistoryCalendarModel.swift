import Foundation
import Observation

/// The days with the named readings, for marking a calendar, fetched a few months at a time as
/// the calendar pages. With no names, days that have a pool or spa temperature or a salt reading
/// are marked. Days are the server's, in its time zone, so the calendar should use `calendar`
/// to line up with them.
@Observable
public final class HistoryCalendarModel {
    /// Empty asks for every water reading.
    public let names: [ReadingName]
    public private(set) var timeZone: TimeZone
    /// The first day with readings.
    public private(set) var earliest: Date?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    /// Counts merged responses, so the calendar redraws its marks.
    public private(set) var revision = 0

    /// Readings per day, keyed YYYY-MM-DD.
    private var readings: [String: Int] = [:]
    /// The months already asked for, keyed YYYY-MM.
    private var fetchedMonths: Set<String> = []

    public init(names: [ReadingName] = [], timeZone: TimeZone = .current) {
        self.names = names
        self.timeZone = timeZone
    }

    /// Gregorian, in the server's time zone.
    public var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    public func readings(on day: DateComponents) -> Int {
        Self.key(day).map { readings[$0] ?? 0 } ?? 0
    }

    public func hasReadings(on day: DateComponents) -> Bool {
        readings(on: day) > 0
    }

    /// Fetches the month holding `month`, and the ones either side, which a calendar page also
    /// shows a few days of, unless they've been fetched.
    public func load(around month: DateComponents, client: StatusClient) async {
        let calendar = calendar
        guard let year = month.year, let number = month.month,
              let middle = calendar.date(from: DateComponents(year: year, month: number, day: 1)),
              let first = calendar.date(byAdding: .month, value: -1, to: middle),
              let end = calendar.date(byAdding: .month, value: 2, to: middle) else {
            return
        }
        let months = (0..<3).compactMap { calendar.date(byAdding: .month, value: $0, to: first) }.map(monthKey)
        guard !months.allSatisfy(fetchedMonths.contains) else {
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let availability = try await client.fetchAvailability(from: first, to: min(end, .now), names: names)
            if let zone = TimeZone(identifier: availability.timeZone), zone != timeZone {
                // days counted in another zone don't line up with these
                timeZone = zone
                readings = [:]
                fetchedMonths = []
            }
            for day in availability.days {
                readings[day.date] = day.readings
            }
            fetchedMonths.formUnion(months)
            earliest = availability.earliest.flatMap(date(fromKey:))
            errorMessage = nil
            revision += 1
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// The time from the start of `first` to the end of `last`, in the server's time zone,
    /// whichever order they're given in.
    public func range(from first: DateComponents, through last: DateComponents) -> ClosedRange<Date>? {
        let calendar = calendar
        guard let a = calendar.date(from: Self.day(first)), let b = calendar.date(from: Self.day(last)) else {
            return nil
        }
        let start = min(a, b)
        guard let end = calendar.date(byAdding: .day, value: 1, to: max(a, b)) else {
            return nil
        }
        return start...end
    }

    /// The days from `range`'s start through its end, for showing a window as a selection. They
    /// carry their calendar and era, which a calendar view needs to match them to its days.
    public func days(in range: ClosedRange<Date>) -> [DateComponents] {
        let calendar = calendar
        var days: [DateComponents] = []
        var day = calendar.startOfDay(for: range.lowerBound)
        while day < range.upperBound, days.count < 3660 {
            days.append(calendar.dateComponents([.calendar, .era, .year, .month, .day], from: day))
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else {
                break
            }
            day = next
        }
        return days
    }

    public static func key(_ day: DateComponents) -> String? {
        guard let year = day.year, let month = day.month, let date = day.day else {
            return nil
        }
        return String(format: "%04d-%02d-%02d", year, month, date)
    }

    private static func day(_ components: DateComponents) -> DateComponents {
        DateComponents(year: components.year, month: components.month, day: components.day)
    }

    private func monthKey(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }

    private func date(fromKey key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else {
            return nil
        }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
