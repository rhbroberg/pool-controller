// The days with water temperature or salt readings, for marking the history calendar, fetched a
// few months at a time as the calendar pages. Days are the server's, in its time zone, so the
// month grid is laid out in that zone too.

import { isAbort } from './api.js';
import { localTimeZone, isValidTimeZone, keyOf, partsOf, midnightOf, midnightOfKey, addDaysToKey, dayKey } from './timezone.js';

const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

/** the year and month `offset` months from year-month */
export const shiftMonth = ({ year, month }, offset) => {
    const index = year * 12 + (month - 1) + offset;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

export class HistoryCalendar {
    constructor(client, changed = () => {}) {
        this.client = client;
        this.changed = changed;
        this.timeZone = localTimeZone();
        // the first day with readings, YYYY-MM-DD
        this.earliest = null;
        this.isLoading = false;
        this.errorMessage = null;
        this.readings = new Map();
        this.fetchedMonths = new Set();
    }

    readingsOn(key) {
        return this.readings.get(key) || 0;
    }

    hasReadings(key) {
        return this.readingsOn(key) > 0;
    }

    /**
     * fetches the month and the ones either side, which a month page also shows a few days of,
     * unless they've been fetched
     **/
    async load({ year, month }, now = Date.now()) {
        const first = shiftMonth({ year, month }, -1);
        const months = [first, { year, month }, shiftMonth({ year, month }, 1)];
        if (months.every((m) => this.fetchedMonths.has(monthKey(m.year, m.month)))) {
            return;
        }
        const after = shiftMonth({ year, month }, 2);
        const from = midnightOf(first.year, first.month, 1, this.timeZone);
        const to = Math.min(midnightOf(after.year, after.month, 1, this.timeZone), now);
        this.isLoading = true;
        this.changed();
        try {
            const availability = await this.client.fetchAvailability(from, Math.max(to, from + 1));
            if (isValidTimeZone(availability.timeZone) && availability.timeZone !== this.timeZone) {
                // days counted in another zone don't line up with these
                this.timeZone = availability.timeZone;
                this.readings.clear();
                this.fetchedMonths.clear();
            }
            (availability.days || []).forEach((day) => this.readings.set(day.date, day.readings));
            months.forEach((m) => this.fetchedMonths.add(monthKey(m.year, m.month)));
            this.earliest = availability.earliest || null;
            this.errorMessage = null;
        } catch (error) {
            if (!isAbort(error)) {
                this.errorMessage = error.message;
            }
        } finally {
            this.isLoading = false;
            this.changed();
        }
    }

    /** today's YYYY-MM-DD in the server's zone */
    today(now = Date.now()) {
        return dayKey(now, this.timeZone);
    }

    /**
     * the weeks of a month page, Sunday first: each day has its key, its number, whether it's in
     * the month, and whether it can be picked (from the first day with readings through today).
     * Every month gets six weeks, the most one spans, so paging doesn't move the paging buttons.
     **/
    monthGrid({ year, month }, now = Date.now()) {
        const firstKey = keyOf(year, month, 1);
        const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        const today = this.today(now);
        let key = addDaysToKey(firstKey, -weekday);
        const weeks = [];
        while (weeks.length < 6) {
            const week = [];
            for (let i = 0; i < 7; i++) {
                const parts = partsOf(key);
                week.push({
                    key,
                    day: parts.day,
                    inMonth: parts.month === month,
                    selectable: key <= today && (!this.earliest || key >= this.earliest)
                });
                key = addDaysToKey(key, 1);
            }
            weeks.push(week);
        }
        return weeks;
    }

    /** the time from the start of one day to the end of the other, in whichever order they're given */
    range(firstKey, lastKey) {
        const [start, end] = [firstKey, lastKey].sort();
        return [midnightOfKey(start, this.timeZone), midnightOfKey(addDaysToKey(end, 1), this.timeZone)];
    }

    /** the day keys from..to covers, for showing a window as a selection */
    keysIn(from, to) {
        return { first: dayKey(from, this.timeZone), last: dayKey(Math.max(from, to - 1), this.timeZone) };
    }
}
