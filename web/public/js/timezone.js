// Calendar days in an IANA time zone, using only Intl, so the history calendar lines up with
// the server's days, whatever zone the browser is in. Times are milliseconds.

export const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map();

const formatter = (timeZone) => {
    if (!formatters.has(timeZone)) {
        formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }));
    }
    return formatters.get(timeZone);
};

export const isValidTimeZone = (timeZone) => {
    if (typeof timeZone !== 'string' || !timeZone) {
        return false;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
};

/** the browser's own zone */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** the wall clock in timeZone at ms */
export const wallClock = (ms, timeZone) => {
    const parts = {};
    for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) {
        parts[type] = value;
    }
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
};

// how far timeZone's wall clock is ahead of UTC at ms
const offsetAt = (ms, timeZone) => {
    const clock = wallClock(ms, timeZone);
    return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(ms / 1000) * 1000;
};

/** the instant the wall clock in timeZone reads midnight starting year-month-day */
export const midnightOf = (year, month, day, timeZone) => {
    const asUtc = Date.UTC(year, month - 1, day);
    // the offset at midnight can differ from the one at the first guess across a DST change
    const guess = asUtc - offsetAt(asUtc, timeZone);
    return asUtc - offsetAt(guess, timeZone);
};

export const startOfDay = (ms, timeZone) => {
    const clock = wallClock(ms, timeZone);
    return midnightOf(clock.year, clock.month, clock.day, timeZone);
};

/** YYYY-MM-DD from its parts */
export const keyOf = (year, month, day) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** YYYY-MM-DD of the local day holding ms */
export const dayKey = (ms, timeZone) => {
    const clock = wallClock(ms, timeZone);
    return keyOf(clock.year, clock.month, clock.day);
};

/** { year, month, day } from YYYY-MM-DD */
export const partsOf = (key) => {
    const [year, month, day] = key.split('-').map(Number);
    return { year, month, day };
};

/** the midnight starting the day named by key */
export const midnightOfKey = (key, timeZone) => {
    const { year, month, day } = partsOf(key);
    return midnightOf(year, month, day, timeZone);
};

/** the key of the day `days` after key, by the calendar rather than by 24-hour steps */
export const addDaysToKey = (key, days) => {
    const { year, month, day } = partsOf(key);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};
