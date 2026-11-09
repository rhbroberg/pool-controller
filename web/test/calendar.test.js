// The history calendar: days with readings in the server's time zone, the month grid, and the
// window a picked range covers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryCalendar, shiftMonth } from '../public/js/calendar.js';
import { startOfDay, midnightOf, dayKey, addDaysToKey, isValidTimeZone } from '../public/js/timezone.js';

const NEW_YORK = 'America/New_York';
const HOUR = 3600 * 1000;

const availability = { timeZone: NEW_YORK, earliest: '2026-10-02', days: [{ date: '2026-11-07', readings: 42 }, { date: '2026-10-15', readings: 3 }] };

const fakeClient = (answer = availability) => {
    const requests = [];
    return {
        requests,
        fetchAvailability: async (from, to) => {
            requests.push([from, to]);
            return answer;
        }
    };
};

describe('history calendar', () => {
    it('marks the days with readings, in the server’s time zone', async () => {
        const calendar = new HistoryCalendar(fakeClient());
        await calendar.load({ year: 2026, month: 11 }, Date.UTC(2026, 10, 20));
        assert.equal(calendar.timeZone, NEW_YORK);
        assert.equal(calendar.hasReadings('2026-11-07'), true);
        assert.equal(calendar.readingsOn('2026-10-15'), 3);
        assert.equal(calendar.hasReadings('2026-11-08'), false);
        assert.equal(calendar.earliest, '2026-10-02');
    });

    it('asks for a month and its neighbors only once', async () => {
        const client = fakeClient();
        const calendar = new HistoryCalendar(client);
        calendar.timeZone = NEW_YORK;
        const now = Date.UTC(2026, 10, 20);
        await calendar.load({ year: 2026, month: 10 }, now);
        await calendar.load({ year: 2026, month: 10 }, now);
        assert.equal(client.requests.length, 1);
        assert.deepEqual(client.requests[0], [midnightOf(2026, 9, 1, NEW_YORK), now], 'September through now');
        await calendar.load({ year: 2026, month: 6 }, now);
        assert.equal(client.requests.length, 2);
        assert.deepEqual(client.requests[1], [midnightOf(2026, 5, 1, NEW_YORK), midnightOf(2026, 8, 1, NEW_YORK)], 'May through July');
    });

    it('asks for only the spa temperature when the calendar is the spa’s', async () => {
        const names = [];
        const client = {
            fetchAvailability: async (from, to, requested) => {
                names.push(requested);
                return availability;
            }
        };
        const calendar = new HistoryCalendar(client, () => {}, ['spa temp']);
        calendar.timeZone = NEW_YORK;
        await calendar.load({ year: 2026, month: 10 }, Date.UTC(2026, 10, 20));
        assert.deepEqual(names, [['spa temp']]);
    });

    it('keeps the error, so paging back tries again', async () => {
        const calendar = new HistoryCalendar({ fetchAvailability: async () => { throw new Error('The pool server isn’t answering.'); } });
        await calendar.load({ year: 2026, month: 11 });
        assert.equal(calendar.errorMessage, 'The pool server isn’t answering.');
        assert.equal(calendar.isLoading, false);
    });

    it('lays out a month in weeks from Sunday, picking only days with history through today', async () => {
        const calendar = new HistoryCalendar(fakeClient());
        const now = Date.UTC(2026, 10, 20, 17);
        await calendar.load({ year: 2026, month: 11 }, now);
        const weeks = calendar.monthGrid({ year: 2026, month: 11 }, now);
        assert.equal(weeks[0][0].key, '2026-11-01', 'November 2026 starts on a Sunday');
        assert.ok(weeks.every((week) => week.length === 7));
        const days = weeks.flat().filter((day) => day.inMonth);
        assert.equal(days.length, 30);
        assert.equal(days.find((day) => day.key === '2026-11-20').selectable, true);
        assert.equal(days.find((day) => day.key === '2026-11-21').selectable, false, 'tomorrow');

        const october = calendar.monthGrid({ year: 2026, month: 10 }, now).flat().filter((day) => day.inMonth);
        assert.equal(october.find((day) => day.key === '2026-10-01').selectable, false, 'before the first readings');
        assert.equal(october.find((day) => day.key === '2026-10-02').selectable, true);
    });

    it('gives every month six weeks, so the page stays the same size as it pages', () => {
        const calendar = new HistoryCalendar(fakeClient());
        const now = Date.UTC(2026, 10, 20, 17);
        // February 2026 fits in four weeks, August 2026 needs all six
        [{ year: 2026, month: 2 }, { year: 2026, month: 8 }, { year: 2026, month: 11 }].forEach((visible) => {
            const weeks = calendar.monthGrid(visible, now);
            assert.equal(weeks.length, 6, `${visible.year}-${visible.month}`);
            assert.ok(weeks.every((week) => week.length === 7));
        });
        const february = calendar.monthGrid({ year: 2026, month: 2 }, now).flat();
        assert.equal(february.filter((day) => day.inMonth).length, 28);
        assert.equal(february.at(-1).key, '2026-03-14');
    });

    it('turns two picked days into the window from the first’s midnight to the end of the last', () => {
        const calendar = new HistoryCalendar(fakeClient());
        calendar.timeZone = NEW_YORK;
        const [from, to] = calendar.range('2026-11-09', '2026-11-07');
        assert.equal(new Date(from).toISOString(), '2026-11-07T05:00:00.000Z');
        assert.equal(new Date(to).toISOString(), '2026-11-10T05:00:00.000Z');
        assert.deepEqual(calendar.keysIn(from, to), { first: '2026-11-07', last: '2026-11-09' });
    });

    it('pages through months across years', () => {
        assert.deepEqual(shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
        assert.deepEqual(shiftMonth({ year: 2026, month: 12 }, 2), { year: 2027, month: 2 });
    });
});

describe('local days', () => {
    it('starts days at local midnight, 23 hours long when the clocks go forward', () => {
        const day = startOfDay(Date.UTC(2026, 2, 8, 15), NEW_YORK);
        assert.equal(new Date(day).toISOString(), '2026-03-08T05:00:00.000Z');
        assert.equal(midnightOf(2026, 3, 9, NEW_YORK) - day, 23 * HOUR);
        assert.equal(dayKey(day, NEW_YORK), '2026-03-08');
    });

    it('steps days by the calendar, across months and years', () => {
        assert.equal(addDaysToKey('2026-12-31', 1), '2027-01-01');
        assert.equal(addDaysToKey('2026-03-01', -1), '2026-02-28');
    });

    it('validates zone names', () => {
        assert.equal(isValidTimeZone('Europe/London'), true);
        assert.equal(isValidTimeZone('Mars/Olympus'), false);
    });
});
